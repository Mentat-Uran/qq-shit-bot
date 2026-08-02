"""Invariant tests for conservative QQ proactive group participation."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, mock

from gateway.platforms.base import SendResult
from gateway.platforms.qqbot.proactive import (
    ParticipationDecision,
    ProactiveConfig,
    ProactiveGroupManager,
    parse_participation_decision,
)


def _event(group_id: str, message_id: str, text: str, *, user_id: str = "u1", is_bot: bool = False):
    source = SimpleNamespace(
        chat_id=group_id,
        user_id=user_id,
        user_name=user_id,
        chat_type="group",
        is_bot=is_bot,
    )
    return SimpleNamespace(
        source=source,
        message_id=message_id,
        text=text,
        raw_message={"author": {"bot": is_bot}},
        timestamp=datetime.now(timezone.utc),
        reply_to_message_id=None,
    )


def _config(**kwargs):
    values = dict(
        enabled=True,
        allowlist=("g1", "g2"),
        debounce_ms=1,
        min_reply_interval_seconds=0,
        max_bot_message_ratio=1.0,
        max_topic_interventions=10,
        max_consecutive_replies=10,
        min_human_messages_after_bot=0,
    )
    values.update(kwargs)
    return ProactiveConfig(**values)


async def _settle():
    await asyncio.sleep(0.03)


class TestDecisionParsing(IsolatedAsyncioTestCase):
    async def test_malformed_output_is_silent(self):
        self.assertEqual(parse_participation_decision("not json").action, "silent")
        self.assertEqual(
            parse_participation_decision(
                '{"action":"reply","confidence":0.99,"reason_code":"unknown"}'
            ).action,
            "silent",
        )

    async def test_fenced_json_and_join_are_supported(self):
        decision = parse_participation_decision(
            '```json\n{"action":"join","confidence":0.93,"reason_code":"topic_stalled"}\n```'
        )
        self.assertEqual(decision.action, "join")
        self.assertEqual(decision.reason_code, "topic_stalled")


class TestProactiveGroupManager(IsolatedAsyncioTestCase):
    async def test_allowlist_and_group_isolation(self):
        calls = []

        async def decide(_snapshot):
            calls.append(True)
            return ParticipationDecision(action="silent", confidence=0.99, reason_code="casual_social_exchange")

        manager = ProactiveGroupManager(_config(allowlist=("g1",)), decision_callback=decide)
        await manager.ingest(_event("g1", "m1", "甲消息"))
        await manager.ingest(_event("g2", "m2", "乙消息"))
        self.assertEqual([m.message_id for m in manager.snapshot_for("g1").messages], ["m1"])
        self.assertIsNone(manager.snapshot_for("g2"))
        await _settle()
        self.assertEqual(calls, [True])
        await manager.close()

    async def test_silent_and_wait_reconsider_on_later_message(self):
        decisions = iter([
            ParticipationDecision(action="silent", confidence=0.99, reason_code="casual_social_exchange"),
            ParticipationDecision(action="wait", confidence=0.99, reason_code="human_discussion_active"),
            ParticipationDecision(action="reply", confidence=0.99, reason_code="unanswered_question"),
        ])
        sent = []

        async def decide(_snapshot):
            return next(decisions)

        async def reply(_snapshot, _decision):
            return "可以补充这一点"

        async def send(snapshot, content, reply_to):
            sent.append((snapshot.group_id, content, reply_to))
            return SendResult(success=True, message_id="bot-1")

        manager = ProactiveGroupManager(
            _config(), decision_callback=decide, reply_callback=reply, send_callback=send
        )
        await manager.ingest(_event("g1", "m1", "闲聊"))
        await _settle()
        await manager.ingest(_event("g1", "m2", "有人问了一个问题"))
        await _settle()
        await manager.ingest(_event("g1", "m3", "问题仍然没有答案"))
        await _settle()
        self.assertEqual(sent, [("g1", "可以补充这一点", "m3")])
        await manager.close()

    async def test_context_change_cancels_inflight_reply(self):
        reply_started = asyncio.Event()
        reply_cancelled = asyncio.Event()
        gate = asyncio.Event()
        sent = []

        async def decide(_snapshot):
            return ParticipationDecision(action="reply", confidence=0.99, reason_code="unanswered_question")

        async def reply(_snapshot, _decision):
            reply_started.set()
            try:
                await gate.wait()
            except asyncio.CancelledError:
                reply_cancelled.set()
                raise
            return "过时的回答"

        async def send(*_args):
            sent.append(True)
            return SendResult(success=True, message_id="bot-1")

        manager = ProactiveGroupManager(
            _config(), decision_callback=decide, reply_callback=reply, send_callback=send
        )
        await manager.ingest(_event("g1", "m1", "原问题"))
        await asyncio.wait_for(reply_started.wait(), timeout=1)
        await manager.ingest(_event("g1", "m2", "补充了新信息"))
        await _settle()
        self.assertTrue(reply_cancelled.is_set())
        self.assertEqual(sent, [])
        await manager.close()

    async def test_duplicate_and_bot_messages_do_not_trigger_decision(self):
        calls = []

        async def decide(_snapshot):
            calls.append(True)
            return ParticipationDecision(action="reply", confidence=0.99, reason_code="unanswered_question")

        manager = ProactiveGroupManager(_config(), decision_callback=decide)
        await manager.ingest(_event("g1", "m1", "一次"))
        await manager.ingest(_event("g1", "m1", "重复"))
        await manager.ingest(_event("g1", "bot", "机器人", is_bot=True))
        await _settle()
        self.assertEqual(len(calls), 1)
        self.assertEqual([m.message_id for m in manager.snapshot_for("g1").messages], ["m1"])
        await manager.close()

    async def test_explicit_message_is_context_only(self):
        calls = []

        async def decide(_snapshot):
            calls.append(True)
            return ParticipationDecision(action="reply", confidence=0.99, reason_code="explicit_request")

        manager = ProactiveGroupManager(_config(), decision_callback=decide)
        await manager.ingest(_event("g1", "m1", "@机器人请回答"), explicit=True)
        await _settle()
        self.assertEqual(calls, [])
        self.assertEqual(manager.snapshot_for("g1").latest_message.text, "@机器人请回答")
        await manager.close()

    async def test_reply_can_be_sent_as_bounded_sequence(self):
        sent = []

        async def decide(_snapshot):
            return ParticipationDecision(
                action="reply",
                confidence=0.99,
                reason_code="unanswered_question",
            )

        async def reply(_snapshot, _decision):
            return "第一段\n第二段\n第三段\n第四段"

        async def send(_snapshot, content, reply_to):
            sent.append((content, reply_to))
            return SendResult(success=True, message_id=f"bot-{len(sent)}")

        manager = ProactiveGroupManager(
            _config(max_reply_messages=3),
            decision_callback=decide,
            reply_callback=reply,
            send_callback=send,
        )
        await manager.ingest(_event("g1", "m1", "有人问了一个问题"))
        await _settle()

        self.assertEqual(
            sent,
            [("第一段", "m1"), ("第二段", None), ("第三段 第四段", None)],
        )
        await manager.close()


class TestQQFullGroupEventRouting(IsolatedAsyncioTestCase):
    async def test_qq_mention_markup_is_removed_for_explicit_messages(self):
        from gateway.platforms.qqbot.adapter import QQAdapter

        self.assertEqual(
            QQAdapter._strip_at_mention("<@bot-openid> 请回答"),
            "请回答",
        )
        self.assertEqual(
            QQAdapter._strip_at_mention("@机器人 请回答"),
            "请回答",
        )

    async def test_raw_qq_mention_markup_uses_explicit_fallback(self):
        from gateway.config import PlatformConfig
        from gateway.platforms.qqbot.adapter import QQAdapter

        adapter = QQAdapter(
            PlatformConfig(enabled=True, extra={"app_id": "bot123", "client_secret": "b"})
        )
        adapter._handle_group_message = mock.AsyncMock()
        await adapter._on_message(
            "GROUP_MESSAGE_CREATE",
            {
                "id": "m-raw-at",
                "group_openid": "g1",
                "content": "<@bot-openid> 你好",
                "author": {"member_openid": "u1", "username": "甲"},
                "timestamp": "2026-08-02T00:00:00+00:00",
            },
        )

        self.assertFalse(adapter._handle_group_message.await_args.kwargs["full_message"])

    async def test_group_message_create_uses_full_mode(self):
        from gateway.config import PlatformConfig
        from gateway.platforms.qqbot.adapter import QQAdapter

        adapter = QQAdapter(PlatformConfig(enabled=True, extra={"app_id": "a", "client_secret": "b"}))
        adapter._handle_group_message = mock.AsyncMock()
        await adapter._on_message(
            "GROUP_MESSAGE_CREATE",
            {
                "id": "m-full",
                "group_openid": "g1",
                "content": "群聊内容",
                "author": {"member_openid": "u1", "username": "甲"},
                "timestamp": "2026-08-02T00:00:00+00:00",
            },
        )
        adapter._handle_group_message.assert_awaited_once()
        self.assertTrue(adapter._handle_group_message.await_args.kwargs["full_message"])

    async def test_full_group_event_with_at_uses_explicit_mode(self):
        from gateway.config import PlatformConfig
        from gateway.platforms.qqbot.adapter import QQAdapter

        adapter = QQAdapter(
            PlatformConfig(enabled=True, extra={"app_id": "bot123", "client_secret": "b"})
        )
        adapter._handle_group_message = mock.AsyncMock()
        await adapter._on_message(
            "GROUP_MESSAGE_CREATE",
            {
                "id": "m-at-full",
                "group_openid": "g1",
                "content": "@机器人 请回答",
                "author": {"member_openid": "u1", "username": "甲"},
                "timestamp": "2026-08-02T00:00:00+00:00",
            },
        )

        adapter._handle_group_message.assert_awaited_once()
        self.assertFalse(adapter._handle_group_message.await_args.kwargs["full_message"])

    async def test_late_at_event_recovers_after_full_context_event(self):
        from gateway.config import PlatformConfig
        from gateway.platforms.qqbot.adapter import QQAdapter

        adapter = QQAdapter(
            PlatformConfig(enabled=True, extra={"app_id": "bot123", "client_secret": "b"})
        )
        adapter._handle_group_message = mock.AsyncMock()
        payload = {
            "id": "m-at-late",
            "group_openid": "g1",
            "content": "请回答",
            "author": {"member_openid": "u1", "username": "甲"},
            "timestamp": "2026-08-02T00:00:00+00:00",
        }
        await adapter._on_message("GROUP_MESSAGE_CREATE", payload)
        await adapter._on_message(
            "GROUP_AT_MESSAGE_CREATE",
            {**payload, "content": "@机器人 请回答"},
        )

        self.assertEqual(adapter._handle_group_message.await_count, 2)
        self.assertTrue(adapter._handle_group_message.await_args_list[0].kwargs["full_message"])
        self.assertFalse(adapter._handle_group_message.await_args_list[1].kwargs["full_message"])
