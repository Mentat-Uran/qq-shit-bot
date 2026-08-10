import test from "node:test";
import assert from "node:assert/strict";
import { shouldSuppressQQPayload } from "../../deploy/openclaw/diagnostic-policy.mjs";

test("diagnostics are suppressed only at the QQ delivery boundary", () => {
  assert.deepEqual(
    shouldSuppressQQPayload({ channel: "qqbot", sessionKey: "agent:main:qqbot:group:g1", payload: { isError: true } }),
    { suppress: true, reason: "qqbot_group_diagnostic_suppressed" },
  );
  assert.equal(shouldSuppressQQPayload({ channel: "qqbot", sessionKey: "agent:main:qqbot:group:g1", payload: { text: "A normal answer" } }).suppress, false);
  assert.equal(shouldSuppressQQPayload({ channel: "other", sessionKey: "agent:main:qqbot:group:g1", payload: { isError: true } }).suppress, false);
});

test("English process preambles are suppressed without suppressing Chinese replies", () => {
  const preamble = shouldSuppressQQPayload({
    channel: "qqbot",
    sessionKey: "agent:main:qqbot:group:g1",
    payload: { text: "Let me inspect the image first" },
  });
  assert.deepEqual(preamble, { suppress: true, reason: "qqbot_process_preamble_suppressed" });
  assert.equal(shouldSuppressQQPayload({ channel: "qqbot", sessionKey: "agent:main:qqbot:group:g1", payload: { text: "我先看看图片" } }).suppress, false);
});
