import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInjectedQqbotContextPolicySource,
  qqbotContextSelectRelevantGroupHistory,
  QQBOT_CONTEXT_POLICY_MARKER,
} from "../../deploy/openclaw/qqbot-context-policy-core.mjs";

test("group history selection keeps a small recent tail and lexical matches", () => {
  const entries = [
    { senderId: "u1", content: "完全无关的闲聊" },
    { senderId: "u2", content: "OpenClaw context engine 的配置方式" },
    { senderId: "u3", content: "<@bot> 这是另一个已经被点名的话题" },
    { senderId: "u4", content: "最新的群聊消息" },
    { senderId: "u5", content: "最近也在讨论 context cache" },
  ];

  const selected = qqbotContextSelectRelevantGroupHistory(entries, "继续讨论 context cache");

  assert.deepEqual(selected.map((entry) => entry.senderId), ["u2", "u4", "u5"]);
  assert.equal(selected.some((entry) => entry.senderId === "u3"), false);
  assert.equal(selected[0].content, entries[1].content);
});

test("a content-free follow-up only receives the bounded non-mention tail", () => {
  const selected = qqbotContextSelectRelevantGroupHistory([
    { senderId: "u1", content: "第一条" },
    { senderId: "u2", content: "第二条" },
    { senderId: "u3", content: "第三条" },
    { senderId: "u4", content: "<@someone> 被点名的消息" },
  ], "");

  assert.deepEqual(selected.map((entry) => entry.senderId), ["u2", "u3"]);
});

test("history entries obey per-entry and aggregate character caps", () => {
  const selected = qqbotContextSelectRelevantGroupHistory([
    { senderId: "u1", content: "甲".repeat(1000) },
    { senderId: "u2", content: "乙".repeat(1000) },
    { senderId: "u3", content: "丙".repeat(1000) },
  ], "", {
    recentLimit: 3,
    matchLimit: 0,
    perEntryMaxChars: 10,
    totalMaxChars: 18,
  });

  assert.equal(selected.length, 2);
  assert.ok(selected.every((entry) => Array.from(entry.content).length <= 10));
  assert.ok(selected.reduce((total, entry) => total + Array.from(entry.content).length, 0) <= 18);
});

test("the bundle injection is self-contained and versioned", () => {
  const source = buildInjectedQqbotContextPolicySource();

  assert.match(source, new RegExp(QQBOT_CONTEXT_POLICY_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.match(source, /function qqbotContextSelectRelevantGroupHistory/);
  assert.doesNotMatch(source, /\b(?:import|export)\b/u);

  const injectedSelector = new Function(`${source}\nreturn qqbotContextSelectRelevantGroupHistory;`)();
  assert.deepEqual(
    injectedSelector([{ content: "old context" }, { content: "new unrelated" }], "context"),
    [{ content: "old context" }, { content: "new unrelated" }],
  );
});
