import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INTERACTIVE_FEATURES_MARKER = "/* qqbot-interactive-features-v5 */";
const LEGACY_INTERACTIVE_FEATURES_MARKERS = [
  "/* qqbot-interactive-features-v4 */",
  "/* qqbot-interactive-features-v3 */",
  "/* qqbot-interactive-features-v2 */",
  "/* qqbot-interactive-features-v1 */",
];
const stateDir = process.env.OPENCLAW_STATE_DIR || "/home/node/.openclaw";
const projectsDir = path.join(stateDir, "npm", "projects");

function findTencentBundle() {
  if (!fs.existsSync(projectsDir)) return null;
  const candidates = [];
  for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const candidate = path.join(
      projectsDir,
      project.name,
      "node_modules",
      "@tencent-connect",
      "openclaw-qqbot",
      "dist",
      "index.cjs",
    );
    if (!fs.existsSync(candidate)) continue;
    const source = fs.readFileSync(candidate, "utf8");
    if (
      source.includes("async function dispatchToOpenClaw(ctx, msg, account, runtime2, log4)") &&
      source.includes("async function handleMessage(ctx, msg, account, runtime2, log4)") &&
      source.includes("async function handleInteraction(event, account, runtime2, log4, acknowledgeInteraction)")
    ) {
      candidates.push({ file: candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.file ?? null;
}

function replaceOnce(source, label, before, after) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error("QQ interactive-features patch marker not found: " + label);
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error("QQ interactive-features patch marker is ambiguous: " + label);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function buildInteractiveFeaturesSource() {
  return String.raw`
/* qqbot-interactive-features-v5 */
const qqbotInteractiveTtsStyles = new Map();
const qqbotInteractiveTtsStyleNames = new Map([
  ["gentle", "温柔"],
  ["broadcast", "播音"],
  ["dramatic", "戏剧"],
  ["normal", "正常"]
]);
const qqbotInteractiveGameServiceUrl = process.env.QQBOT_GAME_SERVICE_URL || "http://127.0.0.1:18104";

function qqbotInteractiveConversationKey(accountId, scope, targetId) {
  return String(accountId || "") + ":" + String(scope || "") + ":" + String(targetId || "");
}

function qqbotInteractiveTargetFromMessage(msg) {
  const replyTarget = msg?.replyTarget;
  if (!replyTarget?.scope || !replyTarget?.targetId) return null;
  return {
    scope: replyTarget.scope === "group" ? "group" : "c2c",
    targetId: String(replyTarget.targetId),
    msgId: msg.messageId ? String(msg.messageId) : void 0
  };
}

function qqbotInteractiveInteractionTarget(event) {
  const scope = event?.group_openid ? "group" : event?.user_openid ? "c2c" : "";
  const targetId = event?.group_openid || event?.user_openid || "";
  if (!scope || !targetId) return null;
  const messageId = event?.data?.resolved?.message_id;
  return {
    scope,
    targetId: String(targetId),
    msgId: messageId ? String(messageId) : void 0
  };
}

function qqbotInteractiveReadRequest(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  const match = /^(?:(温柔|播音|戏剧|正常)\s*)?读(?:\s|[:：]|$)/.exec(normalized);
  return match ? { explicitStyle: match[1] || null } : null;
}

function qqbotInteractiveTtsStyleKey(value) {
  for (const [key, name] of qqbotInteractiveTtsStyleNames.entries()) {
    if (value === key || value === name) return key;
  }
  return "normal";
}

function qqbotInteractiveCurrentTtsStyle(key) {
  return qqbotInteractiveTtsStyleNames.get(qqbotInteractiveTtsStyleKey(qqbotInteractiveTtsStyles.get(key))) || "正常";
}

function qqbotInteractiveHasSuccessfulVoiceTranscript(ctx) {
  const transcripts = ctx?.state?.processedAttachments?.transcripts;
  if (!Array.isArray(transcripts)) return false;
  return transcripts.some((item) => {
    const source = String(item?.source || "").toLowerCase();
    return (source === "stt" || source === "asr") && typeof item?.text === "string" && item.text.trim().length > 0;
  });
}

function qqbotInteractiveApplyTtsStyle(assembled, ctx) {
  if (!assembled || typeof assembled !== "object") return;
  const explicitRead = ctx?.state?.qqbotInteractiveTtsRequest === true;
  const inboundVoiceReply = ctx?.state?.qqbotInteractiveVoiceReply === true;
  if (!explicitRead && !inboundVoiceReply) return;
  const style = qqbotInteractiveTtsStyleNames.get(qqbotInteractiveTtsStyleKey(ctx?.state?.qqbotInteractiveTtsStyle)) || "正常";
  const marker = explicitRead ? "[QQ TTS tone instruction]" : "[QQ voice reply tone instruction]";
  const instruction = explicitRead
    ? [
        marker,
        "This is an explicit read-aloud request. Keep the requested wording and punctuation.",
        "Use only [[tts:text]]【语气:" + style + "】text to read[[/tts:text]][[audio_as_voice]] and do not add a duplicate plain-text reply.",
        "[/QQ TTS tone instruction]"
      ].join("\n")
    : [
        marker,
        "The user sent a QQ voice message and its transcript is available in the current message context.",
        "Reply once to that transcript in concise, natural text. The adapter will convert the final answer to one native QQ voice message.",
        "Do not emit [[tts:...]] markers or [[audio_as_voice]] and do not add a duplicate reply.",
        "使用选定的语气：" + style + "。",
        "[/QQ voice reply tone instruction]"
      ].join("\n");
  const base = typeof assembled.agentBody === "string" ? assembled.agentBody.trim() : "";
  if (!base.includes(marker)) {
    assembled.agentBody = base ? base + "\n\n" + instruction : instruction;
  }
}

function qqbotInteractiveForceVoiceReply(payload, info, deliverCtx) {
  if (deliverCtx?.autoVoiceReply !== true || !payload || typeof payload !== "object") return payload;
  if (payload.audioAsVoice === true) return payload;
  const kind = info?.kind;
  if (kind && kind !== "final") return payload;
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return payload;
  const hasMedia = Boolean(
    payload.mediaUrl ||
    payload.mediaUrls?.length ||
    payload.attachments?.length
  );
  if (hasMedia) return payload;
  return { ...payload, audioAsVoice: true };
}

async function qqbotInteractiveSendText(target, account, text, log4) {
  const gateway = getGateway(account.accountId);
  if (!gateway?.bot?.sendText) {
    log4?.warn?.("[qqbot] interactive feature send skipped: bot is not ready");
    return false;
  }
  try {
    await gateway.bot.sendText(target, text);
    return true;
  } catch (err) {
    log4?.warn?.("[qqbot] interactive feature send failed: " + (err instanceof Error ? err.message : String(err)).slice(0, 160));
    return false;
  }
}

async function qqbotInteractiveSendMenu(target, account, log4) {
  const gateway = getGateway(account.accountId);
  if (!gateway?.bot?.sendTextWithKeyboard) {
    log4?.warn?.("[qqbot] interactive menu skipped: keyboard API is not ready");
    return false;
  }
  const key = qqbotInteractiveConversationKey(account.accountId, target.scope, target.targetId);
  const style = qqbotInteractiveCurrentTtsStyle(key);
  const content = [
    "🧩 QQ 功能菜单",
    "朗读语调：当前「" + style + "」",
    "点击下面按钮切换语调；影响之后的显式朗读和语音入站回复，普通文字消息仍然是文字。",
    "单次朗读：读：内容 / 温柔读：内容 / 播音读：内容 / 戏剧读：内容",
    "小游戏：海龟汤（发送“开始海龟汤”后，@我提问）"
  ].join("\n");
  try {
    await gateway.bot.sendTextWithKeyboard(target, content, qqbotInteractiveMenuKeyboard());
    return true;
  } catch (err) {
    log4?.warn?.("[qqbot] interactive menu send failed: " + (err instanceof Error ? err.message : String(err)).slice(0, 160));
    return false;
  }
}

function qqbotInteractiveButton(id, label, visitedLabel, data, style) {
  return {
    id,
    render_data: { label, visited_label: visitedLabel, style: style ?? 1 },
    action: { type: 1, permission: { type: 2 }, data },
    group_id: "qqbot-features"
  };
}

function qqbotInteractiveMenuKeyboard() {
  return {
    content: {
      rows: [
        {
          buttons: [
            qqbotInteractiveButton("tts-tone-gentle", "🎙️ 温柔语调", "已选温柔", "qqbot:tts:tone:gentle", 1),
            qqbotInteractiveButton("tts-tone-broadcast", "📢 播音语调", "已选播音", "qqbot:tts:tone:broadcast", 0)
          ]
        },
        {
          buttons: [
            qqbotInteractiveButton("tts-tone-dramatic", "🎭 戏剧语调", "已选戏剧", "qqbot:tts:tone:dramatic", 1),
            qqbotInteractiveButton("tts-tone-normal", "◻️ 正常语调", "已选正常", "qqbot:tts:tone:normal", 0)
          ]
        },
        {
          buttons: [
            qqbotInteractiveButton("tts-tone-status", "📊 当前语调", "已查询", "qqbot:tts:tone:status", 0),
            qqbotInteractiveButton("game-menu", "🎮 小游戏", "小游戏", "qqbot:game:menu", 1)
          ]
        },
        {
          buttons: [
            qqbotInteractiveButton("game-start", "🐢 开始海龟汤", "已开始", "qqbot:game:start", 1),
            qqbotInteractiveButton("game-end", "⏹ 结束海龟汤", "已结束", "qqbot:game:end", 0)
          ]
        }
      ]
    }
  };
}

function qqbotInteractiveNormalizeCommand(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function qqbotInteractiveGameHelp() {
  return [
    "🎮 群聊小游戏",
    "🐢 海龟汤：AI 主持的情境推理，适合多人一起问。",
    "开始：开始海龟汤 或 开始海龟汤 主题",
    "提问：@我 这是故意的吗？（尽量问能回答是/不是的问题）",
    "控制：@我 提示 / 查看进度 / 放弃",
    "默认题库20道；同一群本轮不重复，主题题抽完会自动从未出题面补选。",
    "题目会参考公开资料，再整理成适合群聊的一局。"
  ].join("\n");
}

function qqbotInteractiveCommand(value) {
  const normalized = qqbotInteractiveNormalizeCommand(value);
  if (normalized === "菜单" || normalized === "功能菜单" || normalized === "功能" || normalized === "/menu") return { kind: "menu" };
  if (normalized === "游戏" || normalized === "小游戏" || normalized === "海龟汤" || normalized === "海龟汤帮助") return { kind: "game-help" };
  if (/^(?:(?:温柔|播音|戏剧|正常)\s*)?读(?:\s|[:：]|$)/.test(normalized)) return null;
  const start = /^(?:\/)?开始海龟汤(?:\s+(.+))?$/.exec(normalized);
  if (start) return { kind: "game-start", theme: start[1] || "" };
  if (normalized === "提示" || normalized === "给个提示" || normalized === "来个提示" || normalized === "海龟汤提示") return { kind: "game-hint" };
  if (normalized === "查看进度" || normalized === "进度" || normalized === "当前进度" || normalized === "看进度") return { kind: "game-status" };
  if (normalized === "放弃" || normalized === "我放弃" || normalized === "不玩了" || normalized === "公布答案" || normalized === "看答案" || normalized === "放弃游戏" || normalized === "海龟汤结束") return { kind: "game-end" };
  if (!normalized) return null;
  return { kind: "game-question", text: normalized };
}

async function qqbotInteractiveGameRequest(pathname, payload, log4, timeoutMs) {
  try {
    const response = await fetch(qqbotInteractiveGameServiceUrl + pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs || 600000)
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
    }
    return { status: response.status, data };
  } catch (err) {
    log4?.warn?.("[qqbot] game service request failed: " + (err instanceof Error ? err.message : String(err)).slice(0, 160));
    return null;
  }
}

function qqbotInteractiveGameStartText(data) {
  return [
    "🎮 海龟汤开始",
    "📖 " + String(data.title || "未命名题目"),
    "",
    "🤔 汤面：",
    String(data.surface || ""),
    "",
    data.notice ? "ℹ️ " + String(data.notice) : "",
    "直接 @我 提问；需要提示就说“提示”，看状态就说“查看进度”，不想玩了就说“放弃”。",
    "📊 当前进度：" + String(data.percent ?? 0) + "%"
  ].join("\n");
}

function qqbotInteractiveGameTurnText(data) {
  const lines = [
    "💬 主持人：" + String(data.reply || "不重要"),
    "📊 进度：" + String(data.percent ?? 0) + "%",
    "🔢 已提问：" + String(data.questions_asked ?? 0) + "/" + String(data.max_questions ?? 50)
  ];
  if (data.ended) {
    lines.push("", "📖 完整答案：", String(data.solution || ""));
    const hints = Array.isArray(data.supplementary_info) ? data.supplementary_info : [];
    if (hints.length) lines.push("", "💡 相关线索：", hints.map((item) => "• " + String(item)).join("\n"));
  }
  return lines.join("\n");
}

function qqbotInteractiveGameStatusText(data) {
  return [
    "📈 海龟汤进度",
    "📖 " + String(data.title || "未命名题目"),
    "🤔 汤面：" + String(data.surface || ""),
    "📊 进度：" + String(data.percent ?? 0) + "%",
    "🔢 已提问：" + String(data.questions_asked ?? 0) + "/" + String(data.max_questions ?? 50)
  ].join("\n");
}

function qqbotInteractiveGameEndText(data) {
  const lines = [
    "⏹ 海龟汤已结束",
    "🔢 总提问数：" + String(data.questions_asked ?? 0),
    "",
    "📖 正确答案：",
    String(data.solution || "")
  ];
  const hints = Array.isArray(data.supplementary_info) ? data.supplementary_info : [];
  if (hints.length) lines.push("", "💡 相关线索：", hints.map((item) => "• " + String(item)).join("\n"));
  return lines.join("\n");
}

async function qqbotInteractiveHandleGameAction(action, target, account, log4) {
  const sessionId = qqbotInteractiveConversationKey(account.accountId, target.scope, target.targetId);
  const payload = { session_id: sessionId };
  let request;
  if (action.kind === "game-start") {
    request = await qqbotInteractiveGameRequest("/v1/games/start", { ...payload, theme: action.theme || "" }, log4, 600000);
    if (request?.status === 200 && request.data) {
      const text = request.data.ok === false ? String(request.data.message || "当前已有进行中的海龟汤。") : qqbotInteractiveGameStartText(request.data);
      return await qqbotInteractiveSendText(target, account, text, log4);
    }
    await qqbotInteractiveSendText(target, account, "海龟汤服务暂时不可用，请稍后再试。", log4);
    return true;
  }
  if (action.kind === "game-help") {
    return await qqbotInteractiveSendText(target, account, qqbotInteractiveGameHelp(), log4);
  }
  if (action.kind === "game-hint") request = await qqbotInteractiveGameRequest("/v1/games/hint", payload, log4, 30000);
  else if (action.kind === "game-status") request = await qqbotInteractiveGameRequest("/v1/games/status", payload, log4, 30000);
  else if (action.kind === "game-end") request = await qqbotInteractiveGameRequest("/v1/games/end", payload, log4, 30000);
  else if (action.kind === "game-question") request = await qqbotInteractiveGameRequest("/v1/games/ask", { ...payload, text: action.text }, log4, 600000);
  else return false;

  if (!request) return action.kind !== "game-question";
  if (request.status === 404) return false;
  if (request.status !== 200 || !request.data) {
    await qqbotInteractiveSendText(target, account, "海龟汤主持服务暂时不可用，请稍后再试。", log4);
    return true;
  }
  const data = request.data;
  if (action.kind === "game-hint") {
    const hint = data.hint ? "💡 提示 [" + String(data.current ?? 0) + "/" + String(data.total ?? 0) + "]：\n" + String(data.hint) : String(data.message || "暂无可用提示。");
    return await qqbotInteractiveSendText(target, account, hint, log4);
  }
  if (action.kind === "game-status") return await qqbotInteractiveSendText(target, account, data.active ? qqbotInteractiveGameStatusText(data) : "当前没有进行中的海龟汤。", log4);
  if (action.kind === "game-end") return await qqbotInteractiveSendText(target, account, qqbotInteractiveGameEndText(data), log4);
  return await qqbotInteractiveSendText(target, account, qqbotInteractiveGameTurnText(data), log4);
}

async function qqbotInteractiveHandleInbound(ctx, msg, account, log4) {
  if (ctx?.state) {
    ctx.state.qqbotInteractiveTtsRequest = false;
    delete ctx.state.qqbotInteractiveTtsStyle;
    ctx.state.qqbotInteractiveVoiceReply = qqbotInteractiveHasSuccessfulVoiceTranscript(ctx);
  }
  const target = qqbotInteractiveTargetFromMessage(msg);
  const readRequest = qqbotInteractiveReadRequest(msg?.content);
  if (target && ctx?.state) {
    const key = qqbotInteractiveConversationKey(account.accountId, target.scope, target.targetId);
    if (ctx.state.qqbotInteractiveVoiceReply === true) {
      ctx.state.qqbotInteractiveTtsStyle = qqbotInteractiveTtsStyleKey(qqbotInteractiveTtsStyles.get(key));
    }
    if (readRequest) {
      ctx.state.qqbotInteractiveTtsRequest = true;
      ctx.state.qqbotInteractiveTtsStyle = qqbotInteractiveTtsStyleKey(
        readRequest.explicitStyle || qqbotInteractiveTtsStyles.get(key),
      );
    }
  }
  const command = qqbotInteractiveCommand(msg?.content);
  if (!command) return false;
  if (!target) return false;
  if (command.kind === "menu") return await qqbotInteractiveSendMenu(target, account, log4);
  return await qqbotInteractiveHandleGameAction(command, target, account, log4);
}

async function qqbotInteractiveHandleInteraction(event, account, log4, acknowledgeInteraction) {
  const buttonData = String(event?.data?.resolved?.button_data ?? "");
  const supported = new Set([
    "qqbot:tts:tone:gentle",
    "qqbot:tts:tone:broadcast",
    "qqbot:tts:tone:dramatic",
    "qqbot:tts:tone:normal",
    "qqbot:tts:tone:status",
    "qqbot:game:menu",
    "qqbot:game:start",
    "qqbot:game:end"
  ]);
  if (!supported.has(buttonData)) return false;
  try {
    await acknowledgeInteraction(event.id, 0);
  } catch {
  }
  const target = qqbotInteractiveInteractionTarget(event);
  if (!target) return true;
  const key = qqbotInteractiveConversationKey(account.accountId, target.scope, target.targetId);
  const toneButton = /^qqbot:tts:tone:(gentle|broadcast|dramatic|normal)$/.exec(buttonData);
  if (toneButton) {
    const styleKey = toneButton[1];
    const style = qqbotInteractiveTtsStyleNames.get(styleKey) || "正常";
    qqbotInteractiveTtsStyles.set(key, styleKey);
    await qqbotInteractiveSendText(
      target,
      account,
      "✅ 当前朗读语调已切换为「" + style + "」。之后显式朗读或语音入站回复时生效；普通文字回复仍然是文字。",
      log4,
    );
    return true;
  }
  if (buttonData === "qqbot:tts:tone:status") {
    await qqbotInteractiveSendText(
      target,
      account,
      "📊 当前" + (target.scope === "group" ? "群聊" : "私聊") + "朗读语调：「" + qqbotInteractiveCurrentTtsStyle(key) + "」",
      log4
    );
    return true;
  }
  if (buttonData === "qqbot:game:menu") {
    await qqbotInteractiveSendText(target, account, qqbotInteractiveGameHelp(), log4);
    return true;
  }
  if (buttonData === "qqbot:game:start") {
    return await qqbotInteractiveHandleGameAction({ kind: "game-start", theme: "" }, target, account, log4);
  }
  return await qqbotInteractiveHandleGameAction({ kind: "game-end" }, target, account, log4);
}
`;
}

function patchBundle(file) {
  let source = fs.readFileSync(file, "utf8");
  let changed = false;

  if (!source.includes(INTERACTIVE_FEATURES_MARKER)) {
    for (const legacyMarker of LEGACY_INTERACTIVE_FEATURES_MARKERS) {
      const legacyStart = source.indexOf(legacyMarker);
      if (legacyStart < 0) continue;
      const legacyEnd = source.indexOf("\nfunction historyBuffer(options = {}) {", legacyStart);
      if (legacyEnd < 0) {
        throw new Error("QQ interactive-features legacy block boundary not found: " + legacyMarker);
      }
      source = source.slice(0, legacyStart) + source.slice(legacyEnd + 1);
      changed = true;
    }
    source = replaceOnce(
      source,
      "interactive-features-helper",
      "function historyBuffer(options = {}) {",
      buildInteractiveFeaturesSource() + "\nfunction historyBuffer(options = {}) {",
    );
    changed = true;
  }

  const inboundHook = "  if (await qqbotInteractiveHandleInbound(ctx, msg, account, log4)) return;\n";
  if (!source.includes(inboundHook)) {
    source = replaceOnce(
      source,
      "interactive-features-inbound-hook",
      "  const hlog = log4.child(\"handle\");\n",
      "  const hlog = log4.child(\"handle\");\n" + inboundHook,
    );
    changed = true;
  }

  const interactionHook = "  if (await qqbotInteractiveHandleInteraction(event, account, log4, acknowledgeInteraction)) return;\n";
  if (!source.includes(interactionHook)) {
    source = replaceOnce(
      source,
      "interactive-features-interaction-hook",
      "async function handleInteraction(event, account, runtime2, log4, acknowledgeInteraction) {\n",
      "async function handleInteraction(event, account, runtime2, log4, acknowledgeInteraction) {\n" + interactionHook,
    );
    changed = true;
  }

  const legacyVoiceHook = "  if (!imageGenerationRequest) qqbotInteractiveApplyVoiceInstruction(agentAssembled, ctx, envelope, account);\n";
  if (source.includes(legacyVoiceHook)) {
    source = source.replace(legacyVoiceHook, "");
    changed = true;
  }

  const ttsHook = "  if (!imageGenerationRequest) qqbotInteractiveApplyTtsStyle(agentAssembled, ctx);\n";
  if (!source.includes(ttsHook)) {
    source = replaceOnce(
      source,
      "interactive-features-tts-hook",
      "  const agentAssembled = imageGenerationRequest\n    ? qqbotOverlayPrepareImageGenerationAssembled(assembled)\n    : assembled;\n",
      "  const agentAssembled = imageGenerationRequest\n    ? qqbotOverlayPrepareImageGenerationAssembled(assembled)\n    : assembled;\n" + ttsHook,
    );
    changed = true;
  }

  const deliverReplyHook = "  payload = qqbotInteractiveForceVoiceReply(payload, _info, ctx);\n";
  if (!source.includes(deliverReplyHook)) {
    source = replaceOnce(
      source,
      "interactive-features-deliver-voice-hook",
      "async function deliverReply(payload, _info, ctx) {\n",
      "async function deliverReply(payload, _info, ctx) {\n" + deliverReplyHook,
    );
    changed = true;
  }

  const deliverContextVoiceField = "    autoVoiceReply: ctx?.state?.qqbotInteractiveVoiceReply === true,\n";
  if (!source.includes(deliverContextVoiceField)) {
    source = replaceOnce(
      source,
      "interactive-features-deliver-context-voice-field",
      "    log: log4?.child(\"deliver\"),\n    agentId: route.agentId ?? \"default\"\n",
      "    log: log4?.child(\"deliver\"),\n" + deliverContextVoiceField + "    agentId: route.agentId ?? \"default\"\n",
    );
    changed = true;
  }

  if (
    !source.includes(INTERACTIVE_FEATURES_MARKER) ||
    !source.includes(inboundHook) ||
    !source.includes(interactionHook) ||
    !source.includes(ttsHook) ||
    !source.includes(deliverReplyHook) ||
    !source.includes(deliverContextVoiceField)
  ) {
    throw new Error("QQ interactive-features patch did not install all hooks");
  }
  if (!changed) return false;
  const tempFile = file + ".qqbot-interactive-features.tmp";
  fs.writeFileSync(tempFile, source, "utf8");
  fs.renameSync(tempFile, file);
  return true;
}

export { buildInteractiveFeaturesSource, patchBundle };

function main() {
  const bundle = findTencentBundle();
  if (!bundle) throw new Error("QQ interactive-features patch: installed Tencent QQBot 2.x bundle was not found");
  const changed = patchBundle(bundle);
  console.log((changed ? "Applied" : "Already applied") + " QQ interactive features patch: " + bundle);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
