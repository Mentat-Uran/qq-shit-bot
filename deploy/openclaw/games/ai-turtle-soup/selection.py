#!/usr/bin/env python3
"""Persistent, per-conversation rotation for the local turtle-soup catalog.

The game service receives a stable conversation key from the QQ adapter.  This
module hashes that key before it is written to disk, then keeps an independent
rotation for every group/private conversation.  Puzzle text and answers never
enter the selection state file.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable


LOGGER = logging.getLogger("qqbot-turtle-soup.selection")
STATE_VERSION = 2
_HEX_KEY = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class SelectionResult:
    """The selected puzzle and an optional user-facing selection notice."""

    puzzle: dict[str, Any]
    notice: str = ""


def puzzle_key(puzzle: dict[str, Any]) -> str:
    """Return a stable opaque key for one puzzle record.

    Keep the historical v1 identity fields so an existing state file can be
    migrated without making the same unchanged record look new.  Surface-level
    duplicate records are removed separately by :func:`unique_puzzles`.
    """

    identity = {
        "id": str(puzzle.get("id", "")),
        "title": str(puzzle.get("title", "")),
        "puzzle_setting": str(puzzle.get("puzzle_setting", "")),
        "solution": str(puzzle.get("solution", "")),
    }
    encoded = json.dumps(
        identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _surface_identity(puzzle: dict[str, Any]) -> str:
    """Normalize the visible surface used for duplicate detection."""

    surface = re.sub(r"\s+", "", str(puzzle.get("puzzle_setting", ""))).strip()
    surface = surface.rstrip("。！？!? ")
    if surface:
        return "surface:" + surface
    return "fallback:" + puzzle_key(puzzle)


def unique_puzzles(puzzles: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the first record for every visible puzzle surface."""

    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for puzzle in puzzles:
        if not isinstance(puzzle, dict):
            continue
        identity = _surface_identity(puzzle)
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(puzzle)
    return unique


# Theme prompts arrive from a short QQ command, not from a structured form.
# Keep the aliases deliberately small and deterministic: they are used only
# to choose from the local catalog and never become executable instructions.
_THEME_ALIASES: dict[str, tuple[str, ...]] = {
    "悬疑": ("悬疑", "悬案", "谜案", "推理", "侦探", "mystery", "suspense"),
    "惊悚": ("惊悚", "惊恐", "紧张", "压迫感", "追逐", "thriller"),
    "恐怖": (
        "恐怖",
        "灵异",
        "鬼",
        "鬼故事",
        "亡灵",
        "怪谈",
        "阴森",
        "诡异",
        "惊吓",
        "horror",
        "scary",
        "supernatural",
    ),
    "密室": ("密室", "封闭空间", "密闭空间"),
    "校园": ("校园", "学校", "宿舍"),
    "医院": ("医院", "病房", "诊所"),
    "旅馆": ("旅馆", "酒店", "民宿"),
    "监控": ("监控", "摄像头", "录像"),
    "电话": ("电话", "来电", "语音"),
    "镜子": ("镜子", "镜中"),
    "娃娃": ("娃娃", "玩偶", "木偶"),
    "民俗": ("民俗", "传说", "村落", "山村"),
    "失踪": ("失踪", "消失", "离奇失联"),
}
_THEME_RANDOM_PHRASES = frozenset({"随机", "随机题", "随机一题", "日常物品"})


def _compact_theme(value: Any) -> str:
    return re.sub(
        r"[\s，。！？、；：,:;!?（）()【】\[\]{}“”\"'‘’`]+",
        "",
        str(value or "").lower(),
    )


def normalize_theme_prompt(value: Any) -> str:
    """Normalize a user theme prompt without treating it as an instruction.

    The returned value is still suitable as a short AI-authoring preference,
    while the selector separately extracts recognized category/scene terms.
    """

    clean = re.sub(r"[\x00-\x1f\x7f]", " ", str(value or "")).strip()
    clean = re.sub(r"\s+", " ", clean)
    clean = re.sub(
        r"^(?:/?开始海龟汤)\s*(?:[:：,，]\s*)?",
        "",
        clean,
        flags=re.IGNORECASE,
    )
    return "" if _compact_theme(clean) in {
        _compact_theme(item) for item in _THEME_RANDOM_PHRASES
    } else clean[:160]


def _metadata_tokens(puzzle: dict[str, Any]) -> list[str]:
    values = [puzzle.get("id", ""), puzzle.get("title", "")]
    tags = puzzle.get("tags", [])
    if isinstance(tags, (list, tuple, set)):
        values.extend(tags)
    tokens: list[str] = []
    for value in values:
        token = _compact_theme(value)
        if len(token) >= 2:
            tokens.append(token)
    return tokens


def theme_terms(
    prompt: Any, catalog: Iterable[dict[str, Any]] = ()
) -> list[str]:
    """Extract canonical terms from a natural-language theme prompt.

    Catalog tags and titles are included so a prompt such as ``医院恐怖``
    becomes an intersection instead of an opaque whole-string lookup.  The
    result contains no user identity or puzzle text beyond internal metadata.
    """

    clean = normalize_theme_prompt(prompt)
    compact = _compact_theme(clean)
    if not compact:
        return []

    terms: list[str] = []
    for canonical, aliases in _THEME_ALIASES.items():
        if any(_compact_theme(alias) in compact for alias in aliases):
            terms.append(canonical)

    for puzzle in catalog:
        if not isinstance(puzzle, dict):
            continue
        for token in _metadata_tokens(puzzle):
            if token in compact and token not in terms:
                terms.append(token)

    # If the prompt has no known term, preserve the compact phrase for the
    # exact fallback below.  This keeps an explicit catalog id/title usable
    # without making arbitrary prose match every puzzle.
    return list(dict.fromkeys(terms)) or [compact]


def puzzle_matches_theme(
    puzzle: dict[str, Any],
    prompt: Any,
    *,
    catalog: Iterable[dict[str, Any]] = (),
) -> bool:
    """Return whether one puzzle satisfies all recognized prompt terms."""

    clean = normalize_theme_prompt(prompt)
    if not clean:
        return True
    terms = theme_terms(clean, catalog)
    metadata = _metadata_tokens(puzzle)
    metadata_text = " ".join(metadata)
    return all(term in metadata_text for term in terms)


def filter_puzzles_by_theme(
    puzzles: Iterable[dict[str, Any]], prompt: Any
) -> list[dict[str, Any]]:
    """Filter a catalog by a natural-language theme prompt."""

    values = unique_puzzles(puzzles)
    clean = normalize_theme_prompt(prompt)
    if not clean:
        return values
    return [
        puzzle
        for puzzle in values
        if puzzle_matches_theme(puzzle, clean, catalog=values)
    ]


def selection_scope_key(session_id: str) -> str:
    """Hash a conversation key before using it as a persisted state key."""

    value = str(session_id or "")
    return hashlib.sha256(
        b"qqbot-turtle-soup-selection-v2\0" + value.encode("utf-8")
    ).hexdigest()


def _valid_key(value: Any) -> bool:
    return isinstance(value, str) and bool(_HEX_KEY.fullmatch(value))


def _key_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(item for item in value if _valid_key(item)))


def _empty_group() -> dict[str, Any]:
    return {"used": [], "last": "", "updated_at": 0}


class PuzzleSelectionStore:
    """Choose local puzzles without repeating within one conversation cycle."""

    def __init__(
        self,
        state_path: str | os.PathLike[str] | None,
        *,
        max_groups: int = 2048,
        random_source: Any | None = None,
    ) -> None:
        self.state_path = Path(state_path) if state_path else None
        self.max_groups = max(1, int(max_groups))
        self.random = random_source or random.SystemRandom()
        self._lock = threading.Lock()
        self._state: dict[str, Any] | None = None

    @staticmethod
    def _empty_state() -> dict[str, Any]:
        return {"version": STATE_VERSION, "catalog": [], "groups": {}}

    @staticmethod
    def _normalize_group(value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            return _empty_group()
        last = value.get("last") if _valid_key(value.get("last")) else ""
        try:
            updated_at = max(0, int(value.get("updated_at", 0)))
        except (TypeError, ValueError):
            updated_at = 0
        return {
            "used": _key_list(value.get("used")),
            "last": last,
            "updated_at": updated_at,
        }

    def _migrate_or_empty(self, raw: Any) -> dict[str, Any]:
        state = self._empty_state()
        if not isinstance(raw, dict):
            return state

        if raw.get("version") == STATE_VERSION:
            catalog = _key_list(raw.get("catalog"))
            groups: dict[str, dict[str, Any]] = {}
            raw_groups = raw.get("groups")
            if isinstance(raw_groups, dict):
                for scope, value in raw_groups.items():
                    if _valid_key(scope):
                        groups[scope] = self._normalize_group(value)
            state["catalog"] = catalog
            state["groups"] = groups
            return state

        # v1 stored one global used/last rotation.  There was no group key to
        # recover, so retain it as a conservative initial cooldown for each
        # newly encountered group.  This avoids throwing away a live rotation
        # during the first rollout of the per-group schema.
        if raw.get("version") == 1:
            catalog = _key_list(raw.get("catalog"))
            legacy_used = _key_list(raw.get("used"))
            legacy_last = raw.get("last") if _valid_key(raw.get("last")) else ""
            state["catalog"] = catalog
            if legacy_used or legacy_last:
                state["legacy"] = {"used": legacy_used, "last": legacy_last}
                LOGGER.info(
                    "migrating legacy global puzzle rotation to per-group state"
                )
        return state

    def _load(self) -> dict[str, Any]:
        if self._state is not None:
            return self._state

        state = self._empty_state()
        if self.state_path is not None:
            try:
                raw = json.loads(self.state_path.read_text(encoding="utf-8"))
                state = self._migrate_or_empty(raw)
            except FileNotFoundError:
                pass
            except (OSError, TypeError, ValueError) as error:
                LOGGER.warning(
                    "puzzle selection state unavailable (%s); starting a fresh rotation",
                    type(error).__name__,
                )
        self._state = state
        return state

    def _persist(self, state: dict[str, Any]) -> None:
        if self.state_path is None:
            return

        temporary_path = self.state_path.with_name(
            f".{self.state_path.name}.{os.getpid()}.tmp"
        )
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path.write_text(
                json.dumps(state, ensure_ascii=False, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            os.chmod(temporary_path, 0o600)
            os.replace(temporary_path, self.state_path)
        except OSError as error:
            LOGGER.warning(
                "puzzle selection state could not be persisted (%s); rotation remains in memory",
                type(error).__name__,
            )
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass

    @staticmethod
    def _sync_catalog(state: dict[str, Any], catalog: list[dict[str, Any]]) -> list[str]:
        catalog_keys = [puzzle_key(puzzle) for puzzle in catalog]
        if state.get("catalog") != catalog_keys:
            state["catalog"] = catalog_keys
            allowed = set(catalog_keys)
            for group in state.get("groups", {}).values():
                group["used"] = [key for key in group.get("used", []) if key in allowed]
                if group.get("last") not in allowed:
                    group["last"] = ""
            legacy = state.get("legacy")
            if isinstance(legacy, dict):
                legacy["used"] = [key for key in legacy.get("used", []) if key in allowed]
                if legacy.get("last") not in allowed:
                    legacy["last"] = ""
        return catalog_keys

    @staticmethod
    def _group_for(state: dict[str, Any], scope: str, catalog_keys: set[str]) -> dict[str, Any]:
        groups = state.setdefault("groups", {})
        group = groups.get(scope)
        if not isinstance(group, dict):
            group = _empty_group()
            legacy = state.get("legacy")
            if isinstance(legacy, dict):
                group["used"] = [
                    key for key in legacy.get("used", []) if key in catalog_keys
                ]
                if legacy.get("last") in catalog_keys:
                    group["last"] = legacy["last"]
            groups[scope] = group
        return group

    def _prune_groups(self, state: dict[str, Any]) -> None:
        groups = state.get("groups")
        if not isinstance(groups, dict) or len(groups) <= self.max_groups:
            return
        ordered = sorted(
            groups.items(),
            key=lambda item: (int(item[1].get("updated_at", 0)), item[0]),
            reverse=True,
        )
        state["groups"] = dict(ordered[: self.max_groups])

    def choose(
        self,
        session_id: str,
        candidates: Iterable[dict[str, Any]],
        catalog: Iterable[dict[str, Any]],
        *,
        initialize: Callable[[dict[str, Any]], None],
        themed: bool = False,
    ) -> SelectionResult | None:
        """Select and initialize one puzzle, committing only after success.

        ``candidates`` is the theme-filtered slice and ``catalog`` is the full
        local catalog.  A theme that has been exhausted falls back to an
        unplayed full-catalog item while other items remain, which preserves
        the stronger per-group no-repeat guarantee.
        """

        selected_candidates = unique_puzzles(candidates)
        full_catalog = unique_puzzles(catalog)
        if not selected_candidates or not full_catalog:
            return None

        # Include the selected slice defensively if a caller supplied an
        # inconsistent catalog; this keeps the state invariant self-contained.
        known_surfaces = {_surface_identity(puzzle) for puzzle in full_catalog}
        for puzzle in selected_candidates:
            surface = _surface_identity(puzzle)
            if surface not in known_surfaces:
                full_catalog.append(puzzle)
                known_surfaces.add(surface)

        with self._lock:
            state = self._load()
            catalog_keys = self._sync_catalog(state, full_catalog)
            catalog_key_set = set(catalog_keys)
            scope = selection_scope_key(session_id)
            group = self._group_for(state, scope, catalog_key_set)
            used = {
                key for key in group.get("used", []) if key in catalog_key_set
            }
            available = [
                puzzle
                for puzzle in selected_candidates
                if puzzle_key(puzzle) not in used
            ]
            notice = ""

            if not available:
                # The requested theme has completed its slice, but the group
                # may still have never-seen puzzles elsewhere in the catalog.
                # Prefer those over repeating a surface from the theme.
                available = [
                    puzzle
                    for puzzle in full_catalog
                    if puzzle_key(puzzle) not in used
                ]
                if available and themed:
                    notice = "本群本轮该主题的题面已抽完，为保证不重复，已从本轮未出现的题库中选题。"

            if not available:
                # Every catalog item has been used by this group.  Start a new
                # cycle, avoiding the immediately previous item whenever there
                # is another choice.  A one-item catalog necessarily repeats.
                previous_key = str(group.get("last", ""))
                available = [
                    puzzle
                    for puzzle in selected_candidates
                    if puzzle_key(puzzle) != previous_key
                ] or selected_candidates
                used = set()

            puzzle = self.random.choice(available)
            initialize(puzzle)

            selected_key = puzzle_key(puzzle)
            ordered_used = [
                key
                for key in group.get("used", [])
                if key in used and key in catalog_key_set
            ]
            group["used"] = list(dict.fromkeys([*ordered_used, selected_key]))
            group["last"] = selected_key
            group["updated_at"] = int(time.time())
            self._prune_groups(state)
            self._persist(state)
            return SelectionResult(puzzle=puzzle, notice=notice)
