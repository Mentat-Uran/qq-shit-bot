#!/usr/bin/env python3
"""Small, text-first group games for the QQ game sidecar.

The sidecar already owns conversation-scoped locking and the turtle-soup
adapter.  This module deliberately contains only deterministic game rules and
JSON-friendly result payloads.  It has no QQ, FastAPI, filesystem, or model
dependency, so the rules can be tested without starting the deployment.

The production catalog is backed by the MIT ``China-idiom`` project.  A small
catalog protocol is used here so the game rules remain testable with a fixed
fixture and can be replaced by another licensed dictionary later.
"""

from __future__ import annotations

import random
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Protocol, Sequence


IDIOM_CHAIN = "idiom-chain"
IDIOM_WORDLE = "idiom-wordle"
GAME_TYPES = frozenset({IDIOM_CHAIN, IDIOM_WORDLE})

CHAIN_MAX_ROUNDS = 30
WORDLE_MAX_GUESSES = 10
GAME_IDLE_SECONDS = 6 * 60 * 60
MAX_ACTIVE_SESSIONS = 2048

_HANZI_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f\r\n]+")


def clean_hanzi(value: Any) -> str:
    """Return only CJK characters from a user-supplied guess."""

    return "".join(_HANZI_RE.findall(str(value or "")))


def _display_name(value: Any) -> str:
    """Keep user-visible names single-line and bounded."""

    clean = _CONTROL_RE.sub(" ", str(value or "")).strip()
    clean = re.sub(r"\s+", " ", clean)
    return clean[:40] or "群友"


def _bounded_text(value: Any, limit: int = 800) -> str:
    """Keep catalog text safe and bounded before returning it to QQ."""

    clean = _CONTROL_RE.sub(" ", str(value or "")).strip()
    clean = re.sub(r"\s+", " ", clean)
    return clean[:limit]


def _player_id(value: Any, fallback: str = "anonymous") -> str:
    """Normalize an in-memory player key without persisting it."""

    clean = _CONTROL_RE.sub(" ", str(value or "")).strip()
    return clean[:180] or fallback


class IdiomCatalog(Protocol):
    """Minimal licensed dictionary interface used by the game rules."""

    def random_word(
        self,
        *,
        require_follow: bool,
        heteronym: bool,
        rng: Any,
    ) -> str:
        ...

    def is_idiom(self, word: str) -> bool:
        ...

    def can_follow(self, before: str, after: str, *, heteronym: bool) -> bool:
        ...

    def next_words(
        self, word: str, *, heteronym: bool, limit: int = 3
    ) -> Sequence[str]:
        ...

    def info(self, word: str) -> dict[str, Any]:
        ...


class ChinaIdiomCatalog:
    """Adapter around the pinned ``China-idiom`` open-source package.

    Importing the package is delayed until the sidecar constructs the catalog;
    this keeps this module usable in the dependency-free unit tests.
    """

    def __init__(self) -> None:
        import china_idiom as idiom
        from china_idiom.loader import get_all_idioms

        self._idiom = idiom
        self._words = tuple(
            sorted(
                {
                    str(item.word)
                    for item in get_all_idioms()
                    if len(str(item.word)) == 4
                }
            )
        )
        self._word_set = frozenset(self._words)
        if not self._words:
            raise RuntimeError("China-idiom catalog has no four-character entries")

    @property
    def size(self) -> int:
        return len(self._words)

    def random_word(
        self,
        *,
        require_follow: bool,
        heteronym: bool,
        rng: Any,
    ) -> str:
        if not require_follow:
            return str(rng.choice(self._words))

        # Most entries have a successor.  Bounded sampling keeps startup
        # deterministic enough without constructing another large index.
        attempts = min(max(len(self._words), 1), 256)
        for _ in range(attempts):
            candidate = str(rng.choice(self._words))
            if self.next_words(candidate, heteronym=heteronym, limit=1):
                return candidate
        for candidate in self._words:
            if self.next_words(candidate, heteronym=heteronym, limit=1):
                return candidate
        return str(rng.choice(self._words))

    def is_idiom(self, word: str) -> bool:
        return word in self._word_set

    def info(self, word: str) -> dict[str, Any]:
        try:
            value = self._idiom.get_idiom_info(word)
        except (AttributeError, TypeError, ValueError):
            value = None
        return value if isinstance(value, dict) else {}

    def can_follow(self, before: str, after: str, *, heteronym: bool) -> bool:
        if before == after or not self.is_idiom(before) or not self.is_idiom(after):
            return False
        before_info = self.info(before)
        after_info = self.info(after)
        if not before_info or not after_info:
            return False
        if before_info.get("end_word") == after_info.get("head_word"):
            return True
        return bool(
            heteronym
            and before_info.get("end_pinyin")
            and before_info.get("end_pinyin") == after_info.get("head_pinyin")
        )

    def next_words(
        self, word: str, *, heteronym: bool, limit: int = 3
    ) -> Sequence[str]:
        if not self.is_idiom(word):
            return []
        try:
            # The upstream API samples from the complete candidate set when
            # count is below its size.  A bounded large count is enough for
            # hints and for detecting whether an unplayed successor exists.
            values = self._idiom.next_idioms_solitaire(
                word,
                count=max(1, min(int(limit), 2000)),
                heteronym=heteronym,
            )
        except (AttributeError, TypeError, ValueError):
            return []
        return [
            str(value)
            for value in values
            if str(value) in self._word_set and len(str(value)) == 4
        ]


@dataclass(slots=True)
class _Player:
    name: str
    score: int = 0
    moves: int = 0


@dataclass(slots=True)
class _ChainGame:
    mode: str
    current: str
    chain: list[str]
    used: set[str]
    players: dict[str, _Player]
    updated_at: float = field(default_factory=time.monotonic)

    @property
    def heteronym(self) -> bool:
        return self.mode == "homophone"


@dataclass(slots=True)
class _WordleGuess:
    word: str
    marks: list[str]
    player: str


@dataclass(slots=True)
class _WordleGame:
    answer: str
    explanation: str
    guesses: list[_WordleGuess]
    players: dict[str, _Player]
    hint_level: int = 0
    updated_at: float = field(default_factory=time.monotonic)


def score_wordle_guess(answer: str, guess: str) -> list[str]:
    """Apply Wordle's duplicate-aware exact/present/absent scoring."""

    marks = ["absent"] * len(guess)
    remaining = Counter(answer)
    for index, char in enumerate(guess):
        if index < len(answer) and char == answer[index]:
            marks[index] = "correct"
            remaining[char] -= 1
    for index, char in enumerate(guess):
        if marks[index] == "correct":
            continue
        if remaining[char] > 0:
            marks[index] = "present"
            remaining[char] -= 1
    return marks


class ChatGameManager:
    """Own one active text game per conversation scope."""

    def __init__(
        self,
        catalog: IdiomCatalog,
        *,
        random_source: Any | None = None,
        chain_max_rounds: int = CHAIN_MAX_ROUNDS,
        wordle_max_guesses: int = WORDLE_MAX_GUESSES,
        idle_seconds: float = GAME_IDLE_SECONDS,
        max_sessions: int = MAX_ACTIVE_SESSIONS,
    ) -> None:
        self.catalog = catalog
        self.random = random_source or random.SystemRandom()
        self.chain_max_rounds = max(4, min(int(chain_max_rounds), 100))
        self.wordle_max_guesses = max(4, min(int(wordle_max_guesses), 20))
        self.idle_seconds = max(60.0, float(idle_seconds))
        self.max_sessions = max(1, int(max_sessions))
        self._games: dict[str, _ChainGame | _WordleGame] = {}

    @staticmethod
    def _mode(value: Any) -> str:
        return "homophone" if str(value or "").strip().lower() in {
            "homophone",
            "same-sound",
            "同音",
            "谐音",
        } else "same"

    @staticmethod
    def _mode_label(mode: str) -> str:
        return "同音接龙" if mode == "homophone" else "同字接龙"

    def _expire(self, session_id: str) -> None:
        game = self._games.get(session_id)
        if game is not None and time.monotonic() - game.updated_at > self.idle_seconds:
            self._games.pop(session_id, None)

    def _game(self, session_id: str) -> _ChainGame | _WordleGame | None:
        self._expire(session_id)
        return self._games.get(session_id)

    @staticmethod
    def _touch(game: _ChainGame | _WordleGame) -> None:
        game.updated_at = time.monotonic()

    @staticmethod
    def _get_player(
        players: dict[str, _Player], player_id: Any, player_name: Any
    ) -> tuple[str, _Player]:
        key = _player_id(player_id)
        name = _display_name(player_name)
        player = players.get(key)
        if player is None:
            player = _Player(name=name)
            players[key] = player
        elif name != "群友":
            player.name = name
        return key, player

    @staticmethod
    def _leaderboard(players: dict[str, _Player]) -> list[dict[str, Any]]:
        values = sorted(
            players.values(),
            key=lambda player: (-player.score, -player.moves, player.name),
        )
        return [
            {"name": player.name, "score": player.score, "moves": player.moves}
            for player in values[:10]
        ]

    def active(self, session_id: str) -> bool:
        return self._game(session_id) is not None

    def active_count(self) -> int:
        for session_id in list(self._games):
            self._expire(session_id)
        return len(self._games)

    def start(
        self,
        session_id: str,
        game_type: str,
        *,
        mode: Any = "same",
        player_id: Any = "anonymous",
        player_name: Any = "群友",
    ) -> dict[str, Any]:
        if game_type not in GAME_TYPES:
            raise ValueError("unsupported chat game")
        if self.active(session_id):
            return {
                "ok": False,
                "active": True,
                "message": "当前群里已有进行中的小游戏，请先发送“放弃”结束它。",
            }
        if len(self._games) >= self.max_sessions:
            return {
                "ok": False,
                "active": False,
                "message": "小游戏房间已达到上限，请稍后再开一局。",
            }

        if game_type == IDIOM_CHAIN:
            selected_mode = self._mode(mode)
            first = self.catalog.random_word(
                require_follow=True,
                heteronym=selected_mode == "homophone",
                rng=self.random,
            )
            players: dict[str, _Player] = {}
            self._get_player(players, player_id, player_name)
            game: _ChainGame | _WordleGame = _ChainGame(
                mode=selected_mode,
                current=first,
                chain=[first],
                used={first},
                players=players,
            )
        else:
            answer = self.catalog.random_word(
                require_follow=False,
                heteronym=False,
                rng=self.random,
            )
            info = self.catalog.info(answer)
            players = {}
            self._get_player(players, player_id, player_name)
            game = _WordleGame(
                answer=answer,
                explanation=_bounded_text(info.get("explanation", "暂无释义"))
                if info
                else "暂无释义",
                guesses=[],
                players=players,
            )
        self._games[session_id] = game
        return {"ok": True, **self._payload(game)}

    def _payload(self, game: _ChainGame | _WordleGame) -> dict[str, Any]:
        if isinstance(game, _ChainGame):
            candidates = [
                word
                for word in self.catalog.next_words(
                    game.current,
                    heteronym=game.heteronym,
                    limit=1000,
                )
                if word not in game.used
            ]
            return {
                "active": True,
                "game_type": IDIOM_CHAIN,
                "title": "成语接龙",
                "mode": game.mode,
                "mode_label": self._mode_label(game.mode),
                "current_word": game.current,
                "target_char": game.current[-1:],
                "chain": game.chain[-12:],
                "chain_length": len(game.chain),
                "max_rounds": self.chain_max_rounds,
                "has_next": bool(candidates),
                "leaderboard": self._leaderboard(game.players),
            }
        return {
            "active": True,
            "game_type": IDIOM_WORDLE,
            "title": "猜成语",
            "attempts": len(game.guesses),
            "max_attempts": self.wordle_max_guesses,
            "remaining": max(0, self.wordle_max_guesses - len(game.guesses)),
            "hint_count": game.hint_level,
            "guesses": [
                {"word": guess.word, "marks": guess.marks, "player": guess.player}
                for guess in game.guesses
            ],
            "leaderboard": self._leaderboard(game.players),
        }

    def submit(
        self,
        session_id: str,
        text: Any,
        *,
        player_id: Any = "anonymous",
        player_name: Any = "群友",
    ) -> dict[str, Any] | None:
        game = self._game(session_id)
        if game is None:
            return None
        if isinstance(game, _ChainGame):
            return self._submit_chain(
                session_id, game, text, player_id=player_id, player_name=player_name
            )
        return self._submit_wordle(
            session_id, game, text, player_id=player_id, player_name=player_name
        )

    def _submit_chain(
        self,
        session_id: str,
        game: _ChainGame,
        text: Any,
        *,
        player_id: Any,
        player_name: Any,
    ) -> dict[str, Any]:
        word = clean_hanzi(text)
        base = self._payload(game)
        if len(word) != 4:
            return {
                "ok": True,
                **base,
                "accepted": False,
                "message": "请直接发送四个汉字组成的成语；需要规则可发送“小游戏”。",
            }
        if not self.catalog.is_idiom(word):
            return {
                "ok": True,
                **base,
                "accepted": False,
                "message": f"「{word}」不在四字成语词库里，再换一个试试。",
            }
        if word in game.used:
            return {
                "ok": True,
                **base,
                "accepted": False,
                "message": f"「{word}」已经接过了，不能重复使用。",
            }
        if not self.catalog.can_follow(
            game.current, word, heteronym=game.heteronym
        ):
            mode_hint = "同音" if game.heteronym else "同字"
            return {
                "ok": True,
                **base,
                "accepted": False,
                "message": (
                    f"接不上：上一条是「{game.current}」，请用「{game.current[-1:]}」"
                    f"开头（{mode_hint}规则）。"
                ),
            }

        _, player = self._get_player(game.players, player_id, player_name)
        player.score += 1
        player.moves += 1
        previous = game.current
        game.current = word
        game.chain.append(word)
        game.used.add(word)
        self._touch(game)
        candidates = [
            candidate
            for candidate in self.catalog.next_words(
                word, heteronym=game.heteronym, limit=1000
            )
            if candidate not in game.used
        ]
        ended = len(game.chain) >= self.chain_max_rounds or not candidates
        result: dict[str, Any] = {
            "ok": True,
            **self._payload(game),
            "accepted": True,
            "word": word,
            "previous_word": previous,
            "player": player.name,
        }
        if ended:
            self._games.pop(session_id, None)
            result.update(
                {
                    "active": False,
                    "ended": True,
                    "end_reason": "max-rounds"
                    if len(game.chain) >= self.chain_max_rounds
                    else "no-next-word",
                    "leaderboard": self._leaderboard(game.players),
                    "chain": game.chain[-30:],
                }
            )
        return result

    def _submit_wordle(
        self,
        session_id: str,
        game: _WordleGame,
        text: Any,
        *,
        player_id: Any,
        player_name: Any,
    ) -> dict[str, Any]:
        word = clean_hanzi(text)
        base = self._payload(game)
        if len(word) != 4:
            return {
                "ok": True,
                **base,
                "accepted": False,
                "message": "请直接发送四个汉字作为一次猜测。",
            }
        if any(guess.word == word for guess in game.guesses):
            return {
                "ok": True,
                **base,
                "accepted": False,
                "message": f"「{word}」已经猜过了，这次不扣次数。",
            }

        _, player = self._get_player(game.players, player_id, player_name)
        player.moves += 1
        marks = score_wordle_guess(game.answer, word)
        guess = _WordleGuess(word=word, marks=marks, player=player.name)
        game.guesses.append(guess)
        self._touch(game)
        won = all(mark == "correct" for mark in marks)
        lost = len(game.guesses) >= self.wordle_max_guesses and not won
        result: dict[str, Any] = {
            "ok": True,
            **self._payload(game),
            "accepted": True,
            "word": word,
            "marks": marks,
            "player": player.name,
        }
        if won or lost:
            if won:
                player.score += max(1, self.wordle_max_guesses - len(game.guesses) + 1)
            self._games.pop(session_id, None)
            result.update(
                {
                    "active": False,
                    "ended": True,
                    "result": "win" if won else "loss",
                    "answer": game.answer,
                    "explanation": game.explanation,
                    "leaderboard": self._leaderboard(game.players),
                }
            )
        return result

    def status(self, session_id: str) -> dict[str, Any] | None:
        game = self._game(session_id)
        return self._payload(game) if game is not None else None

    def hint(self, session_id: str) -> dict[str, Any] | None:
        game = self._game(session_id)
        if game is None:
            return None
        if isinstance(game, _ChainGame):
            candidates = [
                word
                for word in self.catalog.next_words(
                    game.current, heteronym=game.heteronym, limit=1000
                )
                if word not in game.used
            ]
            if not candidates:
                return {
                    "ok": True,
                    **self._payload(game),
                    "hint": None,
                    "message": "这一棒已经没有新的可接成语了。",
                }
            self._touch(game)
            return {
                "ok": True,
                **self._payload(game),
                "hint": candidates[:3],
                "message": "可以从下面挑一个，也可以自己想：",
            }

        if game.hint_level >= len(game.answer):
            return {
                "ok": True,
                **self._payload(game),
                "hint": None,
                "message": "四个字都提示过了，答案就在大家眼前。",
            }
        position = game.hint_level
        game.hint_level += 1
        self._touch(game)
        return {
            "ok": True,
            **self._payload(game),
            "hint": {"position": position + 1, "char": game.answer[position]},
            "message": f"答案第 {position + 1} 个字是「{game.answer[position]}」。",
        }

    def end(self, session_id: str) -> dict[str, Any] | None:
        game = self._games.pop(session_id, None)
        if game is None:
            return None
        if isinstance(game, _ChainGame):
            return {
                "ok": True,
                **self._payload(game),
                "active": False,
                "ended": True,
                "chain": game.chain,
                "leaderboard": self._leaderboard(game.players),
            }
        return {
            "ok": True,
            **self._payload(game),
            "active": False,
            "ended": True,
            "answer": game.answer,
            "explanation": game.explanation,
            "leaderboard": self._leaderboard(game.players),
        }
