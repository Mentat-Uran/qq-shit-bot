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

function loadInteractiveHelpers(fetchImpl = async () => {
  throw new Error("fetch is not used by this unit test");
}) {
  const sent = [];
  const fetchCalls = [];
  const gateway = {
    bot: {
      sendText: async (...args) => sent.push(args),
      sendTextWithKeyboard: async (...args) => sent.push(args),
    },
  };
  const context = {
    AbortSignal,
    console,
    fetch: async (...args) => {
      fetchCalls.push(args);
      return fetchImpl(...args);
    },
    getGateway: () => gateway,
    process: { env: { QQBOT_GAME_SERVICE_URL: "http://127.0.0.1:18104" } },
    sent,
    fetchCalls,
  };
  const source = buildInteractiveFeaturesSource();
  vm.runInNewContext(
    `${source}\nthis.__qqbotInteractiveTest = { command: qqbotInteractiveCommand, keyboard: qqbotInteractiveMenuKeyboard, startText: qqbotInteractiveGameStartText, turnText: qqbotInteractiveGameTurnText, questionSummary: qqbotInteractiveQuestionSummary, statusText: qqbotInteractiveGameStatusText, chatStartText: qqbotInteractiveChatGameStartText, chatTurnText: qqbotInteractiveChatGameTurnText, questionerId: qqbotInteractiveQuestionerId, handleGameAction: qqbotInteractiveHandleGameAction, readRequest: qqbotInteractiveReadRequest, applyTtsStyle: qqbotInteractiveApplyTtsStyle, hasVoiceTranscript: qqbotInteractiveHasSuccessfulVoiceTranscript, forceVoiceReply: qqbotInteractiveForceVoiceReply, handleInbound: qqbotInteractiveHandleInbound, handleInteraction: qqbotInteractiveHandleInteraction, sent, fetchCalls };`,
    context,
  );
  return context.__qqbotInteractiveTest;
}

test("game commands coexist with read-aloud commands", () => {
  const helpers = loadInteractiveHelpers();

  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("开始海龟汤 日常"))), { kind: "game-start", theme: "日常" });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("开始海龟汤：悬疑惊悚恐怖"))), { kind: "game-start", theme: "悬疑惊悚恐怖" });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("开始成语接龙"))), { kind: "chat-game-start", game: "idiom-chain", mode: "same" });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("开始成语接龙 同音"))), { kind: "chat-game-start", game: "idiom-chain", mode: "同音" });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("猜成语"))), { kind: "chat-game-start", game: "idiom-wordle", mode: "same" });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("成语接龙"))), { kind: "game-help" });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("提示"))), { kind: "game-hint" });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("查看进度"))), { kind: "game-status" });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("放弃"))), { kind: "game-end" });
  assert.equal(helpers.command("读：请用温柔的语气说这句话"), null);
  assert.equal(helpers.command("温柔读：你好"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.command("这是一个普通问题"))), { kind: "game-question", text: "这是一个普通问题" });
});

test("QQ menu exposes reading-tone and chat-game buttons without voice mode", () => {
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
    "qqbot:game:idiom-chain",
    "qqbot:game:idiom-wordle",
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
  assert.match(
    helpers.turnText({ reply: "是", question: "这是故意的吗？", questioner_id: "user-openid-123", percent: 12, questions_asked: 1, max_questions: 50 }),
    /❓问题：这是故意的吗？/,
  );
  assert.doesNotMatch(
    helpers.turnText({ reply: "是", question: "这是故意的吗？", questioner_id: "user-openid-123", percent: 12, questions_asked: 1, max_questions: 50 }),
    /提问者ID|user-openid-123/,
  );
  assert.equal(helpers.questionSummary("第一行\n第二行"), "第一行 第二行");
  assert.equal(Array.from(helpers.questionSummary("问题".repeat(50))).length, 80);
  assert.equal(helpers.questionerId({ scope: "group", targetId: "group-1", actorId: "user-1" }), "user-1");
  assert.equal(helpers.questionerId({ scope: "group", targetId: "group-1", actorId: "group-1" }), "anonymous");
  const turtleStart = helpers.startText({ title: "会泄露答案的标题", surface: "只有汤面", notice: "", percent: 0 });
  assert.match(turtleStart, /只有汤面/);
  assert.doesNotMatch(turtleStart, /会泄露答案的标题|未命名题目/);
  const turtleStatus = helpers.statusText({ title: "会泄露答案的标题", surface: "只有汤面", percent: 12, questions_asked: 1, max_questions: 50 });
  assert.match(turtleStatus, /只有汤面/);
  assert.doesNotMatch(turtleStatus, /会泄露答案的标题|未命名题目/);
  assert.match(helpers.chatStartText({ game_type: "idiom-chain", mode_label: "同字接龙", current_word: "一心一意", target_char: "意", chain_length: 1, max_rounds: 30 }), /成语接龙/);
  assert.match(helpers.chatTurnText({ game_type: "idiom-wordle", accepted: true, word: "一心一心", marks: ["correct", "correct", "present", "absent"], remaining: 9, player: "甲" }), /一🟩/);
  assert.match(source, /默认题库50道（含30道悬疑\/惊悚\/恐怖原创题）/);
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

test("turtle-soup answers carry the current question summary instead of a sender ID", async () => {
  const helpers = loadInteractiveHelpers(async (url) => {
    if (url.endsWith("/v1/chat-games/input")) {
      return { status: 404, json: async () => ({}) };
    }
    return {
      status: 200,
      json: async () => ({ ok: true, reply: "是", question: "这是故意的吗？", questioner_id: "user-1", percent: 10 }),
    };
  });
  const target = { scope: "group", targetId: "group-1", actorId: "user-1", actorName: "甲" };

  await helpers.handleGameAction({ kind: "game-question", text: "这是故意的吗？" }, target, { accountId: "account-1" }, {});

  assert.equal(helpers.fetchCalls.length, 2);
  assert.deepEqual(JSON.parse(helpers.fetchCalls[1][1].body), {
    session_id: "account-1:group:group-1",
    text: "这是故意的吗？",
  });
  assert.match(helpers.sent.at(-1)[1], /❓问题：这是故意的吗？/);
  assert.doesNotMatch(helpers.sent.at(-1)[1], /提问者ID|user-1/);
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
  for (const legacyMarker of ["", "/* qqbot-interactive-features-v2 */", "/* qqbot-interactive-features-v6 */", "/* qqbot-interactive-features-v7 */"]) {
    const { fixtureDir, fixturePath } = createBundleFixture(legacyMarker);
    try {
      assert.equal(patchBundle(fixturePath), true);
      const patched = fs.readFileSync(fixturePath, "utf8");
      assert.match(patched, /qqbot-interactive-features-v8/);
      assert.doesNotMatch(patched, /qqbot-interactive-features-v2/);
      assert.doesNotMatch(patched, /qqbot-interactive-features-v7/);
      assert.equal((patched.match(/qqbotInteractiveHandleInbound/g) || []).length, 2);
      assert.equal((patched.match(/qqbotInteractiveForceVoiceReply/g) || []).length, 2);
      assert.equal(patchBundle(fixturePath), false);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
});
