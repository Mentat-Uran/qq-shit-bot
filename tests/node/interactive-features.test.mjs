import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  buildInteractiveFeaturesSource,
  patchBundle,
} from "../../deploy/openclaw/qqbot-interactive-features-patch.mjs";

function loadInteractiveHelpers() {
  const sent = [];
  const gateway = {
    bot: {
      sendText: async (...args) => sent.push(args),
      sendTextWithKeyboard: async (...args) => sent.push(args),
    },
  };
  const context = {
    AbortSignal,
    console,
    fetch: async () => {
      throw new Error("fetch is not used by this unit test");
    },
    getGateway: () => gateway,
    process: { env: { QQBOT_GAME_SERVICE_URL: "http://127.0.0.1:18104" } },
    sent,
  };
  const source = buildInteractiveFeaturesSource();
  vm.runInNewContext(
    `${source}\nthis.__qqbotInteractiveTest = { command: qqbotInteractiveCommand, keyboard: qqbotInteractiveMenuKeyboard, startText: qqbotInteractiveGameStartText, readRequest: qqbotInteractiveReadRequest, applyTtsStyle: qqbotInteractiveApplyTtsStyle, hasVoiceTranscript: qqbotInteractiveHasSuccessfulVoiceTranscript, forceVoiceReply: qqbotInteractiveForceVoiceReply, handleInbound: qqbotInteractiveHandleInbound, handleInteraction: qqbotInteractiveHandleInteraction, sent };`,
    context,
  );
  return context.__qqbotInteractiveTest;
}

test("game commands coexist with read-aloud commands", () => {
  const helpers = loadInteractiveHelpers();

  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("开始海龟汤 日常"))), { kind: "game-start", theme: "日常" });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("提示"))), { kind: "game-hint" });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("查看进度"))), { kind: "game-status" });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("放弃"))), { kind: "game-end" });
  assert.equal(helpers.command("读：请用温柔的语气说这句话"), null);
  assert.equal(helpers.command("温柔读：你好"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("这是一个普通问题"))), { kind: "game-question", text: "这是一个普通问题" });
});

test("QQ menu exposes reading-tone and turtle-soup buttons without voice mode", () => {
  const helpers = loadInteractiveHelpers();
  const buttons = helpers.keyboard().content.rows.flatMap((row) => row.buttons);
  const buttonData = buttons.map((button) => button.action.data);

  assert.deepEqual(JSON.parse(JSON.stringify(buttonData)), [
    "qqbot:tts:tone:gentle",
    "qqbot:tts:tone:broadcast",
    "qqbot:tts:tone:dramatic",
    "qqbot:tts:tone:normal",
    "qqbot:tts:tone:status",
    "qqbot:game:menu",
    "qqbot:game:start",
    "qqbot:game:end",
  ]);
  const source = buildInteractiveFeaturesSource();
  assert.doesNotMatch(source, /qqbotInteractiveVoiceModes|qqbot:voice:/);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.readRequest("读：你好"))), { explicitStyle: null });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.readRequest("温柔读：你好"))), { explicitStyle: "温柔" });
  const styled = { agentBody: "base" };
  helpers.applyTtsStyle(styled, { state: { qqbotInteractiveTtsRequest: true, qqbotInteractiveTtsStyle: "gentle" } });
  assert.match(styled.agentBody, /语气:温柔/);
  const ordinary = { agentBody: "base" };
  helpers.applyTtsStyle(ordinary, { state: { qqbotInteractiveTtsRequest: false } });
  assert.equal(ordinary.agentBody, "base");
  const voiceReply = { agentBody: "base" };
  helpers.applyTtsStyle(voiceReply, { state: { qqbotInteractiveVoiceReply: true, qqbotInteractiveTtsStyle: "broadcast" } });
  assert.match(voiceReply.agentBody, /QQ voice reply tone instruction/);
  assert.match(voiceReply.agentBody, /语气：播音/);
  assert.match(
    helpers.startText({ title: "闹钟", surface: "汤面", notice: "自动回退", percent: 0 }),
    /自动回退/,
  );
  assert.match(source, /默认题库20道；同一群本轮不重复/);
});

test("successful inbound voice transcripts force only the final text reply to native voice", () => {
  const helpers = loadInteractiveHelpers();

  assert.equal(
    helpers.hasVoiceTranscript({ state: { processedAttachments: { transcripts: [{ source: "stt", text: "  你好  " }] } } }),
    true,
  );
  assert.equal(
    helpers.hasVoiceTranscript({ state: { processedAttachments: { transcripts: [{ source: "fallback", text: "[Voice message - transcription failed]" }] } } }),
    false,
  );
  assert.equal(helpers.hasVoiceTranscript({ state: { processedAttachments: { transcripts: [] } } }), false);

  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.forceVoiceReply({ text: "回答" }, { kind: "final" }, { autoVoiceReply: true }))),
    { text: "回答", audioAsVoice: true },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.forceVoiceReply({ text: "中间状态" }, { kind: "tool" }, { autoVoiceReply: true }))),
    { text: "中间状态" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.forceVoiceReply({ text: "图片说明", mediaUrl: "https://example.invalid/image" }, { kind: "final" }, { autoVoiceReply: true }))),
    { text: "图片说明", mediaUrl: "https://example.invalid/image" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.forceVoiceReply({ text: "普通文字" }, { kind: "final" }, { autoVoiceReply: false }))),
    { text: "普通文字" },
  );
});

test("inbound handling records the successful transcript as the one-turn voice-reply intent", async () => {
  const helpers = loadInteractiveHelpers();
  const account = { accountId: "account-1" };
  await helpers.handleInteraction(
    {
      id: "interaction-1",
      group_openid: "group-1",
      data: { resolved: { button_data: "qqbot:tts:tone:broadcast", message_id: "message-1" } },
    },
    account,
    {},
    async () => {},
  );
  const ctx = {
    state: {
      processedAttachments: {
        transcripts: [{ source: "stt", text: "请介绍一下今天的安排" }],
      },
    },
  };
  const handled = await helpers.handleInbound(
    ctx,
    { content: "", replyTarget: { scope: "group", targetId: "group-1" } },
    account,
    {},
  );
  assert.equal(handled, false);
  assert.equal(ctx.state.qqbotInteractiveVoiceReply, true);
  assert.equal(ctx.state.qqbotInteractiveTtsStyle, "broadcast");
});

test("reading-tone button selection is scoped and affects explicit TTS and voice replies", async () => {
  const helpers = loadInteractiveHelpers();
  const event = (buttonData) => ({
    id: "interaction-1",
    group_openid: "group-1",
    data: { resolved: { button_data: buttonData, message_id: "message-1" } },
  });
  const account = { accountId: "account-1" };
  const acknowledge = async () => {};

  await helpers.handleInteraction(event("qqbot:tts:tone:dramatic"), account, {}, acknowledge);
  await helpers.handleInteraction(event("qqbot:tts:tone:status"), account, {}, acknowledge);
  assert.match(helpers.sent.at(-1)[1], /当前群聊朗读语调：「戏剧」/);
  assert.match(helpers.sent[0][1], /普通文字回复仍然是文字/);
});

function createBundleFixture(legacyMarker = "") {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-interactive-features-test-"));
  const fixturePath = path.join(fixtureDir, "index.cjs");
  const legacyBlock = legacyMarker
    ? legacyMarker + "\nconst legacyInteractiveHelper = true;\n"
    : "";
  const fixtureSource = legacyBlock +
    "function historyBuffer(options = {}) {\n}\n" +
    "async function handleMessage(ctx, msg, account, runtime2, log4) {\n" +
    "  const hlog = log4.child(\"handle\");\n" +
    "}\n" +
    "async function handleInteraction(event, account, runtime2, log4, acknowledgeInteraction) {\n" +
    "}\n" +
    "async function deliverReply(payload, _info, ctx) {\n" +
    "}\n" +
    "function dispatchToOpenClaw() {\n" +
    "  const agentAssembled = imageGenerationRequest\n" +
    "    ? qqbotOverlayPrepareImageGenerationAssembled(assembled)\n" +
    "    : assembled;\n" +
    "  const deliverCtx = {\n" +
    "    log: log4?.child(\"deliver\"),\n" +
    "    agentId: route.agentId ?? \"default\"\n" +
    "  };\n" +
    "}\n";
  fs.writeFileSync(fixturePath, fixtureSource, "utf8");
  return { fixtureDir, fixturePath };
}

test("bundle patch applies to fresh and legacy fixtures, then stays idempotent", () => {
  for (const legacyMarker of ["", "/* qqbot-interactive-features-v2 */"]) {
    const { fixtureDir, fixturePath } = createBundleFixture(legacyMarker);
    try {
      assert.equal(patchBundle(fixturePath), true);
      const patched = fs.readFileSync(fixturePath, "utf8");
      assert.match(patched, /qqbot-interactive-features-v5/);
      assert.doesNotMatch(patched, /qqbot-interactive-features-v2/);
      assert.equal((patched.match(/qqbotInteractiveHandleInbound/g) || []).length, 2);
      assert.equal((patched.match(/qqbotInteractiveForceVoiceReply/g) || []).length, 2);
      assert.equal(patchBundle(fixturePath), false);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
});
