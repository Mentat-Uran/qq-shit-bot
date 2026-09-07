import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGatewayUserContent,
  decideMessageAccess,
  logSafeError,
  normalizeGatewayResponse,
  normalizeDataUrl,
  normalizeOneBotEvent,
  parseOneBotSegments,
  stableOpaqueId,
} from "../../deploy/openclaw/onebot/onebot-core.mjs";
import {
  GAME_ENTRIES,
  gameHelp,
  menuText,
  parseInteractiveCommand,
  readRequest,
  renderChatStart,
  runInteractiveAction,
} from "../../deploy/openclaw/onebot/onebot-interactive.mjs";

test("OneBot events normalize into the transport-independent message shape", () => {
  const message = normalizeOneBotEvent({
    post_type: "message",
    message_type: "group",
    group_id: 123456,
    user_id: 654321,
    message_id: 99,
    sender: { nickname: "测试者" },
    message: [
      { type: "at", data: { qq: "9001" } },
      { type: "text", data: { text: " 你好" } },
      { type: "image", data: { file: "image-file", url: "https://media.invalid/image.png" } },
      { type: "reply", data: { id: "88" } },
      { type: "forward", data: { id: "forward-1", title: "聊天记录" } },
    ],
  }, { selfId: "9001" });

  assert.deepEqual(message.route, { scope: "group", target_id: "123456" });
  assert.equal(message.user_id, "654321");
  assert.equal(message.conversation_id, "group:123456");
  assert.equal(message.message_id, "99");
  assert.equal(message.self_mentioned, true);
  assert.equal(message.quote.message_id, "88");
  assert.equal(message.images.length, 1);
  assert.equal(message.segments.find((segment) => segment.kind === "forward").id, "forward-1");
  assert.match(message.text, /你好/);
  assert.match(message.text, /图片/);
  assert.doesNotMatch(message.text, /9001/);
  assert.notEqual(stableOpaqueId("session", message.conversation_id), message.conversation_id);
});

test("CQ string messages and private routes are accepted without OneBot structures", () => {
  assert.deepEqual(parseOneBotSegments("hello[CQ:at,qq=1][CQ:image,file=x,url=https%3A%2F%2Fexample.invalid%2Fa.png]"), [
    { type: "text", data: { text: "hello" } },
    { type: "at", data: { qq: "1" } },
    { type: "image", data: { file: "x", url: "https://example.invalid/a.png" } },
  ]);
  const message = normalizeOneBotEvent({
    post_type: "message",
    message_type: "private",
    user_id: "u-1",
    message_id: "m-1",
    message: "你好",
  });
  assert.deepEqual(message.route, { scope: "private", target_id: "u-1" });
  assert.equal(message.conversation_id, "private:u-1");
});

test("file and JSON card segments become bounded truthful summaries", () => {
  const message = normalizeOneBotEvent({
    post_type: "message",
    message_type: "private",
    user_id: "u-2",
    message_id: "m-3",
    message: [
      { type: "file", data: { file: "file-1", name: "报告.pdf", file_size: 1234 } },
      {
        type: "json",
        data: {
          data: JSON.stringify({
            app: "com.example.miniapp",
            meta: { detail_1: { title: "小程序标题", desc: "卡片说明", qqdocurl: "https://private.invalid/body" } },
          }),
        },
      },
    ],
  });
  assert.equal(message.files[0].name, "报告.pdf");
  assert.match(message.text, /文件：报告\.pdf/);
  assert.match(message.text, /小程序标题/);
  assert.match(message.text, /卡片说明/);
  assert.doesNotMatch(message.text, /private\.invalid|com\.example/);

  const malformed = normalizeOneBotEvent({
    post_type: "message",
    message_type: "private",
    user_id: "u-3",
    message_id: "m-4",
    message: [{ type: "json", data: { data: "broken https://private.invalid/raw" } }],
  });
  assert.equal(malformed.text, "[卡片：JSON 卡片（未提取到可读标题或说明）]");
});

test("group and private access decisions keep the current mention and allowlist boundary", () => {
  const group = normalizeOneBotEvent({ post_type: "message", message_type: "group", group_id: "g1", user_id: "u1", message_id: "m1", message: "问题" });
  assert.equal(decideMessageAccess(group, { allowedGroupIds: new Set(["g1"]), groupRequireMention: true }).allowed, false);
  assert.equal(decideMessageAccess(group, {
    allowedGroupIds: new Set(["g1"]),
    groupRequireMention: true,
    explicitCommand: true,
    strictGroupMention: false,
  }).allowed, true);
  assert.equal(decideMessageAccess(group, {
    allowedGroupIds: new Set(["g1"]),
    groupRequireMention: true,
    explicitCommand: true,
  }).allowed, false);
  assert.equal(decideMessageAccess(group, {
    allowedGroupIds: new Set(["g1"]),
    groupRequireMention: true,
    explicitCommand: true,
    strictGroupMention: true,
  }).allowed, false);
  assert.equal(decideMessageAccess(group, {
    allowedGroupIds: new Set(["g1"]),
    groupRequireMention: true,
    activeGame: true,
    strictGroupMention: true,
  }).allowed, false);
  assert.equal(decideMessageAccess(group, { allowedGroupIds: new Set(["other"]), explicitCommand: true }).allowed, false);
  const privateMessage = normalizeOneBotEvent({ post_type: "message", message_type: "private", user_id: "u1", message_id: "m2", message: "问题" });
  assert.equal(decideMessageAccess(privateMessage, { allowedUserIds: new Set(["u1"]), dmPolicy: "allowlist" }).allowed, true);
  assert.equal(decideMessageAccess(privateMessage, { dmPolicy: "disabled" }).allowed, false);
});

test("strict group mention mode removes every non-mention bypass", () => {
  const group = normalizeOneBotEvent({
    post_type: "message",
    message_type: "group",
    group_id: "g1",
    user_id: "u1",
    message_id: "m-strict",
    message: "菜单",
  });
  for (const options of [
    { explicitCommand: true },
    { activeGame: true },
  ]) {
    assert.equal(decideMessageAccess(group, {
      allowedGroupIds: new Set(["g1"]),
      groupRequireMention: true,
      strictGroupMention: true,
      commandsBypassMention: true,
      ...options,
    }).allowed, false);
  }
});

test("gateway content prioritizes quote images and carries bounded group candidates", () => {
  const message = {
    text: "看看这个",
    quote: { text: "引用文字", images: [{ file: "quoted" }] },
    forward: { text: "[合并转发内容]\n甲：实际节点", images: [] },
  };
  const content = buildGatewayUserContent(message, {
    quoteImageDataUrls: ["data:image/png;base64,quoted"],
    imageDataUrls: ["data:image/png;base64,current"],
    recentContext: Array.from({ length: 20 }, (_, index) => ({ sender_name: `u${index}`, text: `消息${index}` })),
  });
  assert.equal(content.filter((part) => part.type === "image_url").length, 1);
  assert.equal(content.find((part) => part.type === "image_url").image_url.url, "data:image/png;base64,quoted");
  assert.match(content[0].text, /明确引用/);
  assert.match(content[0].text, /合并转发内容/);
  assert.match(content[0].text, /消息19/);
  assert.doesNotMatch(content[0].text, /消息0/);
});

test("interactive parser and menu cover every current game and text-only OneBot controls", () => {
  const ids = GAME_ENTRIES.map((entry) => entry[0]);
  assert.deepEqual(ids, [
    "number-bomb", "twenty-four", "flower-order", "poetry-chain", "clue-auction",
    "idiom-chain", "idiom-wordle", "guess-person", "guess-work", "knowledge",
    "true-false", "find-different", "word-classification", "one-line-reasoning",
    "brain-teaser", "riddle", "sorting", "exam",
  ]);
  assert.deepEqual(parseInteractiveCommand("/menu"), { kind: "menu" });
  assert.deepEqual(parseInteractiveCommand("行测 常识"), { kind: "chat-game-start", game: "exam", category: "常识", mode: "same" });
  assert.deepEqual(parseInteractiveCommand("小游戏 18"), { kind: "chat-game-start", game: "exam", mode: "same" });
  assert.deepEqual(parseInteractiveCommand("朗读语调：戏剧"), { kind: "tts-style", style: "dramatic" });
  assert.deepEqual(parseInteractiveCommand("当前语调"), { kind: "tts-status" });
  assert.deepEqual(parseInteractiveCommand("AI玩法"), { kind: "menu-ai" });
  assert.deepEqual(parseInteractiveCommand("其他工具"), { kind: "menu-other" });
  assert.deepEqual(parseInteractiveCommand("读：你好"), { kind: "read", explicitStyle: null, text: "你好" });
  assert.deepEqual(readRequest("温柔读：你好"), { explicitStyle: "温柔", text: "你好" });
  assert.equal(parseInteractiveCommand("这是一个普通问题"), null);
  assert.match(menuText("dramatic"), /戏剧/);
  assert.match(gameHelp("题库"), /猜人物/);
  assert.match(renderChatStart({ game_type: "number-bomb", title: "数字炸弹", prompt: "1 到 10", instructions: "直接猜", leaderboard: [] }), /数字炸弹/);
});

test("interactive game actions reuse the current sidecar endpoints", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return {
      status: 200,
      async json() {
        return {
          ok: true,
          game_type: "exam",
          title: "行测抢答",
          prompt: "某道题",
          instructions: "发送选项 A/B",
          exam_category: "常识判断",
          leaderboard: [],
          active: true,
        };
      },
    };
  };
  const result = await runInteractiveAction(parseInteractiveCommand("行测 常识"), {
    sessionId: "onebot-session:opaque",
    playerId: "onebot-player:opaque",
    playerName: "甲",
    gameServiceUrl: "http://game.invalid",
    fetchImpl,
  });
  assert.equal(result.handled, true);
  assert.equal(result.active, true);
  assert.match(result.text, /行测抢答/);
  assert.deepEqual(calls[0][1], {
    session_id: "onebot-session:opaque",
    player_id: "onebot-player:opaque",
    player_name: "甲",
    game: "exam",
    mode: "same",
    category: "常识",
  });
});

test("gateway response strips media directives without losing a text fallback", () => {
  const reply = normalizeGatewayResponse({
    choices: [{ message: { content: "说明\nMEDIA:https://media.invalid/a.png\n[[audio_as_voice]]" } }],
  });
  assert.equal(reply.text, "说明");
  assert.deepEqual(reply.media, ["https://media.invalid/a.png"]);
  assert.equal(reply.audioAsVoice, true);
  const ttsOnly = normalizeGatewayResponse({ choices: [{ message: { content: "[[tts:text]]【语气:温柔】你好[[/tts:text]][[audio_as_voice]]" } }] });
  assert.equal(ttsOnly.text, "【语气:温柔】你好");
  assert.equal(ttsOnly.ttsText, "【语气:温柔】你好");
});

test("OneBot error summaries redact bearer and query credentials", () => {
  const safe = logSafeError(new Error("Bearer real-token https://qq.invalid/?access_token=query-token"));
  assert.doesNotMatch(safe, /real-token|query-token/);
  assert.match(safe, /REDACTED_SECRET/);
});

test("media data URLs enforce their declared image or audio type", () => {
  assert.equal(normalizeDataUrl("data:image/png;base64,YQ==", 1024, ["image/"]), "data:image/png;base64,YQ==");
  assert.equal(normalizeDataUrl("data:audio/mpeg;base64,YQ==", 1024, ["audio/"]), "data:audio/mpeg;base64,YQ==");
  assert.throws(
    () => normalizeDataUrl("data:text/html;base64,PGh0bWw+", 1024, ["image/"]),
    /media type is not allowed/,
  );
});

test("gateway media fields accept structured image and audio outputs", () => {
  const reply = normalizeGatewayResponse({
    choices: [{
      message: {
        content: [
          { type: "text", text: "已生成" },
          { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
        ],
        attachments: [{ mediaUrl: "https://media.invalid/audio.mp3" }],
      },
    }],
  });
  assert.equal(reply.text, "已生成");
  assert.deepEqual(reply.media, ["data:image/png;base64,YQ==", "https://media.invalid/audio.mp3"]);
});
