import importlib.util
from pathlib import Path
import sys


MODULE_PATH = (
    Path(__file__).resolve().parents[2]
    / "deploy"
    / "openclaw"
    / "games"
    / "ai-turtle-soup"
    / "chat_games.py"
)
SPEC = importlib.util.spec_from_file_location("qqbot_chat_games", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
CHAT_GAMES = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CHAT_GAMES
SPEC.loader.exec_module(CHAT_GAMES)


class FakeCatalog:
    words = {
        "一心一意",
        "意气风发",
        "发扬光大",
        "大快人心",
        "心想事成",
        "成家立业",
        "业精于勤",
        "勤能补拙",
    }
    successors = {
        "一心一意": ["意气风发"],
        "意气风发": ["发扬光大"],
        "发扬光大": ["大快人心"],
        "大快人心": ["心想事成"],
        "心想事成": ["成家立业"],
        "成家立业": ["业精于勤"],
        "业精于勤": ["勤能补拙"],
        "勤能补拙": [],
    }

    def random_word(self, *, require_follow, heteronym, rng):
        return "一心一意" if require_follow else "一心一意"

    def is_idiom(self, word):
        return word in self.words

    def can_follow(self, before, after, *, heteronym):
        return after in self.successors.get(before, [])

    def next_words(self, word, *, heteronym, limit=3):
        return self.successors.get(word, [])[:limit]

    def info(self, word):
        return {"explanation": "专心一意，没有杂念。"} if word == "一心一意" else {}


def manager(**kwargs):
    return CHAT_GAMES.ChatGameManager(FakeCatalog(), **kwargs)


def test_wordle_scoring_is_duplicate_aware():
    assert CHAT_GAMES.score_wordle_guess("一心一意", "一一心心") == [
        "correct",
        "present",
        "present",
        "absent",
    ]


def test_idiom_chain_validates_links_repeats_and_scores_players():
    games = manager(chain_max_rounds=10)
    started = games.start("group:one", CHAT_GAMES.IDIOM_CHAIN, player_id="u1", player_name="甲")
    assert started["current_word"] == "一心一意"
    assert started["leaderboard"] == [{"name": "甲", "score": 0, "moves": 0}]

    accepted = games.submit(
        "group:one", "意气风发", player_id="u1", player_name="甲"
    )
    assert accepted is not None
    assert accepted["accepted"] is True
    assert accepted["target_char"] == "发"
    assert accepted["leaderboard"][0]["score"] == 1

    repeated = games.submit(
        "group:one", "意气风发", player_id="u2", player_name="乙"
    )
    assert repeated is not None
    assert repeated["accepted"] is False
    assert "不能重复" in repeated["message"]

    wrong_link = games.submit(
        "group:one", "勤能补拙", player_id="u2", player_name="乙"
    )
    assert wrong_link is not None
    assert wrong_link["accepted"] is False
    assert "接不上" in wrong_link["message"]

    hint = games.hint("group:one")
    assert hint is not None
    assert hint["hint"] == ["发扬光大"]
    assert games.status("group:one")["chain_length"] == 2

    ended = games.end("group:one")
    assert ended is not None
    assert ended["active"] is False
    assert games.status("group:one") is None


def test_wordle_is_shared_has_free_hints_and_ends_with_answer():
    games = manager(wordle_max_guesses=6)
    started = games.start("group:two", CHAT_GAMES.IDIOM_WORDLE, player_id="u1", player_name="甲")
    assert started["game_type"] == CHAT_GAMES.IDIOM_WORDLE
    assert "answer" not in started

    hint = games.hint("group:two")
    assert hint is not None
    assert hint["hint"] == {"position": 1, "char": "一"}
    assert "answer" not in hint

    invalid = games.submit("group:two", "三个字", player_id="u1", player_name="甲")
    assert invalid is not None
    assert invalid["accepted"] is False
    assert invalid["attempts"] == 0

    guess = games.submit("group:two", "一心一心", player_id="u1", player_name="甲")
    assert guess is not None
    assert guess["accepted"] is True
    assert guess["attempts"] == 1
    assert guess["marks"] == ["correct", "correct", "correct", "absent"]

    duplicate = games.submit("group:two", "一心一心", player_id="u2", player_name="乙")
    assert duplicate is not None
    assert duplicate["accepted"] is False
    assert duplicate["attempts"] == 1

    won = games.submit("group:two", "一心一意", player_id="u2", player_name="乙")
    assert won is not None
    assert won["ended"] is True
    assert won["result"] == "win"
    assert won["answer"] == "一心一意"
    assert won["leaderboard"][0]["name"] == "乙"
    assert games.status("group:two") is None


def test_each_session_has_one_game_and_restart_message_does_not_replace_it():
    games = manager()
    first = games.start("group:three", CHAT_GAMES.IDIOM_CHAIN, player_id="u1", player_name="甲")
    assert first["ok"] is True
    second = games.start("group:three", CHAT_GAMES.IDIOM_WORDLE, player_id="u2", player_name="乙")
    assert second["ok"] is False
    assert second["active"] is True
    assert games.status("group:three")["game_type"] == CHAT_GAMES.IDIOM_CHAIN
