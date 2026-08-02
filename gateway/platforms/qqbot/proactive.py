"""Conservative, in-memory proactive participation for QQ group chats.

This module deliberately owns only the group-context/debounce/decision state.
The Gateway supplies model callbacks and the QQ adapter supplies delivery, so
the existing agent/provider path remains the source of truth for model calls.
No group transcript is written to disk here.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable, Deque, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)


PROACTIVE_ACTIONS = frozenset({"silent", "wait", "react", "reply", "join"})
PROACTIVE_REASON_CODES = frozenset({
    "explicit_request",
    "implicit_help_request",
    "unanswered_question",
    "useful_new_information",
    "useful_correction",
    "topic_stalled",
    "human_discussion_active",
    "answer_already_provided",
    "casual_social_exchange",
    "private_exchange",
    "insufficient_context",
    "bot_spoke_recently",
    "low_value_response",
})
_CORRECTION_REASON = "useful_correction"
_JSON_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.IGNORECASE | re.DOTALL)


def _safe_log_id(value: Any) -> str:
    """Return a short, non-reversible identifier for operational logs."""
    raw = str(value or "")
    if not raw:
        return ""
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:10]


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return default


def _as_int(value: Any, default: int, *, minimum: int = 0, maximum: int = 1_000_000) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def _as_float(value: Any, default: float, *, minimum: float = 0.0, maximum: float = 1_000_000.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def _as_list(value: Any) -> List[str]:
    if isinstance(value, str):
        value = value.replace("\n", ",").split(",")
    if not isinstance(value, (list, tuple, set)):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


@dataclass(frozen=True)
class ProactiveConfig:
    """Resolved QQ proactive settings from ``platforms.qqbot.extra``."""

    enabled: bool = False
    allowlist: tuple[str, ...] = ()
    blocklist: tuple[str, ...] = ()
    decision_model: str = ""
    reply_model: str = ""
    decision_threshold: float = 0.82
    correction_threshold: float = 0.92
    debounce_ms: int = 2_000
    min_reply_interval_seconds: float = 30.0
    context_message_limit: int = 40
    context_ttl_minutes: int = 15
    max_bot_message_ratio: float = 0.15
    max_topic_interventions: int = 1
    max_consecutive_replies: int = 1
    min_human_messages_after_bot: int = 3
    max_reply_messages: int = 3
    hourly_message_limit: int = 0
    daily_message_limit: int = 0
    ignore_other_bots: bool = True

    @classmethod
    def from_extra(cls, extra: Optional[Dict[str, Any]]) -> "ProactiveConfig":
        extra = extra if isinstance(extra, dict) else {}
        return cls(
            enabled=_as_bool(extra.get("proactive_group_chat_enabled"), False),
            allowlist=tuple(_as_list(
                extra.get("proactive_group_allowlist", extra.get("proactive_group_allow_from"))
            )),
            blocklist=tuple(_as_list(extra.get("proactive_group_blocklist"))),
            decision_model=str(extra.get("proactive_decision_model") or "").strip(),
            reply_model=str(extra.get("proactive_reply_model") or "").strip(),
            decision_threshold=_as_float(extra.get("proactive_decision_threshold"), 0.82, maximum=1.0),
            correction_threshold=_as_float(extra.get("proactive_correction_threshold"), 0.92, maximum=1.0),
            debounce_ms=_as_int(extra.get("proactive_debounce_ms"), 2_000, maximum=30_000),
            min_reply_interval_seconds=_as_float(
                extra.get("proactive_min_reply_interval_seconds"), 30.0, maximum=86_400.0
            ),
            context_message_limit=_as_int(
                extra.get("proactive_context_message_limit"), 40, minimum=5, maximum=100
            ),
            context_ttl_minutes=_as_int(
                extra.get("proactive_context_ttl_minutes"), 15, minimum=1, maximum=120
            ),
            max_bot_message_ratio=_as_float(
                extra.get("proactive_max_bot_message_ratio"), 0.15, maximum=1.0
            ),
            max_topic_interventions=_as_int(
                extra.get("proactive_max_topic_interventions"), 1, minimum=1, maximum=20
            ),
            max_consecutive_replies=_as_int(
                extra.get("proactive_max_consecutive_replies"), 1, minimum=1, maximum=20
            ),
            min_human_messages_after_bot=_as_int(
                extra.get("proactive_min_human_messages_after_bot"), 3, maximum=100
            ),
            max_reply_messages=_as_int(
                extra.get("proactive_max_reply_messages"), 3, minimum=1, maximum=5
            ),
            hourly_message_limit=_as_int(
                extra.get("proactive_hourly_message_limit"), 0, maximum=10_000
            ),
            daily_message_limit=_as_int(
                extra.get("proactive_daily_message_limit"), 0, maximum=100_000
            ),
            ignore_other_bots=_as_bool(extra.get("proactive_ignore_other_bots"), True),
        )

    def group_allowed(self, group_id: str) -> bool:
        normalized = str(group_id or "").strip().lower()
        allow = {item.lower() for item in self.allowlist}
        block = {item.lower() for item in self.blocklist}
        if normalized in block or "*" in block:
            return False
        # An explicit allowlist is required for the opt-in feature. ``*`` is
        # the documented way to opt all groups in.
        return bool(allow) and ("*" in allow or normalized in allow)


@dataclass(frozen=True)
class ProactiveMessage:
    message_id: str
    sender_id: str
    display_name: str
    timestamp: datetime
    text: str
    is_bot: bool = False
    reply_to_message_id: Optional[str] = None


@dataclass(frozen=True)
class ProactiveSnapshot:
    group_id: str
    version: int
    messages: tuple[ProactiveMessage, ...]
    latest_message: ProactiveMessage
    config: ProactiveConfig
    event: Any
    bot_message_at: float = 0.0
    topic_interventions: int = 0
    topic_id: str = ""


@dataclass(frozen=True)
class ParticipationDecision:
    action: str = "silent"
    confidence: float = 0.0
    reason_code: str = "insufficient_context"
    target_message_id: Optional[str] = None
    wait_ms: int = 0
    response_intent: Optional[str] = None

    @classmethod
    def silent(cls, reason_code: str = "insufficient_context") -> "ParticipationDecision":
        return cls(reason_code=reason_code if reason_code in PROACTIVE_REASON_CODES else "insufficient_context")


def parse_participation_decision(raw: Any) -> ParticipationDecision:
    """Validate a model result; malformed output always becomes SILENT."""
    if isinstance(raw, ParticipationDecision):
        return raw
    data: Any = raw
    if isinstance(raw, str):
        text = raw.strip()
        match = _JSON_FENCE_RE.match(text)
        if match:
            text = match.group(1).strip()
        try:
            data = json.loads(text)
        except (TypeError, ValueError):
            # Some providers add a short preamble. Extract only one JSON
            # object; the resulting object is still validated below.
            start, end = text.find("{"), text.rfind("}")
            if start < 0 or end <= start:
                return ParticipationDecision.silent()
            try:
                data = json.loads(text[start : end + 1])
            except (TypeError, ValueError):
                return ParticipationDecision.silent()

    if not isinstance(data, dict):
        return ParticipationDecision.silent()
    action = str(data.get("action") or "").strip().lower()
    reason_code = str(data.get("reason_code") or "").strip().lower()
    try:
        confidence = float(data.get("confidence"))
    except (TypeError, ValueError):
        return ParticipationDecision.silent()
    if action not in PROACTIVE_ACTIONS or not 0.0 <= confidence <= 1.0:
        return ParticipationDecision.silent()
    if reason_code not in PROACTIVE_REASON_CODES:
        return ParticipationDecision.silent()

    target = data.get("target_message_id")
    if target is not None and (not isinstance(target, str) or not target.strip() or len(target) > 256):
        return ParticipationDecision.silent()
    intent = data.get("response_intent")
    if intent is not None and (not isinstance(intent, str) or len(intent) > 600):
        return ParticipationDecision.silent()
    wait_ms = _as_int(data.get("wait_ms"), 0, maximum=30_000)
    return ParticipationDecision(
        action=action,
        confidence=confidence,
        reason_code=reason_code,
        target_message_id=target.strip() if isinstance(target, str) else None,
        wait_ms=wait_ms,
        response_intent=intent.strip() if isinstance(intent, str) else None,
    )


def format_proactive_context(snapshot: ProactiveSnapshot) -> str:
    """Render bounded, non-sensitive context for either model stage."""
    lines: List[str] = []
    for message in snapshot.messages:
        speaker = "机器人" if message.is_bot else (message.display_name or "群友")
        text = message.text.strip() or "[空消息/不可解析内容]"
        text = text[:800]
        suffix = f" [引用:{message.reply_to_message_id[:12]}]" if message.reply_to_message_id else ""
        lines.append(f"- {speaker}: {text}{suffix}")
    return "\n".join(lines)


@dataclass
class _GroupState:
    messages: Deque[ProactiveMessage] = field(default_factory=deque)
    seen_message_ids: Dict[str, float] = field(default_factory=dict)
    task: Optional[asyncio.Task] = None
    version: int = 0
    last_bot_message_at: float = 0.0
    human_messages_after_bot: int = 0
    topic_interventions: int = 0
    consecutive_replies: int = 0
    sent_at: Deque[float] = field(default_factory=deque)
    last_reason_code: Optional[str] = None
    latest_event: Any = None
    topic_id: str = ""


DecisionCallback = Callable[[ProactiveSnapshot], Awaitable[Any]]
ReplyCallback = Callable[[ProactiveSnapshot, ParticipationDecision], Awaitable[Optional[str]]]
SendCallback = Callable[[ProactiveSnapshot, str, Optional[str]], Awaitable[Any]]


class ProactiveGroupManager:
    """Per-group state machine for debounced autonomous participation."""

    def __init__(
        self,
        config: ProactiveConfig,
        *,
        decision_callback: Optional[DecisionCallback] = None,
        reply_callback: Optional[ReplyCallback] = None,
        send_callback: Optional[SendCallback] = None,
    ) -> None:
        self.config = config
        self._decision_callback = decision_callback
        self._reply_callback = reply_callback
        self._send_callback = send_callback
        self._states: Dict[str, _GroupState] = {}
        self._closed = False
        self._last_missing_callback_log = 0.0

    def set_callbacks(
        self,
        *,
        decision_callback: Optional[DecisionCallback],
        reply_callback: Optional[ReplyCallback],
        send_callback: Optional[SendCallback] = None,
    ) -> None:
        self._decision_callback = decision_callback
        self._reply_callback = reply_callback
        if send_callback is not None:
            self._send_callback = send_callback

    def status(self) -> Dict[str, Any]:
        return {
            "enabled": self.config.enabled,
            "allowlist_configured": bool(self.config.allowlist),
            "callbacks_configured": bool(self._decision_callback and self._reply_callback and self._send_callback),
            "group_states": len(self._states),
            "context_persistence": "memory_only",
        }

    def snapshot_for(self, group_id: str) -> Optional[ProactiveSnapshot]:
        state = self._states.get(str(group_id))
        if state is None or not state.messages:
            return None
        return self._snapshot(str(group_id), state, state.messages[-1], state.version)

    async def ingest(self, event: Any, *, explicit: bool = False) -> bool:
        """Record one normalized group event and optionally schedule a decision."""
        if self._closed:
            return False
        source = getattr(event, "source", None)
        group_id = str(getattr(source, "chat_id", "") or "")
        message_id = str(getattr(event, "message_id", "") or "")
        if not group_id or not message_id:
            return False
        if not explicit and self.config.enabled and not self.config.group_allowed(group_id):
            logger.info("QQ proactive blocked by group allow/block list group=%s", _safe_log_id(group_id))
            return False

        raw = getattr(event, "raw_message", None)
        author = raw.get("author") if isinstance(raw, dict) else {}
        is_bot = bool(
            getattr(source, "is_bot", False)
            or (isinstance(author, dict) and author.get("bot"))
        )
        if is_bot and self.config.ignore_other_bots:
            logger.debug("QQ proactive ignored bot message group=%s", _safe_log_id(group_id))
            return False

        state = self._states.setdefault(group_id, _GroupState())
        now = time.time()
        self._prune(state, now)
        if message_id in state.seen_message_ids:
            logger.debug("QQ proactive message deduplicated group=%s", _safe_log_id(group_id))
            return False
        state.seen_message_ids[message_id] = now

        text = str(getattr(event, "text", "") or "").strip()[:800]
        sender_id = str(getattr(source, "user_id", "") or "")
        display_name = str(getattr(source, "user_name", "") or "").strip()[:80]
        message = ProactiveMessage(
            message_id=message_id,
            sender_id=sender_id,
            display_name=display_name,
            timestamp=getattr(event, "timestamp", None) or datetime.now().astimezone(),
            text=text,
            is_bot=is_bot,
            reply_to_message_id=getattr(event, "reply_to_message_id", None),
        )
        state.messages.append(message)
        if not state.topic_id:
            state.topic_id = _safe_log_id(f"{group_id}:{message_id}")
        state.latest_event = event
        state.version += 1
        if not is_bot:
            state.human_messages_after_bot += 1
        self._prune(state, now)
        logger.info(
            "QQ proactive group message received group=%s version=%d explicit=%s",
            _safe_log_id(group_id), state.version, explicit,
        )

        if explicit or not self.config.enabled:
            return True
        self._cancel_task(group_id, state, reason="new_message")
        state.task = asyncio.create_task(self._run_debounced(group_id, state, state.version))
        return True

    def record_bot_message(
        self,
        group_id: str,
        text: str,
        message_id: Optional[str] = None,
        *,
        count_as_intervention: bool = True,
    ) -> None:
        """Add the bot's own successful send to ratio/cooldown state."""
        if self._closed or not group_id:
            return
        state = self._states.setdefault(str(group_id), _GroupState())
        now = time.time()
        self._prune(state, now)
        state.messages.append(
            ProactiveMessage(
                message_id=str(message_id or f"bot-{int(now * 1000)}"),
                sender_id="",
                display_name="机器人",
                timestamp=datetime.now().astimezone(),
                text=str(text or "")[:800],
                is_bot=True,
            )
        )
        state.version += 1
        state.last_bot_message_at = now
        if count_as_intervention:
            state.human_messages_after_bot = 0
            state.consecutive_replies += 1
            state.topic_interventions += 1
        state.sent_at.append(now)
        self._prune(state, now)

    async def close(self) -> None:
        self._closed = True
        tasks = []
        for state in self._states.values():
            if state.task is not None and not state.task.done():
                state.task.cancel()
                tasks.append(state.task)
            state.task = None
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._states.clear()

    def _cancel_task(self, group_id: str, state: _GroupState, *, reason: str) -> None:
        task = state.task
        if task is not None and not task.done():
            task.cancel()
            logger.info(
                "QQ proactive task cancelled group=%s reason=%s",
                _safe_log_id(group_id), reason,
            )
        state.task = None

    def _prune(self, state: _GroupState, now: float) -> None:
        ttl = self.config.context_ttl_minutes * 60
        while state.messages and (now - state.messages[0].timestamp.timestamp()) > ttl:
            state.messages.popleft()
        while len(state.messages) > self.config.context_message_limit:
            state.messages.popleft()
        # A new context window starts after the previous bot turn expires.
        # Keep hourly/daily send counters, but do not let an old topic's
        # intervention/consecutive-reply limits suppress the next topic.
        if state.last_bot_message_at and now - state.last_bot_message_at > ttl:
            state.last_bot_message_at = 0.0
            state.human_messages_after_bot = 0
            state.topic_interventions = 0
            state.consecutive_replies = 0
            state.topic_id = ""
        cutoff = now - max(ttl, 3600.0)
        state.seen_message_ids = {
            key: seen for key, seen in state.seen_message_ids.items() if seen >= cutoff
        }
        while state.sent_at and state.sent_at[0] < now - 86_400:
            state.sent_at.popleft()

    def _snapshot(
        self,
        group_id: str,
        state: _GroupState,
        latest: ProactiveMessage,
        version: int,
    ) -> ProactiveSnapshot:
        event = getattr(state, "latest_event", None) or getattr(latest, "event", None)
        # The event is stored separately because the context item is sanitized
        # for prompt use while the callback still needs the original metadata.
        event = getattr(state, "event", None) or event
        return ProactiveSnapshot(
            group_id=group_id,
            version=version,
            messages=tuple(state.messages),
            latest_message=latest,
            config=self.config,
            event=event,
            bot_message_at=state.last_bot_message_at,
            topic_interventions=state.topic_interventions,
            topic_id=state.topic_id,
        )

    def _make_snapshot(self, group_id: str, state: _GroupState, version: int) -> Optional[ProactiveSnapshot]:
        if state.version != version or not state.messages:
            return None
        latest = state.messages[-1]
        event = getattr(state, "latest_event", None)
        snapshot = ProactiveSnapshot(
            group_id=group_id,
            version=version,
            messages=tuple(state.messages),
            latest_message=latest,
            config=self.config,
            event=event,
            bot_message_at=state.last_bot_message_at,
            topic_interventions=state.topic_interventions,
            topic_id=state.topic_id,
        )
        return snapshot

    async def _run_debounced(self, group_id: str, state: _GroupState, version: int) -> None:
        current_task = asyncio.current_task()
        try:
            await asyncio.sleep(self.config.debounce_ms / 1000.0)
            if state.version != version or not state.messages:
                return
            if not self._programmatic_allow(state):
                return
            snapshot = self._make_snapshot(group_id, state, version)
            if snapshot is None or self._decision_callback is None:
                now = time.monotonic()
                if now - self._last_missing_callback_log > 60:
                    logger.warning("QQ proactive unavailable: decision callback is not configured")
                    self._last_missing_callback_log = now
                return
            started = time.monotonic()
            try:
                raw_decision = await self._decision_callback(snapshot)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("QQ proactive decision failed group=%s", _safe_log_id(group_id), exc_info=True)
                raw_decision = None
            decision = parse_participation_decision(raw_decision)
            state.last_reason_code = decision.reason_code
            logger.info(
                "QQ proactive decision group=%s action=%s confidence=%.2f reason=%s elapsed_ms=%d",
                _safe_log_id(group_id), decision.action, decision.confidence,
                decision.reason_code, int((time.monotonic() - started) * 1000),
            )
            if state.version != version:
                logger.info("QQ proactive decision discarded after context change group=%s", _safe_log_id(group_id))
                return
            if not self._decision_allows_reply(state, decision):
                return
            if decision.action == "react":
                logger.info("QQ proactive REACT downgraded to SILENT; QQ reaction is not configured")
                return
            if self._reply_callback is None or self._send_callback is None:
                return

            reply_started = time.monotonic()
            try:
                candidate = await self._reply_callback(snapshot, decision)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("QQ proactive reply generation failed group=%s", _safe_log_id(group_id), exc_info=True)
                return
            logger.info(
                "QQ proactive reply model elapsed_ms=%d group=%s",
                int((time.monotonic() - reply_started) * 1000), _safe_log_id(group_id),
            )
            if state.version != version:
                logger.info("QQ proactive reply discarded after context change group=%s", _safe_log_id(group_id))
                return
            candidate = str(candidate or "").strip()
            if not candidate:
                return
            reply_messages = self._split_reply_messages(
                candidate, self.config.max_reply_messages
            )
            if not reply_messages:
                return
            target = decision.target_message_id
            if decision.action == "reply" and not target:
                target = snapshot.latest_message.message_id
            if decision.action == "reply" and target not in {item.message_id for item in snapshot.messages}:
                logger.info("QQ proactive reply target is outside current context group=%s", _safe_log_id(group_id))
                return
            for index, reply_message in enumerate(reply_messages):
                if state.version != version:
                    logger.info(
                        "QQ proactive reply sequence discarded after context change group=%s",
                        _safe_log_id(group_id),
                    )
                    return
                reply_target = (
                    target
                    if index == 0 and decision.action == "reply"
                    else None
                )
                try:
                    result = await self._send_callback(
                        snapshot, reply_message, reply_target
                    )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.warning(
                        "QQ proactive QQ API send failed group=%s",
                        _safe_log_id(group_id),
                        exc_info=True,
                    )
                    return
                if result is not None and getattr(result, "success", result is not False):
                    self.record_bot_message(
                        group_id,
                        reply_message,
                        getattr(result, "message_id", None),
                        count_as_intervention=index == 0,
                    )
                    # Recording our own sent message also advances the local
                    # state version.  Carry that internal version forward;
                    # a later human message will advance it again and still
                    # invalidate the remaining sequence.
                    version = state.version
                    logger.info(
                        "QQ proactive message sent group=%s action=%s reason=%s part=%d/%d",
                        _safe_log_id(group_id),
                        decision.action,
                        decision.reason_code,
                        index + 1,
                        len(reply_messages),
                    )
                else:
                    logger.warning(
                        "QQ proactive QQ API rejected message group=%s",
                        _safe_log_id(group_id),
                    )
                    return
        except asyncio.CancelledError:
            return
        finally:
            if state.task is current_task:
                state.task = None

    def _programmatic_allow(self, state: _GroupState) -> bool:
        now = time.time()
        if state.last_bot_message_at and now - state.last_bot_message_at < self.config.min_reply_interval_seconds:
            logger.info("QQ proactive blocked by cooldown")
            return False
        if state.human_messages_after_bot < self.config.min_human_messages_after_bot and state.last_bot_message_at:
            logger.info("QQ proactive blocked until more human messages arrive")
            return False
        if state.consecutive_replies >= self.config.max_consecutive_replies:
            logger.info("QQ proactive blocked by consecutive reply limit")
            return False
        if state.topic_interventions >= self.config.max_topic_interventions:
            logger.info("QQ proactive blocked by topic intervention limit")
            return False
        if self.config.hourly_message_limit and sum(ts >= now - 3600 for ts in state.sent_at) >= self.config.hourly_message_limit:
            logger.info("QQ proactive blocked by hourly message limit")
            return False
        if self.config.daily_message_limit and len(state.sent_at) >= self.config.daily_message_limit:
            logger.info("QQ proactive blocked by daily message limit")
            return False
        total = len(state.messages)
        bot_count = sum(message.is_bot for message in state.messages)
        if total and bot_count / total > self.config.max_bot_message_ratio:
            logger.info("QQ proactive blocked by bot message ratio")
            return False
        return True

    def _decision_allows_reply(self, state: _GroupState, decision: ParticipationDecision) -> bool:
        if decision.action not in {"reply", "join"}:
            return False
        threshold = (
            self.config.correction_threshold
            if decision.reason_code == _CORRECTION_REASON
            else self.config.decision_threshold
        )
        if decision.confidence < threshold:
            logger.info("QQ proactive blocked by confidence threshold reason=%s", decision.reason_code)
            return False
        return True

    @staticmethod
    def _split_reply_messages(candidate: str, maximum: int) -> List[str]:
        """Split a bounded model reply into a small sequence of messages."""
        lines = [line.strip() for line in str(candidate or "").splitlines() if line.strip()]
        if not lines:
            return []
        maximum = max(1, int(maximum or 1))
        if len(lines) <= maximum:
            return lines
        return lines[: maximum - 1] + [" ".join(lines[maximum - 1 :])]
