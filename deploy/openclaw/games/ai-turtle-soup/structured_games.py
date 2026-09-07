#!/usr/bin/env python3
"""Deterministic public-chat games backed by local JSON question banks.

This module intentionally contains no QQ, HTTP, model, or filesystem writes.
It owns the shared room lifecycle for the structured games: one active room per
conversation, bounded in-memory state, idle expiry, public prompts, player
scores, and answer statistics.  The two older idiom games keep their mature
rules in :mod:`chat_games`; ``ChatGameManager`` delegates the additional game
types here so the adapter still has one room-facing API.
"""

from __future__ import annotations

import ast
import json
import math
import random
import re
import time
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any, Mapping, Sequence


# Stable IDs are used by the adapter and by future bank imports.  Display
# labels and aliases are intentionally kept in one registry for menu tooling.
GAME_DEFINITIONS: tuple[dict[str, Any], ...] = (
    {"id": "number-bomb", "category": "rules", "name": "数字炸弹", "aliases": ["炸弹", "数字雷"]},
    {"id": "twenty-four", "category": "rules", "name": "24点", "aliases": ["24", "24点游戏", "二十四点"]},
    {"id": "guess-person", "category": "quiz", "name": "猜人物", "aliases": ["人物", "猜名人"]},
    {"id": "guess-work", "category": "quiz", "name": "猜作品", "aliases": ["作品", "猜电影", "猜动漫", "猜游戏"]},
    {"id": "knowledge", "category": "quiz", "name": "知识抢答", "aliases": ["抢答", "知识题"]},
    {"id": "true-false", "category": "quiz", "name": "真假判断", "aliases": ["真假", "判断题"]},
    {"id": "find-different", "category": "quiz", "name": "找不同", "aliases": ["找茬", "找不同题"]},
    {"id": "word-classification", "category": "quiz", "name": "词语分类", "aliases": ["分类", "词语归类"]},
    {"id": "one-line-reasoning", "category": "quiz", "name": "一句话推理", "aliases": ["一句话推理题", "推理"]},
    {"id": "brain-teaser", "category": "quiz", "name": "脑筋急转弯", "aliases": ["脑筋急转弯题", "脑筋"]},
    {"id": "riddle", "category": "quiz", "name": "谜语", "aliases": ["猜谜", "灯谜"]},
    {"id": "flower-order", "category": "rules", "name": "飞花令", "aliases": ["飞花令游戏"]},
    {"id": "poetry-chain", "category": "rules", "name": "诗词接龙", "aliases": ["诗词龙", "诗句接龙"]},
    {"id": "sorting", "category": "quiz", "name": "排序题", "aliases": ["排序"]},
    {"id": "clue-auction", "category": "rules", "name": "线索竞拍", "aliases": ["竞拍", "线索拍卖"]},
    {"id": "exam", "category": "exam", "name": "行测抢答", "aliases": ["行测", "行测刷题", "公务员刷题"]},
)

GAME_DEFINITION_BY_ID = {item["id"]: item for item in GAME_DEFINITIONS}
STRUCTURED_GAME_TYPES = frozenset(GAME_DEFINITION_BY_ID)

EXAM_CATEGORIES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("common", "常识判断", ("常识", "常识判断")),
    ("verbal", "言语理解", ("言语", "言语理解")),
    ("reasoning", "判断推理", ("判断", "判断推理")),
    ("quant", "数量关系", ("数量", "数量关系")),
    ("data", "资料分析", ("资料", "资料分析")),
)
EXAM_CATEGORY_ALIASES = {
    alias: key
    for key, label, aliases in EXAM_CATEGORIES
    for alias in (key, label, *aliases)
}

NEXT_WORDS = frozenset({"下一题", "继续", "下一局", "再来一题", "再来", "出题"})
ANSWER_WORDS = frozenset({"答案", "公布答案", "看答案", "解析", "答案解析", "行测答案", "行测解析"})

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f\r\n]+")
_SPACE_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[，。！？；：、“”‘’（）()【】\[\]{}<>《》,.!?;:'\"`~·…—_+=/\\-]+")


def _clean_display(value: Any, limit: int = 600) -> str:
    value = _CONTROL_RE.sub(" ", str(value or "")).strip()
    return _SPACE_RE.sub(" ", value)[:limit]


def _player_key(value: Any, fallback: str = "anonymous") -> str:
    clean = _CONTROL_RE.sub(" ", str(value or "")).strip()
    return clean[:180] or fallback


def _player_name(value: Any) -> str:
    return _clean_display(value, 40) or "群友"


def normalize_answer(value: Any) -> str:
    """Normalize public answers without doing fuzzy/LLM judgement."""

    clean = _clean_display(value, 200).lower()
    clean = re.sub(r"^(?:答案|回答|我答|我的答案)\s*[:：]?\s*", "", clean)
    return _PUNCT_RE.sub("", clean).replace(" ", "")


def _answer_candidates(question: Mapping[str, Any]) -> set[str]:
    values = [question.get("answer"), *(question.get("aliases") or [])]
    return {normalize_answer(value) for value in values if normalize_answer(value)}


@dataclass(slots=True)
class _Player:
    name: str
    score: int = 0
    moves: int = 0
    total: int = 0
    correct: int = 0

    @property
    def accuracy(self) -> int:
        return int(round(self.correct * 100 / self.total)) if self.total else 0


@dataclass(slots=True)
class _Session:
    game_type: str
    state: dict[str, Any]
    players: dict[str, _Player]
    updated_at: float = field(default_factory=time.monotonic)


def _load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_game_banks(
    bank_path: str | Path | None = None,
    exam_path: str | Path | None = None,
) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    """Load and lightly validate the local structured banks.

    The files are read once at process start.  A malformed entry is ignored by
    the manager rather than making one optional game prevent Turtle Soup from
    starting; the deployment health endpoint still reports the resulting
    counts.
    """

    root = Path(__file__).resolve().parent
    raw_bank = _load_json(Path(bank_path) if bank_path else root / "game_bank.json")
    raw_exam = _load_json(Path(exam_path) if exam_path else root / "exam_bank.json")
    games: dict[str, list[dict[str, Any]]] = {}
    if isinstance(raw_bank, Mapping):
        for key, values in raw_bank.items():
            if not isinstance(values, list):
                continue
            games[str(key)] = [item for item in values if isinstance(item, dict) and item.get("prompt")]
    exams = [item for item in raw_exam if isinstance(item, dict) and item.get("prompt")]
    return games, exams


def _safe_number(value: Any) -> int | None:
    text = _clean_display(value, 80)
    match = re.search(r"[-+]?\d+", text)
    try:
        return int(match.group(0)) if match else None
    except ValueError:
        return None


def _parse_position(value: Any) -> str:
    text = normalize_answer(value)
    match = re.search(r"(?:第)?([a-z]|\d+)(?:个|处|项|位)?", text, re.I)
    return match.group(1).upper() if match else text.upper()


def evaluate_24_expression(expression: Any, numbers: Sequence[int]) -> bool:
    """Safely check a four-number expression, with no eval and no exponents."""

    source = str(expression or "").strip().replace("×", "*").replace("÷", "/").replace("／", "/")
    if len(source) > 120 or not source:
        return False
    try:
        tree = ast.parse(source, mode="eval")
    except (SyntaxError, ValueError):
        return False
    values: list[int] = []

    def visit(node: ast.AST) -> Fraction:
        if isinstance(node, ast.Expression):
            return visit(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, int) and not isinstance(node.value, bool):
            values.append(int(node.value))
            return Fraction(int(node.value))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = visit(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
            left = visit(node.left)
            right = visit(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if right == 0:
                raise ZeroDivisionError
            return left / right
        raise ValueError("unsupported expression")

    try:
        result = visit(tree)
    except (ValueError, ZeroDivisionError, RecursionError):
        return False
    return sorted(values) == sorted(int(value) for value in numbers) and result == 24


def solve_24(numbers: Sequence[int]) -> str:
    """Return one deterministic solution for a four-number 24-point round."""

    values = [Fraction(int(value)) for value in numbers]

    def search(items: list[tuple[Fraction, str]]) -> str | None:
        if len(items) == 1:
            return items[0][1] if items[0][0] == 24 else None
        for left_index in range(len(items)):
            for right_index in range(left_index + 1, len(items)):
                left, right = items[left_index], items[right_index]
                rest = [item for index, item in enumerate(items) if index not in {left_index, right_index}]
                options = [
                    (left[0] + right[0], f"({left[1]}+{right[1]})"),
                    (left[0] - right[0], f"({left[1]}-{right[1]})"),
                    (right[0] - left[0], f"({right[1]}-{left[1]})"),
                    (left[0] * right[0], f"({left[1]}×{right[1]})"),
                ]
                if right[0]:
                    options.append((left[0] / right[0], f"({left[1]}÷{right[1]})"))
                if left[0]:
                    options.append((right[0] / left[0], f"({right[1]}÷{left[1]})"))
                for value, expression in options:
                    answer = search(rest + [(value, expression)])
                    if answer:
                        return answer
        return None

    return search([(value, str(int(value))) for value in values]) or "暂无整除解"


def _split_order(value: Any) -> list[str]:
    text = _clean_display(value, 200).upper()
    text = re.sub(r"(?:顺序|答案|为)\s*[:：]?", "", text)
    return [item for item in re.split(r"\s*(?:[,，、>＞→]|\s+|和)\s*", text) if item]


class StructuredGameManager:
    """In-memory manager for deterministic bank-backed public games."""

    def __init__(
        self,
        bank: Mapping[str, Sequence[Mapping[str, Any]]] | None = None,
        exam_bank: Sequence[Mapping[str, Any]] | None = None,
        *,
        random_source: Any | None = None,
        idle_seconds: float = 6 * 60 * 60,
        max_sessions: int = 2048,
    ) -> None:
        if bank is None or exam_bank is None:
            loaded_games, loaded_exams = load_game_banks()
            if bank is None:
                bank = loaded_games
            if exam_bank is None:
                exam_bank = loaded_exams
        self.bank = {
            str(key): [dict(item) for item in values if isinstance(item, Mapping)]
            for key, values in (bank or {}).items()
        }
        self.exam_bank = [dict(item) for item in (exam_bank or []) if isinstance(item, Mapping)]
        self.random = random_source or random.SystemRandom()
        self.idle_seconds = max(60.0, float(idle_seconds))
        self.max_sessions = max(1, int(max_sessions))
        self._sessions: dict[str, _Session] = {}

    @property
    def catalog_size(self) -> int:
        return sum(len(values) for values in self.bank.values()) + len(self.exam_bank)

    @property
    def exam_catalog_size(self) -> int:
        return len(self.exam_bank)

    @property
    def exam_public_catalog_size(self) -> int:
        return sum(1 for item in self.exam_bank if item.get("public_safe", True))

    def _expire(self, session_id: str) -> None:
        session = self._sessions.get(session_id)
        if session is not None and time.monotonic() - session.updated_at > self.idle_seconds:
            self._sessions.pop(session_id, None)

    def _get(self, session_id: str) -> _Session | None:
        self._expire(session_id)
        return self._sessions.get(session_id)

    @staticmethod
    def _touch(session: _Session) -> None:
        session.updated_at = time.monotonic()

    @staticmethod
    def _get_player(players: dict[str, _Player], player_id: Any, player_name: Any) -> tuple[str, _Player]:
        key = _player_key(player_id)
        name = _player_name(player_name)
        player = players.get(key)
        if player is None:
            player = _Player(name=name)
            players[key] = player
        elif name != "群友":
            player.name = name
        return key, player

    @staticmethod
    def _leaderboard(players: Mapping[str, _Player]) -> list[dict[str, Any]]:
        ranked = sorted(players.values(), key=lambda item: (-item.score, -item.correct, item.name))
        return [
            {
                "name": player.name,
                "score": player.score,
                "moves": player.moves,
                "correct": player.correct,
                "total": player.total,
                "accuracy": player.accuracy,
            }
            for player in ranked[:10]
        ]

    def active(self, session_id: str) -> bool:
        return self._get(session_id) is not None

    def active_count(self) -> int:
        for session_id in list(self._sessions):
            self._expire(session_id)
        return len(self._sessions)

    def _category(self, value: Any) -> str:
        clean = normalize_answer(value)
        return EXAM_CATEGORY_ALIASES.get(clean, "")

    def _choose_question(self, game_type: str, state: dict[str, Any], category: str = "") -> dict[str, Any]:
        if game_type == "exam":
            candidates = [
                item
                for item in self.exam_bank
                if item.get("public_safe", True)
                and (not category or item.get("category") == category)
            ]
        else:
            candidates = list(self.bank.get(game_type, []))
        if not candidates:
            raise ValueError(f"no local questions for {game_type}")
        used = set(state.get("used_ids", []))
        available = [item for item in candidates if str(item.get("id", "")) not in used]
        if not available:
            used.clear()
            available = candidates
        question = dict(self.random.choice(available))
        question_id = str(question.get("id", ""))
        if question_id:
            used.add(question_id)
        state["used_ids"] = list(used)
        return question

    def _new_state(self, game_type: str, category: str = "") -> dict[str, Any]:
        state: dict[str, Any] = {"round": 1, "awaiting_next": False, "last_result": None, "used_ids": []}
        state["category"] = category
        if game_type == "number-bomb":
            state.update({"low": 1, "high": 100, "secret": int(self.random.randint(1, 100)), "attempts": 0})
        elif game_type == "twenty-four":
            numbers = [int(self.random.choice(range(1, 14))) for _ in range(4)]
            state.update({"numbers": numbers, "solution": solve_24(numbers), "attempts": 0})
        elif game_type == "flower-order":
            self._advance_question(game_type, state)
            return state
        elif game_type == "poetry-chain":
            self._advance_question(game_type, state)
            return state
        elif game_type == "clue-auction":
            self._advance_question(game_type, state)
            return state
        else:
            self._advance_question(game_type, state)
        return state

    def _advance_question(self, game_type: str, state: dict[str, Any]) -> None:
        question = self._choose_question(game_type, state, str(state.get("category", "")))
        state["question"] = question
        state["awaiting_next"] = False
        state["last_result"] = None
        state["clue_index"] = 0
        if game_type == "flower-order":
            state["used_entries"] = []
            state["valid_count"] = 0
            state["target_count"] = int(question.get("target_count", 3))
        elif game_type == "poetry-chain":
            start = str(question.get("start", ""))
            state.update({"current": start, "chain": [start] if start else [], "used_entries": []})
        elif game_type == "clue-auction":
            state["revealed_clues"] = []

    def start(
        self,
        session_id: str,
        game_type: str,
        *,
        category: Any = "",
        mode: Any = "",
        player_id: Any = "anonymous",
        player_name: Any = "群友",
    ) -> dict[str, Any]:
        if game_type not in STRUCTURED_GAME_TYPES:
            raise ValueError("unsupported structured game")
        if self.active(session_id):
            return {"ok": False, "active": True, "message": "当前群里已有进行中的小游戏，请先发送“放弃”结束它。"}
        if len(self._sessions) >= self.max_sessions:
            return {"ok": False, "active": False, "message": "小游戏房间已达到上限，请稍后再开一局。"}
        selected_category = self._category(category or mode) if game_type == "exam" else ""
        try:
            state = self._new_state(game_type, selected_category)
        except ValueError:
            raise
        players: dict[str, _Player] = {}
        self._get_player(players, player_id, player_name)
        session = _Session(game_type=game_type, state=state, players=players)
        self._sessions[session_id] = session
        return {"ok": True, **self._payload(session)}

    def _title(self, game_type: str) -> str:
        return str(GAME_DEFINITION_BY_ID.get(game_type, {}).get("name", game_type))

    def _instructions(self, session: _Session) -> str:
        game_type = session.game_type
        return {
            "number-bomb": "发送整数猜数字；提示：提示；下一局：下一题。",
            "twenty-four": "只用给出的四个数字和加减乘除算出24；发送表达式。",
            "guess-person": "根据线索直接猜人物；提示会公开下一条线索。",
            "guess-work": "根据线索猜电影、动漫或游戏作品；提示会公开下一条线索。",
            "knowledge": "发送选项 A/B/C/D 或答案文字，先答对者得分。",
            "true-false": "发送“真”或“假”，先答对者得分。",
            "find-different": "发送不同项的位置，例如 A、3 或第3个。",
            "word-classification": "发送这组词所属的类别。",
            "one-line-reasoning": "根据一段话给出最简短的结论。",
            "brain-teaser": "直接发送脑筋急转弯的答案。",
            "riddle": "直接发送谜底。",
            "flower-order": "发送一条题库中的诗句，必须包含指定字；先凑够目标条数。",
            "poetry-chain": "发送题库诗句，下一句的首字要接上上一句末字。",
            "sorting": "按题意发送顺序，例如 A>B>C>D。",
            "clue-auction": "发送“竞价 N”公开购买一条线索，再回答谜底。",
            "exam": "单选/判断发送选项 A/B；多选按 AC 或 A、C 发送。答完发送“下一题”继续，发送“解析”查看答案。",
        }.get(game_type, "直接发送答案；提示：提示；状态：查看进度；结束：放弃。")

    def _question_text(self, session: _Session) -> str:
        state = session.state
        game_type = session.game_type
        if state.get("awaiting_next"):
            return "上一题已结束，发送“下一题”继续，或发送“放弃”结束本局。"
        if game_type == "number-bomb":
            return f"请在 {state['low']}～{state['high']} 之间找出炸弹数字。"
        if game_type == "twenty-four":
            numbers = "、".join(str(item) for item in state["numbers"])
            return f"用 {numbers} 各一次，通过加减乘除算出24。"
        question = state.get("question") or {}
        prompt_limit = 4200 if game_type == "exam" else 900
        prompt = _clean_display(question.get("prompt", ""), prompt_limit)
        options = question.get("options")
        if isinstance(options, list) and options:
            prompt += "\n" + "\n".join(f"{chr(65 + index)}. {str(value)[:220]}" for index, value in enumerate(options[:5]))
        if game_type == "flower-order":
            return prompt + f"\n题字：「{question.get('character', '')}」；已完成 {state.get('valid_count', 0)}/{state.get('target_count', 3)} 条。"
        if game_type == "poetry-chain":
            return prompt + f"\n当前诗句：「{state.get('current', '')}」；请接「{str(state.get('current', ''))[-1:]}」开头的下一句。"
        if game_type == "clue-auction" and state.get("revealed_clues"):
            clues = state["revealed_clues"]
            prompt += "\n已公开线索：" + "；".join(str(item) for item in clues)
        return prompt

    def _payload(self, session: _Session) -> dict[str, Any]:
        state = session.state
        payload: dict[str, Any] = {
            "active": True,
            "game_type": session.game_type,
            "title": self._title(session.game_type),
            "category": state.get("category", ""),
            "round": int(state.get("round", 1)),
            "prompt": self._question_text(session),
            "instructions": self._instructions(session),
            "awaiting_next": bool(state.get("awaiting_next")),
            "leaderboard": self._leaderboard(session.players),
        }
        if session.game_type == "exam":
            question = state.get("question") or {}
            payload["exam_category"] = next(
                (label for key, label, _aliases in EXAM_CATEGORIES if key == question.get("category")),
                str(question.get("category", "行测")),
            )
            payload["question_no"] = state.get("round", 1)
            payload["question_type"] = question.get("question_type", "single")
        if session.game_type == "number-bomb":
            payload.update({"low": state["low"], "high": state["high"], "attempts": state["attempts"]})
        if session.game_type == "twenty-four":
            payload.update({"numbers": list(state["numbers"]), "attempts": state["attempts"]})
        if session.game_type == "poetry-chain":
            payload.update({"chain": list(state.get("chain", []))[-8:], "chain_length": len(state.get("chain", []))})
        if session.game_type == "clue-auction":
            payload.update({"clues_revealed": len(state.get("revealed_clues", []))})
        if state.get("last_result"):
            payload["last_result"] = state["last_result"]
        return payload

    def _result_payload(self, session: _Session, **extra: Any) -> dict[str, Any]:
        return {"ok": True, **self._payload(session), **extra}

    def _advance(self, session: _Session) -> dict[str, Any]:
        session.state["round"] = int(session.state.get("round", 1)) + 1
        if session.game_type == "number-bomb":
            session.state.update({"low": 1, "high": 100, "secret": int(self.random.randint(1, 100)), "attempts": 0, "awaiting_next": False, "last_result": None})
        elif session.game_type == "twenty-four":
            numbers = [int(self.random.choice(range(1, 14))) for _ in range(4)]
            session.state.update({"numbers": numbers, "solution": solve_24(numbers), "attempts": 0, "awaiting_next": False, "last_result": None})
        else:
            self._advance_question(session.game_type, session.state)
        self._touch(session)
        return self._result_payload(session, next=True)

    def _mark_attempt(self, player: _Player, correct: bool, *, points: int = 1) -> None:
        player.moves += 1
        player.total += 1
        if correct:
            player.correct += 1
            player.score += points

    def _complete_answer(self, session: _Session, player: _Player, answer: str, *, points: int = 1) -> dict[str, Any]:
        self._mark_attempt(player, True, points=points)
        session.state["awaiting_next"] = True
        session.state["last_result"] = "correct"
        self._touch(session)
        question = session.state.get("question") or {}
        return self._result_payload(
            session,
            correct=True,
            player=player.name,
            answer=answer,
            explanation=_clean_display(question.get("explanation", "答对了！"), 900),
            message="答对了！发送“下一题”继续。",
        )

    def _wrong_answer(self, session: _Session, player: _Player, message: str) -> dict[str, Any]:
        self._mark_attempt(player, False)
        self._touch(session)
        return self._result_payload(session, correct=False, player=player.name, message=message)

    def _submit_number(self, session: _Session, text: Any, player: _Player) -> dict[str, Any]:
        number = _safe_number(text)
        if number is None:
            return self._result_payload(session, accepted=False, message="请输入范围内的整数。")
        state = session.state
        if number < state["low"] or number > state["high"]:
            return self._result_payload(session, accepted=False, message=f"请猜 {state['low']}～{state['high']} 之间的数字。")
        state["attempts"] += 1
        if number == state["secret"]:
            result = self._complete_answer(session, player, str(number), points=max(1, 6 - state["attempts"]))
            result["attempts"] = state["attempts"]
            return result
        self._mark_attempt(player, False)
        if number < state["secret"]:
            state["low"] = number + 1
            message = "小了，炸弹在更大的数字里。"
        else:
            state["high"] = number - 1
            message = "大了，炸弹在更小的数字里。"
        self._touch(session)
        return self._result_payload(session, accepted=True, correct=False, player=player.name, message=message)

    def _submit_24(self, session: _Session, text: Any, player: _Player) -> dict[str, Any]:
        if not evaluate_24_expression(text, session.state["numbers"]):
            return self._wrong_answer(session, player, "还没算出24，表达式必须只用给出的四个数字各一次。")
        return self._complete_answer(session, player, _clean_display(text, 120), points=2)

    def _submit_poetry(self, session: _Session, text: Any, player: _Player) -> dict[str, Any]:
        state = session.state
        question = state.get("question") or {}
        entries = question.get("entries") or []
        normalized = normalize_answer(text)
        used = {normalize_answer(item) for item in state.get("used_entries", [])}
        match = next((entry for entry in entries if normalize_answer(entry.get("line")) == normalized), None)
        if not match:
            return self._wrong_answer(session, player, "这句不在本局公开题库里，或没有接上当前要求。")
        line = str(match.get("line", ""))
        if normalize_answer(line) in used:
            return self._wrong_answer(session, player, "这句已经用过了，换一句。")
        if session.game_type == "flower-order":
            if str(question.get("character", "")) not in line:
                return self._wrong_answer(session, player, "这句没有包含本局题字。")
            state.setdefault("used_entries", []).append(line)
            state["valid_count"] += 1
            self._mark_attempt(player, True, points=1)
            if state["valid_count"] >= state["target_count"]:
                state["awaiting_next"] = True
                state["last_result"] = "correct"
                message = "飞花令完成！发送“下一题”换一个题字。"
            else:
                message = f"接得漂亮，还需要 {state['target_count'] - state['valid_count']} 条。"
            self._touch(session)
            return self._result_payload(session, correct=True, player=player.name, answer=line, message=message)
        current = str(state.get("current", ""))
        if current and not line.startswith(current[-1:]):
            return self._wrong_answer(session, player, f"没有接上，请找「{current[-1:]}」开头的诗句。")
        state.setdefault("used_entries", []).append(line)
        state.setdefault("chain", []).append(line)
        state["current"] = line
        self._mark_attempt(player, True, points=1)
        if len(state["chain"]) >= int(question.get("max_rounds", 8)):
            state["awaiting_next"] = True
            state["last_result"] = "correct"
            message = "诗词接龙达到本局长度上限！发送“下一题”继续。"
        else:
            message = "接龙成功，继续接下一句。"
        self._touch(session)
        return self._result_payload(session, correct=True, player=player.name, answer=line, message=message)

    def _submit_auction(self, session: _Session, text: Any, player: _Player) -> dict[str, Any]:
        clean = _clean_display(text, 200)
        bid = re.search(r"^(?:竞价|出价|买线索)\s*([0-9]+)$", clean)
        state = session.state
        question = state.get("question") or {}
        clues = question.get("clues") or []
        if bid:
            index = len(state.get("revealed_clues", []))
            if index >= len(clues):
                return self._result_payload(session, accepted=False, message="线索已经全部公开，直接猜答案吧。")
            cost = int((question.get("clue_costs") or [1] * len(clues))[index])
            offered = int(bid.group(1))
            if offered < cost:
                return self._result_payload(session, accepted=False, message=f"下一条线索的最低竞价是 {cost} 分。")
            state.setdefault("revealed_clues", []).append(str(clues[index])[:300])
            player.moves += 1
            self._touch(session)
            return self._result_payload(session, accepted=True, player=player.name, message=f"公开线索（竞价 {offered}）：{clues[index]}")
        return self._submit_bank_answer(session, text, player)

    def _submit_bank_answer(self, session: _Session, text: Any, player: _Player) -> dict[str, Any]:
        question = session.state.get("question") or {}
        answer = normalize_answer(text)
        if answer in _answer_candidates(question):
            return self._complete_answer(session, player, str(question.get("answer", "")), points=2 if session.game_type == "clue-auction" else 1)
        return self._wrong_answer(session, player, "还没答对，继续想想；需要公开线索可发送“提示”。")

    def _submit_sorting(self, session: _Session, text: Any, player: _Player) -> dict[str, Any]:
        question = session.state.get("question") or {}
        answer = _split_order(text)
        expected = [str(item).upper() for item in question.get("answer_order", [])]
        if answer == expected or normalize_answer(text) in _answer_candidates(question):
            return self._complete_answer(session, player, str(question.get("answer", "")), points=1)
        return self._wrong_answer(session, player, "顺序还不对，请按 A>B>C 或题目要求的格式发送。")

    def _submit_find_different(self, session: _Session, text: Any, player: _Player) -> dict[str, Any]:
        question = session.state.get("question") or {}
        answer = _parse_position(text)
        expected = {str(question.get("answer", "")).upper(), *(str(item).upper() for item in question.get("aliases", []))}
        if answer in expected:
            return self._complete_answer(session, player, str(question.get("answer", "")), points=1)
        return self._wrong_answer(session, player, "位置不对，再观察一次题面。")

    def submit(
        self,
        session_id: str,
        text: Any,
        *,
        player_id: Any = "anonymous",
        player_name: Any = "群友",
    ) -> dict[str, Any] | None:
        session = self._get(session_id)
        if session is None:
            return None
        clean = _clean_display(text, 300)
        if normalize_answer(clean) in {normalize_answer(item) for item in NEXT_WORDS} and session.state.get("awaiting_next"):
            return self._advance(session)
        if normalize_answer(clean) in {normalize_answer(item) for item in ANSWER_WORDS}:
            return self.answer(session_id)
        _key, player = self._get_player(session.players, player_id, player_name)
        if session.state.get("awaiting_next"):
            return self._result_payload(session, accepted=False, message="本题已经结束，发送“下一题”继续。")
        if session.game_type == "number-bomb":
            return self._submit_number(session, clean, player)
        if session.game_type == "twenty-four":
            return self._submit_24(session, clean, player)
        if session.game_type in {"flower-order", "poetry-chain"}:
            return self._submit_poetry(session, clean, player)
        if session.game_type == "clue-auction":
            return self._submit_auction(session, clean, player)
        if session.game_type == "sorting":
            return self._submit_sorting(session, clean, player)
        if session.game_type == "find-different":
            return self._submit_find_different(session, clean, player)
        return self._submit_bank_answer(session, clean, player)

    def status(self, session_id: str) -> dict[str, Any] | None:
        session = self._get(session_id)
        return self._payload(session) if session else None

    def hint(self, session_id: str) -> dict[str, Any] | None:
        session = self._get(session_id)
        if session is None:
            return None
        if session.game_type == "exam":
            return self.answer(session_id)
        state = session.state
        if state.get("awaiting_next"):
            return self._result_payload(session, hint=None, message="本题已结束，发送“下一题”继续。")
        if session.game_type == "number-bomb":
            span = state["high"] - state["low"]
            return self._result_payload(session, hint=f"当前还剩 {span + 1} 个可能数字。", message="范围越小越接近答案。")
        if session.game_type == "twenty-four":
            return self._result_payload(session, hint="可以先寻找能得到 1、2、3、4、6、8 的中间结果。", message="提示不直接公布算式。")
        question = state.get("question") or {}
        clues = question.get("clues") or []
        index = int(state.get("clue_index", 0))
        if index < len(clues):
            state["clue_index"] = index + 1
            self._touch(session)
            return self._result_payload(session, hint=_clean_display(clues[index], 400), current=index + 1, total=len(clues), message="公开一条线索。")
        if session.game_type == "clue-auction":
            return self._result_payload(session, hint="请用“竞价 N”购买线索。", message="竞价是公开的，不需要私聊或隐藏身份。")
        return self._result_payload(session, hint=None, message="线索已经全部公开。")

    def answer(self, session_id: str) -> dict[str, Any] | None:
        session = self._get(session_id)
        if session is None:
            return None
        state = session.state
        question = state.get("question") or {}
        if session.game_type == "number-bomb":
            value = str(state.get("secret"))
            explanation = "炸弹数字已公开。"
        elif session.game_type == "twenty-four":
            value = str(state.get("solution", ""))
            explanation = "只要四个数字各用一次并得到24即可。"
        elif session.game_type == "poetry-chain":
            value = " → ".join(state.get("chain", []))
            explanation = "本局已接诗句。"
        else:
            value = str(question.get("answer", "暂无标准答案"))
            explanation = _clean_display(question.get("explanation", ""), 900)
        state["awaiting_next"] = True
        state["last_result"] = "revealed"
        self._touch(session)
        return self._result_payload(session, revealed=True, answer=value, explanation=explanation, message="答案已公开，发送“下一题”继续。")

    def end(self, session_id: str) -> dict[str, Any] | None:
        session = self._sessions.pop(session_id, None)
        if session is None:
            return None
        state = session.state
        question = state.get("question") or {}
        result: dict[str, Any] = {
            "ok": True,
            **self._payload(session),
            "active": False,
            "ended": True,
            "leaderboard": self._leaderboard(session.players),
        }
        if session.game_type == "number-bomb":
            result.update({"answer": str(state.get("secret")), "explanation": "炸弹数字已公布。"})
        elif session.game_type == "twenty-four":
            result.update({"answer": state.get("solution", ""), "explanation": "四个数字各用一次得到24。"})
        elif session.game_type == "poetry-chain":
            result.update({"answer": " → ".join(state.get("chain", [])), "explanation": "本局已接诗句。"})
        else:
            result.update({"answer": question.get("answer", "暂无标准答案"), "explanation": question.get("explanation", "")})
        return result

    def definitions(self, *, category: str = "", page: int = 1, page_size: int = 6) -> dict[str, Any]:
        selected = [item for item in GAME_DEFINITIONS if not category or item["category"] == category]
        page_size = max(1, min(int(page_size), 12))
        pages = max(1, math.ceil(len(selected) / page_size))
        page = max(1, min(int(page), pages))
        start = (page - 1) * page_size
        return {"category": category, "page": page, "pages": pages, "items": selected[start : start + page_size]}
