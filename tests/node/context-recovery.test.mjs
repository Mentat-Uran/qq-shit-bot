import test from "node:test";
import assert from "node:assert/strict";
import { RecoveryState, isRecoverableGroupSession } from "../../deploy/openclaw/context-recovery-core.mjs";

test("context recovery resets only valid group sessions and gates duplicates", () => {
  let now = 1000;
  const state = new RecoveryState({ now: () => now, resetCooldownMs: 100 });
  assert.equal(isRecoverableGroupSession("agent:main:qqbot:group:g1"), true);
  assert.equal(isRecoverableGroupSession("agent:main:qqbot:dm:u1"), false);
  assert.equal(state.handleLine("context overflow detected sessionKey=agent:main:qqbot:dm:u1"), null);
  const key = "agent:main:qqbot:group:g1";
  assert.equal(state.handleLine(`context overflow detected sessionKey=${key}`), key);
  assert.equal(state.handleLine(`context overflow detected sessionKey=${key}`), null);
  state.completeReset(key);
  now += 50;
  assert.equal(state.handleLine(`stalled session: state=processing sessionKey=${key}`), null);
  now += 60;
  assert.equal(state.handleLine(`stalled session: state=processing sessionKey=${key}`), key);
});

test("pending overflow evidence expires before a later diagnostic", () => {
  let now = 0;
  const state = new RecoveryState({ now: () => now, pendingTtlMs: 10 });
  const key = "agent:main:qqbot:group:g2";
  assert.equal(state.handleLine(`context-overflow-precheck sessionKey=${key}`), null);
  now = 11;
  assert.equal(state.handleLine("context overflow detected"), null);
});
