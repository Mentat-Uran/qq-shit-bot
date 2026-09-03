import importlib.util
import json
import sys
from pathlib import Path


GAME_DIR = Path(__file__).parents[2] / "deploy" / "openclaw" / "games" / "ai-turtle-soup"
SELECTION_PATH = GAME_DIR / "selection.py"
SPEC = importlib.util.spec_from_file_location("turtle_soup_selection_test", SELECTION_PATH)
assert SPEC is not None and SPEC.loader is not None
SELECTION = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SELECTION
SPEC.loader.exec_module(SELECTION)


class FirstChoice:
    def choice(self, values):
        return values[0]


def puzzle(number, *, title=None, surface=None):
    title = title or f"题目{number}"
    surface = surface or f"表面{number}，为什么？"
    return {
        "id": f"test_{number}",
        "title": title,
        "puzzle_setting": surface,
        "solution": f"答案{number}",
        "supplementary_info": [f"线索{number}"],
        "tags": ["测试"],
    }


def select(store, session_id, candidates, catalog):
    initialized = []
    result = store.choose(
        session_id,
        candidates,
        catalog,
        initialize=initialized.append,
        themed=candidates != catalog,
    )
    assert result is not None
    assert initialized == [result.puzzle]
    return result


def test_each_group_gets_an_independent_no_repeat_rotation(tmp_path):
    catalog = [puzzle(1), puzzle(2), puzzle(3)]
    store = SELECTION.PuzzleSelectionStore(
        tmp_path / "selection.json",
        random_source=FirstChoice(),
    )

    group_one = [select(store, "account:group:one", catalog, catalog).puzzle["id"] for _ in range(3)]
    group_two_first = select(store, "account:group:two", catalog, catalog).puzzle["id"]

    assert group_one == ["test_1", "test_2", "test_3"]
    assert group_two_first == "test_1"


def test_theme_exhaustion_uses_an_unseen_full_catalog_item(tmp_path):
    catalog = [puzzle(1), puzzle(2), puzzle(3)]
    store = SELECTION.PuzzleSelectionStore(
        tmp_path / "selection.json",
        random_source=FirstChoice(),
    )

    first = select(store, "account:group:one", [catalog[0]], catalog)
    second = select(store, "account:group:one", [catalog[0]], catalog)

    assert first.puzzle["id"] == "test_1"
    assert second.puzzle["id"] == "test_2"
    assert "为保证不重复" in second.notice


def test_rotation_survives_store_reconstruction_and_hides_scope_value(tmp_path):
    state_path = tmp_path / "selection.json"
    catalog = [puzzle(1), puzzle(2)]
    session_id = "account:group:private-value"

    first_store = SELECTION.PuzzleSelectionStore(
        state_path,
        random_source=FirstChoice(),
    )
    assert select(first_store, session_id, catalog, catalog).puzzle["id"] == "test_1"

    second_store = SELECTION.PuzzleSelectionStore(
        state_path,
        random_source=FirstChoice(),
    )
    assert select(second_store, session_id, catalog, catalog).puzzle["id"] == "test_2"

    state_text = state_path.read_text(encoding="utf-8")
    assert session_id not in state_text
    state = json.loads(state_text)
    assert state["version"] == 2
    assert len(state["groups"]) == 1


def test_v1_global_state_is_migrated_as_a_conservative_initial_cooldown(tmp_path):
    catalog = [puzzle(1), puzzle(2)]
    state_path = tmp_path / "selection.json"
    state_path.write_text(
        json.dumps(
            {
                "version": 1,
                "catalog": [SELECTION.puzzle_key(item) for item in catalog],
                "used": [SELECTION.puzzle_key(catalog[0])],
                "last": SELECTION.puzzle_key(catalog[0]),
            }
        ),
        encoding="utf-8",
    )

    store = SELECTION.PuzzleSelectionStore(
        state_path,
        random_source=FirstChoice(),
    )
    result = select(store, "account:group:one", catalog, catalog)

    assert result.puzzle["id"] == "test_2"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["version"] == 2
    assert len(state["groups"]) == 1


def test_surface_duplicates_are_removed_before_rotation(tmp_path):
    first = puzzle(1, surface="同一个汤面？")
    duplicate_surface = puzzle(2, surface="同一个汤面！")
    other = puzzle(3)

    unique = SELECTION.unique_puzzles([first, duplicate_surface, other])
    assert [item["id"] for item in unique] == ["test_1", "test_3"]


def test_natural_theme_prompt_matches_category_aliases_and_scene_intersections():
    catalog = [
        puzzle(1),
        {
            **puzzle(2),
            "title": "医院里的回声",
            "tags": ["悬疑", "惊悚", "恐怖", "医院", "声音"],
        },
        {
            **puzzle(3),
            "title": "废弃旅馆",
            "tags": ["悬疑", "惊悚", "恐怖", "旅馆", "密室"],
        },
    ]

    horror = SELECTION.filter_puzzles_by_theme(
        catalog, "给我一题悬疑、惊悚、恐怖的海龟汤"
    )
    hospital_horror = SELECTION.filter_puzzles_by_theme(catalog, "灵异医院")
    random_choice = SELECTION.filter_puzzles_by_theme(catalog, "随机")

    assert [item["id"] for item in horror] == ["test_2", "test_3"]
    assert [item["id"] for item in hospital_horror] == ["test_2"]
    assert [item["id"] for item in random_choice] == ["test_1", "test_2", "test_3"]


def test_theme_prompt_can_match_an_internal_catalog_title_without_exposing_it():
    catalog = [puzzle(1, title="旧电梯"), puzzle(2, title="纸箱")]

    matched = SELECTION.filter_puzzles_by_theme(catalog, "旧电梯")

    assert [item["id"] for item in matched] == ["test_1"]


def test_failed_initializer_does_not_consume_a_puzzle(tmp_path):
    catalog = [puzzle(1), puzzle(2)]
    store = SELECTION.PuzzleSelectionStore(
        tmp_path / "selection.json",
        random_source=FirstChoice(),
    )

    def fail(_):
        raise RuntimeError("initializer failed")

    try:
        store.choose("account:group:one", catalog, catalog, initialize=fail)
    except RuntimeError:
        pass
    else:
        raise AssertionError("initializer failure should propagate")

    assert select(store, "account:group:one", catalog, catalog).puzzle["id"] == "test_1"
