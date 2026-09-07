import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INTERACTIVE_FEATURES_MARKER = "/* qqbot-interactive-features-v9 */";
const LEGACY_INTERACTIVE_FEATURES_MARKERS = [
  "/* qqbot-interactive-features-v8 */",
  "/* qqbot-interactive-features-v7 */",
  "/* qqbot-interactive-features-v6 */",
  "/* qqbot-interactive-features-v5 */",
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
/* qqbot-interactive-features-v9 */
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
  const actorId = msg?.senderId || msg?.senderOpenid || msg?.userOpenid || msg?.memberOpenid || msg?.author?.member_openid || msg?.author?.user_openid;
  const actorName = msg?.senderName || msg?.sender_name || msg?.author?.username;
  return {
    scope: replyTarget.scope === "group" ? "group" : "c2c",
    targetId: String(replyTarget.targetId),
    msgId: msg.messageId ? String(msg.messageId) : void 0,
    actorId: actorId ? String(actorId) : String(replyTarget.targetId),
    actorName: actorName ? String(actorName) : "群友"
  };
}

function qqbotInteractiveInteractionTarget(event) {
  const scope = event?.group_openid ? "group" : event?.user_openid ? "c2c" : "";
  const targetId = event?.group_openid || event?.user_openid || "";
  if (!scope || !targetId) return null;
  const messageId = event?.data?.resolved?.message_id;
  const actorId = event?.user_openid || event?.member_openid || event?.author?.member_openid || event?.author?.user_openid || event?.data?.resolved?.user_openid || targetId;
  const actorName = event?.member?.username || event?.author?.username || event?.user?.username || "群友";
  return {
    scope,
    targetId: String(targetId),
    msgId: messageId ? String(messageId) : void 0,
    actorId: String(actorId),
    actorName: String(actorName)
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
    "",
    "🎮 小游戏　📚 行测/答题　🤖 AI功能　🧰 其他工具",
    "点击分类查看详情；也可以直接发送游戏名或“小游戏 1”启动。"
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
            qqbotInteractiveButton("menu-games", "🎮 小游戏", "小游戏", "qqbot:menu:games", 1),
            qqbotInteractiveButton("menu-exam", "📚 行测答题", "行测答题", "qqbot:menu:exam", 1)
          ]
        },
        {
          buttons: [
            qqbotInteractiveButton("menu-ai", "🤖 AI玩法", "AI玩法", "qqbot:menu:ai", 1),
            qqbotInteractiveButton("menu-other", "🧰 其他工具", "其他工具", "qqbot:menu:other", 0),
            qqbotInteractiveButton("game-end", "⏹ 结束当前游戏", "已结束", "qqbot:game:end", 0)
          ]
        }
      ]
    }
  };
}

function qqbotInteractiveNormalizeCommand(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const qqbotInteractiveGameEntries = [
  ["number-bomb", "数字炸弹", "规则", ["炸弹", "数字雷"]],
  ["twenty-four", "24点", "规则", ["24", "二十四点"]],
  ["flower-order", "飞花令", "规则", []],
  ["poetry-chain", "诗词接龙", "规则", ["诗句接龙"]],
  ["clue-auction", "线索竞拍", "规则", ["竞拍"]],
  ["idiom-chain", "成语接龙", "题库", ["接龙"]],
  ["idiom-wordle", "猜成语", "题库", ["成语猜谜"]],
  ["guess-person", "猜人物", "题库", ["人物"]],
  ["guess-work", "猜作品", "题库", ["猜电影", "猜动漫", "猜游戏", "作品"]],
  ["knowledge", "知识抢答", "题库", ["抢答"]],
  ["true-false", "真假判断", "题库", ["真假", "判断题"]],
  ["find-different", "找不同", "题库", ["找茬"]],
  ["word-classification", "词语分类", "题库", ["分类"]],
  ["one-line-reasoning", "一句话推理", "题库", ["推理"]],
  ["brain-teaser", "脑筋急转弯", "题库", ["脑筋"]],
  ["riddle", "谜语", "题库", ["猜谜"]],
  ["sorting", "排序题", "题库", ["排序"]],
  ["exam", "行测抢答", "行测", ["行测", "行测刷题", "公务员刷题"]]
];

function qqbotInteractiveGameEntry(value) {
  const normalized = qqbotInteractiveNormalizeCommand(value);
  return qqbotInteractiveGameEntries.find((entry) =>
    normalized === entry[1] || entry[3].includes(normalized) || normalized === entry[0]
  ) || null;
}

function qqbotInteractiveGameCategoryEntries(category) {
  return qqbotInteractiveGameEntries.filter((entry) => entry[2] === category);
}

function qqbotInteractiveGameHelp(category = "", page = 1) {
  const normalizedCategory = ["规则", "题库", "行测", "exam", "rules", "quiz"].includes(category) ? category : "";
  if (!normalizedCategory) {
    return [
      "🎮 群聊玩法目录",
      "直接发送游戏名启动；也可以发送“小游戏 1”按编号启动。",
      "",
      "规则 / 题库型：数字炸弹、24点、飞花令、诗词接龙、线索竞拍",
      "题库型：成语接龙、猜成语、猜人物、猜作品、知识抢答、真假判断、找不同、词语分类、一句话推理、脑筋急转弯、谜语、排序题",
      "行测 / 答题：行测 或 行测 常识（支持五类题型）",
      "",
      "输入：小游戏 规则 / 小游戏 题库 / 行测帮助 查看分组详情。",
      "通用控制：提示、查看进度、答案/解析、下一题、放弃。",
      "同一群同一时间只保留一局；不需要私聊、匿名身份或私密发牌。"
    ].join("\n");
  }
  const key = { exam: "行测", rules: "规则", quiz: "题库" }[normalizedCategory] || normalizedCategory;
  const values = key === "行测" ? [["exam", "行测抢答", "支持随机或指定常识/言语/判断/数量/资料"]] : qqbotInteractiveGameCategoryEntries(key);
  const size = 6;
  const pages = Math.max(1, Math.ceil(values.length / size));
  const selectedPage = Math.max(1, Math.min(Number(page) || 1, pages));
  const start = (selectedPage - 1) * size;
  const lines = ["🎮 " + key + "玩法（" + selectedPage + "/" + pages + "）"];
  values.slice(start, start + size).forEach((entry, index) => {
    const number = qqbotInteractiveGameEntries.findIndex((item) => item[0] === entry[0]) + 1;
    const label = entry[1];
    const note = entry[2] || "直接发送名称启动";
    lines.push(number + ". " + label + "：" + note + "（“" + label + "”启动）");
  });
  const firstGlobalNumber = values.length ? qqbotInteractiveGameEntries.findIndex((item) => item[0] === values[start][0]) + 1 : 0;
  const pageCommand = key === "行测" ? "小游戏 行测 " + (selectedPage + 1) + "页" : "小游戏 " + key + " " + (selectedPage + 1) + "页";
  const nextPage = selectedPage < pages ? "下一页：" + pageCommand : "已是最后一页";
  lines.push("", "编号启动：小游戏 " + firstGlobalNumber + "；" + nextPage, "控制：提示 / 查看进度 / 答案或解析 / 下一题 / 放弃");
  return lines.join("\n");
}

function qqbotInteractiveCommand(value) {
  const normalized = qqbotInteractiveNormalizeCommand(value);
  if (normalized === "菜单" || normalized === "功能菜单" || normalized === "功能" || normalized === "/menu") return { kind: "menu" };
  if (/^(?:(?:温柔|播音|戏剧|正常)\s*)?读(?:\s|[:：]|$)/.test(normalized)) return null;
  if (normalized === "小游戏" || normalized === "游戏" || normalized === "海龟汤" || normalized === "海龟汤帮助" || normalized === "成语接龙帮助" || normalized === "接龙帮助" || normalized === "猜成语帮助") return { kind: "game-help" };
  if (/^(?:小游戏|游戏)(?:\s+|第)?(?:第)?([0-9]+)$/.test(normalized)) {
    const number = Number(normalized.match(/([0-9]+)$/)?.[1] || 0);
    const entry = qqbotInteractiveGameEntries[number - 1];
    return entry ? { kind: "chat-game-start", game: entry[0], mode: "same" } : { kind: "game-help" };
  }
  const categoryPage = /^(?:小游戏|游戏)\s*(规则|题库|行测)\s*(?:第)?([0-9]+)页$/.exec(normalized);
  if (categoryPage) return { kind: "game-help", category: categoryPage[1], page: Number(categoryPage[2]) };
  const page = /^(?:小游戏|游戏)(?:\s+)?(?:第)?([0-9]+)页$/.exec(normalized);
  if (page) return { kind: "game-help", category: "", page: Number(page[1]) };
  if (/^(?:小游戏|游戏)\s*(规则|题库|行测)$/.test(normalized)) return { kind: "game-help", category: normalized.match(/(规则|题库|行测)$/)[1] };
  if (normalized === "行测帮助" || normalized === "行测题库" || normalized === "行测答题") return { kind: "game-help", category: "行测" };
  const examStart = /^(?:\/?行测|开始行测)(?:\s+|[:：])?(常识判断|常识|言语理解|言语|判断推理|判断|数量关系|数量|资料分析|资料)?$/.exec(normalized);
  if (examStart) return { kind: "chat-game-start", game: "exam", category: examStart[1] || "", mode: "same" };
  const start = /^(?:\/)?开始海龟汤(?:\s*(?:[:：,，]\s*|\s+)(.+))?$/.exec(normalized);
  if (start) return { kind: "game-start", theme: start[1] || "" };
  const chainStart = /^(?:\/)?(?:开始)?成语接龙(?:\s+(同字|同音|谐音))?$/.exec(normalized);
  if (chainStart) return { kind: "chat-game-start", game: "idiom-chain", mode: chainStart[1] || "same" };
  if (normalized === "猜成语" || normalized === "开始猜成语" || normalized === "/猜成语") return { kind: "chat-game-start", game: "idiom-wordle", mode: "same" };
  const entry = qqbotInteractiveGameEntry(normalized.replace(/^开始/, ""));
  if (entry) return { kind: "chat-game-start", game: entry[0], mode: "same" };
  if (normalized === "提示" || normalized === "给个提示" || normalized === "来个提示" || normalized === "海龟汤提示" || normalized === "猜成语提示" || normalized === "接龙提示") return { kind: "game-hint" };
  if (normalized === "答案" || normalized === "解析" || normalized === "答案解析" || normalized === "行测答案" || normalized === "行测解析") return { kind: "game-answer" };
  if (normalized === "下一题" || normalized === "下一局" || normalized === "再来一题") return { kind: "game-question", text: normalized };
  if (normalized === "查看进度" || normalized === "进度" || normalized === "当前进度" || normalized === "看进度" || normalized === "统计" || normalized === "排行榜") return { kind: "game-status" };
  if (normalized === "放弃" || normalized === "我放弃" || normalized === "不玩了" || normalized === "放弃游戏" || normalized === "海龟汤结束" || normalized === "结束成语接龙" || normalized === "结束猜成语") return { kind: "game-end" };
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
    "",
    "🤔 汤面：",
    String(data.surface || ""),
    "",
    data.notice ? "ℹ️ " + String(data.notice) : "",
    "直接 @我 提问；需要提示就说“提示”，看状态就说“查看进度”，不想玩了就说“放弃”。",
    "📊 当前进度：" + String(data.percent ?? 0) + "%"
  ].join("\n");
}

function qqbotInteractiveQuestionSummary(value) {
  const clean = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!clean) return "当前问题";
  const characters = Array.from(clean);
  return characters.length <= 80 ? clean : characters.slice(0, 79).join("") + "…";
}

function qqbotInteractiveGameTurnText(data) {
  const lines = [
    "❓问题：" + qqbotInteractiveQuestionSummary(data?.question || data?.question_text || data?.text),
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

function qqbotInteractiveLeaderboard(data) {
  const board = Array.isArray(data?.leaderboard) ? data.leaderboard : [];
  if (!board.length) return "暂无得分。";
  return board.map((item, index) => String(index + 1) + ". " + String(item?.name || "群友") + " " + String(item?.score ?? 0) + "分").join("\n");
}

function qqbotInteractiveChatGameStartText(data) {
  if (data?.game_type && data.game_type !== "idiom-chain" && data.game_type !== "idiom-wordle") {
    return [
      "🎮 " + String(data.title || "小游戏") + "开始",
      "",
      "📌 题面：",
      String(data.prompt || ""),
      "",
      String(data.instructions || "直接发送答案。"),
      "提示：提示；状态：查看进度；答案/解析：公布答案；结束：放弃。",
      data.exam_category ? "📚 题型：" + String(data.exam_category) : "",
      "🏆 当前排行榜：",
      qqbotInteractiveLeaderboard(data)
    ].join("\n");
  }
  if (data?.game_type === "idiom-chain") {
    return [
      "🔗 成语接龙开始（" + String(data.mode_label || "同字接龙") + "）",
      "机器人先出：「" + String(data.current_word || "") + "」",
      "请直接发四字成语，接「" + String(data.target_char || "") + "」开头；任何人都可以接。",
      "提示：提示；状态：查看进度；结束：放弃。",
      "📏 当前长度：" + String(data.chain_length ?? 1) + "/" + String(data.max_rounds ?? 30)
    ].join("\n");
  }
  return [
    "🟩 猜成语开始",
    "群里共享同一个答案，直接发四字词语，最多猜" + String(data.max_attempts ?? 10) + "次。",
    "🟩 位置正确　🟨 字在答案中但位置不对　⬜ 不在答案中",
    "提示：提示；状态：查看进度；结束：放弃。"
  ].join("\n");
}

function qqbotInteractiveWordleRow(guess) {
  const word = Array.from(String(guess?.word || ""));
  const marks = Array.isArray(guess?.marks) ? guess.marks : [];
  const icons = { correct: "🟩", present: "🟨", absent: "⬜" };
  return word.map((char, index) => char + (icons[marks[index]] || "⬜")).join(" ");
}

function qqbotInteractiveChatGameTurnText(data) {
  if (data?.game_type && data.game_type !== "idiom-chain" && data.game_type !== "idiom-wordle") {
    const lines = [];
    if (data.correct === true) lines.push("✅ " + String(data.player || "群友") + " 答对了！");
    else if (data.correct === false) lines.push("❌ " + String(data.message || "答案不对，再试试。"));
    else if (data.accepted === false) lines.push("⚠️ " + String(data.message || "这条输入不能算答案。"));
    else if (data.message) lines.push("ℹ️ " + String(data.message));
    if (data.hint) lines.push("💡 " + String(data.hint));
    if (data.answer !== undefined) lines.push("📖 答案：" + String(data.answer));
    if (data.explanation) lines.push("📝 解析：" + String(data.explanation));
    if (data.active !== false && data.prompt) lines.push("", "📌 题面：", String(data.prompt));
    if (data.instructions && data.active !== false) lines.push("", String(data.instructions));
    if (data.correct === true || data.revealed === true) lines.push("", "发送“下一题”继续；状态：查看进度；结束：放弃。");
    if (data.leaderboard) lines.push("", "🏆 排行榜：", qqbotInteractiveLeaderboard(data));
    return lines.filter((line) => line !== "").join("\n");
  }
  if (data?.game_type === "idiom-chain") {
    const lines = [
      data.accepted === false ? "⚠️ " + String(data.message || "这条不能接。") : "✅ " + String(data.player || "群友") + " 接龙成功：「" + String(data.word || "") + "」",
    ];
    if (data.accepted !== false) {
      lines.push("下一棒：接「" + String(data.target_char || "") + "」开头的四字成语。", "📏 长度：" + String(data.chain_length ?? 0) + "/" + String(data.max_rounds ?? 30));
    } else {
      lines.push("当前仍需接：「" + String(data.target_char || "") + "」开头的四字成语。", "📏 长度：" + String(data.chain_length ?? 0) + "/" + String(data.max_rounds ?? 30));
    }
    if (data.ended) {
      lines.push("", data.end_reason === "max-rounds" ? "🏁 达到本局长度上限，游戏结束。" : "🏁 没有新的可接成语，游戏结束。", "🏆 排行榜：", qqbotInteractiveLeaderboard(data));
    }
    return lines.join("\n");
  }

  const lines = [
    data.accepted === false ? "⚠️ " + String(data.message || "这条不能算一次猜测。") : qqbotInteractiveWordleRow({ word: data.word, marks: data.marks }),
  ];
  if (data.accepted !== false) {
    lines.push("👤 " + String(data.player || "群友") + "　剩余 " + String(data.remaining ?? 0) + " 次");
  }
  if (data.ended) {
    lines.push(
      "",
      data.result === "win" ? "🎉 猜中了！" : "😵 次数用完了。",
      "📖 答案：「" + String(data.answer || "") + "」",
      data.explanation ? "释义：" + String(data.explanation) : "",
      "🏆 排行榜：",
      qqbotInteractiveLeaderboard(data),
    );
  }
  return lines.join("\n");
}

function qqbotInteractiveChatGameStatusText(data) {
  if (data?.game_type && data.game_type !== "idiom-chain" && data.game_type !== "idiom-wordle") {
    return [
      "📈 " + String(data.title || "小游戏") + "进度",
      data.exam_category ? "📚 题型：" + String(data.exam_category) : "",
      "🔢 第" + String(data.round ?? 1) + "题" + (data.awaiting_next ? "（已结束）" : "（进行中）"),
      "📌 题面：" + String(data.prompt || ""),
      "🏆 排行榜：",
      qqbotInteractiveLeaderboard(data)
    ].join("\n");
  }
  if (data?.game_type === "idiom-chain") {
    const chain = Array.isArray(data.chain) ? data.chain : [];
    return [
      "📈 成语接龙进度（" + String(data.mode_label || "同字接龙") + "）",
      "当前：「" + String(data.current_word || "") + "」→ 接「" + String(data.target_char || "") + "」开头",
      "链长：" + String(data.chain_length ?? 0) + "/" + String(data.max_rounds ?? 30),
      chain.length ? "最近：" + chain.join(" → ") : "",
      "🏆 排行榜：",
      qqbotInteractiveLeaderboard(data)
    ].join("\n");
  }
  const guesses = Array.isArray(data.guesses) ? data.guesses : [];
  const rows = guesses.map((guess) => String(guess?.player || "群友") + "：" + qqbotInteractiveWordleRow(guess));
  return [
    "📈 猜成语进度",
    "已猜：" + String(data.attempts ?? 0) + "/" + String(data.max_attempts ?? 10) + "　剩余：" + String(data.remaining ?? 0),
    rows.length ? rows.join("\n") : "还没有人提交猜测。",
    "提示次数：" + String(data.hint_count ?? 0),
    "🏆 排行榜：",
    qqbotInteractiveLeaderboard(data)
  ].join("\n");
}

function qqbotInteractiveChatGameHintText(data) {
  if (data?.game_type && data.game_type !== "idiom-chain" && data.game_type !== "idiom-wordle") {
    const lines = ["💡 " + String(data.message || "提示")];
    if (data.hint) lines.push(String(data.hint));
    if (data.answer !== undefined) lines.push("📖 答案：" + String(data.answer));
    if (data.explanation) lines.push("📝 解析：" + String(data.explanation));
    return lines.join("\n");
  }
  if (data?.game_type === "idiom-chain") {
    const words = Array.isArray(data.hint) ? data.hint : [];
    return words.length
      ? "💡 " + String(data.message || "可以从下面挑一个：") + "\n" + words.map((word) => "「" + String(word) + "」").join("、")
      : "💡 " + String(data.message || "暂无可用提示。");
  }
  if (data?.hint && typeof data.hint === "object") return "💡 " + String(data.message || "") + "（不扣次数）";
  return "💡 " + String(data.message || "暂无可用提示。");
}

function qqbotInteractiveChatGameEndText(data) {
  if (data?.game_type && data.game_type !== "idiom-chain" && data.game_type !== "idiom-wordle") {
    return [
      "⏹ " + String(data.title || "小游戏") + "已结束",
      data.answer !== undefined ? "📖 答案：" + String(data.answer) : "",
      data.explanation ? "📝 解析：" + String(data.explanation) : "",
      "🏆 排行榜：",
      qqbotInteractiveLeaderboard(data)
    ].join("\n");
  }
  if (data?.game_type === "idiom-chain") {
    return [
      "⏹ 成语接龙已结束",
      "链长：" + String(data.chain_length ?? 0),
      Array.isArray(data.chain) && data.chain.length ? data.chain.join(" → ") : "",
      "🏆 排行榜：",
      qqbotInteractiveLeaderboard(data)
    ].join("\n");
  }
  return [
    "⏹ 猜成语已结束",
    "📖 答案：「" + String(data.answer || "") + "」",
    data.explanation ? "释义：" + String(data.explanation) : "",
    "🏆 排行榜：",
    qqbotInteractiveLeaderboard(data)
  ].join("\n");
}

function qqbotInteractiveChatPlayerPayload(target) {
  return {
    player_id: qqbotInteractiveQuestionerId(target),
    player_name: String(target?.actorName || target?.senderName || "群友")
  };
}

function qqbotInteractiveQuestionerId(target) {
  const actorId = String(target?.actorId || "").trim();
  const targetId = String(target?.targetId || "").trim();
  if (!actorId || actorId === "anonymous" || (target?.scope === "group" && actorId === targetId)) return "anonymous";
  return actorId;
}

async function qqbotInteractiveHandleGameAction(action, target, account, log4) {
  const sessionId = qqbotInteractiveConversationKey(account.accountId, target.scope, target.targetId);
  const payload = { session_id: sessionId };
  let request;
  let renderKind = action.kind;
  if (action.kind === "chat-game-start") {
    request = await qqbotInteractiveGameRequest(
      "/v1/chat-games/start",
      { ...payload, ...qqbotInteractiveChatPlayerPayload(target), game: action.game, mode: action.mode || "same", category: action.category || "" },
      log4,
      30000,
    );
    if (request?.status === 200 && request.data) {
      const text = request.data.ok === false ? String(request.data.message || "当前已有进行中的小游戏。") : qqbotInteractiveChatGameStartText(request.data);
      return await qqbotInteractiveSendText(target, account, text, log4);
    }
    await qqbotInteractiveSendText(target, account, "文字小游戏服务暂时不可用，请稍后再试。", log4);
    return true;
  }
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
    return await qqbotInteractiveSendText(target, account, qqbotInteractiveGameHelp(action.category || "", action.page || 1), log4);
  }
  if (action.kind === "game-hint") {
    request = await qqbotInteractiveGameRequest("/v1/chat-games/hint", payload, log4, 30000);
    if (request?.status === 404) request = await qqbotInteractiveGameRequest("/v1/games/hint", payload, log4, 30000);
  } else if (action.kind === "game-answer") {
    request = await qqbotInteractiveGameRequest("/v1/chat-games/answer", payload, log4, 30000);
    if (request?.status === 404) {
      request = await qqbotInteractiveGameRequest("/v1/games/end", payload, log4, 30000);
      renderKind = "game-end";
    }
  } else if (action.kind === "game-status") {
    request = await qqbotInteractiveGameRequest("/v1/chat-games/status", payload, log4, 30000);
    if (request?.status === 404) request = await qqbotInteractiveGameRequest("/v1/games/status", payload, log4, 30000);
  } else if (action.kind === "game-end") {
    request = await qqbotInteractiveGameRequest("/v1/chat-games/end", payload, log4, 30000);
    if (request?.status === 404) request = await qqbotInteractiveGameRequest("/v1/games/end", payload, log4, 30000);
  } else if (action.kind === "game-question") {
    const questionPayload = { ...payload, text: action.text };
    request = await qqbotInteractiveGameRequest("/v1/chat-games/input", { ...payload, ...qqbotInteractiveChatPlayerPayload(target), text: action.text }, log4, 30000);
    if (request?.status === 404) request = await qqbotInteractiveGameRequest("/v1/games/ask", questionPayload, log4, 600000);
  }
  else return false;

  if (!request) return action.kind !== "game-question" && action.kind !== "game-answer";
  if (request.status === 404) return false;
  if (request.status !== 200 || !request.data) {
    await qqbotInteractiveSendText(target, account, "海龟汤主持服务暂时不可用，请稍后再试。", log4);
    return true;
  }
  const data = request.data;
  if (data.game_type) {
    const legacyChatGame = data.game_type === "idiom-chain" || data.game_type === "idiom-wordle";
    if (renderKind === "game-hint" || (renderKind === "game-answer" && !legacyChatGame)) return await qqbotInteractiveSendText(target, account, qqbotInteractiveChatGameHintText(data), log4);
    if (renderKind === "game-answer" && legacyChatGame) return await qqbotInteractiveSendText(target, account, qqbotInteractiveChatGameEndText(data), log4);
    if (renderKind === "game-status") return await qqbotInteractiveSendText(target, account, data.active ? qqbotInteractiveChatGameStatusText(data) : "当前没有进行中的文字小游戏。", log4);
    if (renderKind === "game-end") return await qqbotInteractiveSendText(target, account, qqbotInteractiveChatGameEndText(data), log4);
    return await qqbotInteractiveSendText(target, account, qqbotInteractiveChatGameTurnText(data), log4);
  }
  if (renderKind === "game-hint") {
    const hint = data.hint ? "💡 提示 [" + String(data.current ?? 0) + "/" + String(data.total ?? 0) + "]：\n" + String(data.hint) : String(data.message || "暂无可用提示。");
    return await qqbotInteractiveSendText(target, account, hint, log4);
  }
  if (renderKind === "game-status") return await qqbotInteractiveSendText(target, account, data.active ? qqbotInteractiveGameStatusText(data) : "当前没有进行中的海龟汤。", log4);
  if (renderKind === "game-end" || renderKind === "game-answer") return await qqbotInteractiveSendText(target, account, qqbotInteractiveGameEndText(data), log4);
  return await qqbotInteractiveSendText(
    target,
    account,
    qqbotInteractiveGameTurnText({ ...data, question: data.question || action.text }),
    log4,
  );
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
    "qqbot:menu:games",
    "qqbot:menu:exam",
    "qqbot:menu:ai",
    "qqbot:menu:other",
    "qqbot:game:menu",
    "qqbot:game:idiom-chain",
    "qqbot:game:idiom-wordle",
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
  if (buttonData === "qqbot:menu:games" || buttonData === "qqbot:game:menu") {
    await qqbotInteractiveSendText(target, account, qqbotInteractiveGameHelp(), log4);
    return true;
  }
  if (buttonData === "qqbot:menu:exam") {
    await qqbotInteractiveSendText(target, account, qqbotInteractiveGameHelp("行测"), log4);
    return true;
  }
  if (buttonData === "qqbot:menu:ai") {
    await qqbotInteractiveSendText(
      target,
      account,
      "🤖 AI增强\n海龟汤：开始海龟汤，可附带悬疑/场景主题\n通用问答：直接 @我 提问\n\n海龟汤的出题和主持使用现有模型；行测题干、答案、解析和基础判分直接来自题库，不依赖模型。",
      log4,
    );
    return true;
  }
  if (buttonData === "qqbot:menu:other") {
    await qqbotInteractiveSendText(
      target,
      account,
      "🧰 其他工具\n菜单：查看一级菜单\n读：内容：单次朗读\n提示 / 查看进度 / 答案 / 下一题 / 放弃：当前游戏控制",
      log4,
    );
    return true;
  }
  if (buttonData === "qqbot:game:idiom-chain") {
    return await qqbotInteractiveHandleGameAction({ kind: "chat-game-start", game: "idiom-chain", mode: "same" }, target, account, log4);
  }
  if (buttonData === "qqbot:game:idiom-wordle") {
    return await qqbotInteractiveHandleGameAction({ kind: "chat-game-start", game: "idiom-wordle", mode: "same" }, target, account, log4);
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
