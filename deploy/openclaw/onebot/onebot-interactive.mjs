import { boundedName, splitTextForOneBot } from "./onebot-core.mjs";

export const TTS_STYLE_NAMES = Object.freeze({
  gentle: "温柔",
  broadcast: "播音",
  dramatic: "戏剧",
  normal: "正常",
});

export const GAME_ENTRIES = Object.freeze([
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
  ["exam", "行测抢答", "行测", ["行测", "行测刷题", "公务员刷题"]],
]);

export function normalizeInteractiveCommand(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeTtsStyle(value) {
  const candidate = String(value ?? "").trim();
  for (const [key, name] of Object.entries(TTS_STYLE_NAMES)) {
    if (candidate === key || candidate === name) return key;
  }
  return "normal";
}

export function readRequest(value) {
  const normalized = normalizeInteractiveCommand(value);
  const match = /^(?:(温柔|播音|戏剧|正常)\s*)?读(?:\s|[:：]|$)/.exec(normalized);
  if (!match) return null;
  return {
    explicitStyle: match[1] || null,
    text: normalized.slice(match[0].length).trim(),
  };
}

export function gameEntry(value) {
  const normalized = normalizeInteractiveCommand(value);
  return GAME_ENTRIES.find((entry) =>
    normalized === entry[1] || entry[3].includes(normalized) || normalized === entry[0],
  ) || null;
}

function categoryEntries(category) {
  return GAME_ENTRIES.filter((entry) => entry[2] === category);
}

export function gameHelp(category = "", page = 1) {
  const normalizedCategory = ["规则", "题库", "行测", "exam", "rules", "quiz"].includes(category)
    ? category
    : "";
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
      "同一群同一时间只保留一局；不需要私聊、匿名身份或私密发牌。",
    ].join("\n");
  }
  const key = { exam: "行测", rules: "规则", quiz: "题库" }[normalizedCategory] || normalizedCategory;
  const values = key === "行测"
    ? [["exam", "行测抢答", "支持随机或指定常识/言语/判断/数量/资料"]]
    : categoryEntries(key);
  const size = 6;
  const pages = Math.max(1, Math.ceil(values.length / size));
  const selectedPage = Math.max(1, Math.min(Number(page) || 1, pages));
  const start = (selectedPage - 1) * size;
  const lines = [`🎮 ${key}玩法（${selectedPage}/${pages}）`];
  values.slice(start, start + size).forEach((entry) => {
    const number = GAME_ENTRIES.findIndex((item) => item[0] === entry[0]) + 1;
    lines.push(`${number}. ${entry[1]}：${entry[2] || "直接发送名称启动"}（“${entry[1]}”启动）`);
  });
  const firstGlobalNumber = values.length
    ? GAME_ENTRIES.findIndex((item) => item[0] === values[start][0]) + 1
    : 0;
  const pageCommand = key === "行测"
    ? `小游戏 行测 ${selectedPage + 1}页`
    : `小游戏 ${key} ${selectedPage + 1}页`;
  const nextPage = selectedPage < pages ? `下一页：${pageCommand}` : "已是最后一页";
  lines.push(
    "",
    `编号启动：小游戏 ${firstGlobalNumber}；${nextPage}`,
    "控制：提示 / 查看进度 / 答案或解析 / 下一题 / 放弃",
  );
  return lines.join("\n");
}

export function menuText(style = "正常") {
  return [
    "🧩 QQ 功能菜单",
    `朗读语调：当前「${TTS_STYLE_NAMES[normalizeTtsStyle(style)] || "正常"}」`,
    "普通文字回复仍然是文字；使用读：内容 / 温柔读：内容 / 播音读：内容 / 戏剧读：内容请求朗读。",
    "切换语调：朗读语调 温柔/播音/戏剧/正常；查询：当前语调。",
    "",
    "🎮 小游戏　📚 行测/答题　🤖 AI功能　🧰 其他工具",
    "发送“小游戏”查看全部分组；也可以直接发送游戏名或“小游戏 1”启动。",
    "控制：提示 / 查看进度 / 答案或解析 / 下一题 / 放弃",
    "AI玩法、其他工具：发送“AI玩法”或“其他工具”查看说明。",
    "OneBot 文本适配器不依赖 QQ 官方键盘，以上命令可直接发送。",
  ].join("\n");
}

export function parseInteractiveCommand(value) {
  const normalized = normalizeInteractiveCommand(value);
  if (!normalized) return null;
  if (["菜单", "功能菜单", "功能", "/menu"].includes(normalized)) return { kind: "menu" };
  const tone = /^(?:朗读语调|语调|tts)(?:\s+|[:：])?(温柔|播音|戏剧|正常|gentle|broadcast|dramatic|normal)$/i.exec(normalized);
  if (tone) return { kind: "tts-style", style: normalizeTtsStyle(tone[1]) };
  if (["当前语调", "语调状态", "/tts status"].includes(normalized.toLowerCase())) return { kind: "tts-status" };
  const read = readRequest(normalized);
  if (read) return { kind: "read", ...read };
  if (["小游戏", "游戏", "海龟汤", "海龟汤帮助", "成语接龙帮助", "接龙帮助", "猜成语帮助"].includes(normalized)) {
    return { kind: "game-help" };
  }
  const numbered = /^(?:小游戏|游戏)(?:\s+|第)?(?:第)?([0-9]+)$/.exec(normalized);
  if (numbered) {
    const entry = GAME_ENTRIES[Number(numbered[1]) - 1];
    return entry ? { kind: "chat-game-start", game: entry[0], mode: "same" } : { kind: "game-help" };
  }
  const categoryPage = /^(?:小游戏|游戏)\s*(规则|题库|行测)\s*(?:第)?([0-9]+)页$/.exec(normalized);
  if (categoryPage) return { kind: "game-help", category: categoryPage[1], page: Number(categoryPage[2]) };
  const page = /^(?:小游戏|游戏)(?:\s+)?(?:第)?([0-9]+)页$/.exec(normalized);
  if (page) return { kind: "game-help", category: "", page: Number(page[1]) };
  const category = /^(?:小游戏|游戏)\s*(规则|题库|行测)$/.exec(normalized);
  if (category) return { kind: "game-help", category: category[1] };
  if (["行测帮助", "行测题库", "行测答题"].includes(normalized)) {
    return { kind: "game-help", category: "行测" };
  }
  if (["AI玩法", "AI功能"].includes(normalized)) return { kind: "menu-ai" };
  if (["其他工具", "工具"].includes(normalized)) return { kind: "menu-other" };
  const examStart = /^(?:\/?行测|开始行测)(?:\s+|[:：])?(常识判断|常识|言语理解|言语|判断推理|判断|数量关系|数量|资料分析|资料)?$/.exec(normalized);
  if (examStart) return { kind: "chat-game-start", game: "exam", category: examStart[1] || "", mode: "same" };
  const turtleStart = /^(?:\/)?开始海龟汤(?:\s*(?:[:：,，]\s*|\s+)(.+))?$/.exec(normalized);
  if (turtleStart) return { kind: "game-start", theme: turtleStart[1] || "" };
  const chainStart = /^(?:\/)?(?:开始)?成语接龙(?:\s+(同字|同音|谐音))?$/.exec(normalized);
  if (chainStart) return { kind: "chat-game-start", game: "idiom-chain", mode: chainStart[1] || "same" };
  if (["猜成语", "开始猜成语", "/猜成语"].includes(normalized)) {
    return { kind: "chat-game-start", game: "idiom-wordle", mode: "same" };
  }
  const entry = gameEntry(normalized.replace(/^开始/, ""));
  if (entry) return { kind: "chat-game-start", game: entry[0], mode: "same" };
  if (["提示", "给个提示", "来个提示", "海龟汤提示", "猜成语提示", "接龙提示"].includes(normalized)) return { kind: "game-hint" };
  if (["答案", "解析", "答案解析", "行测答案", "行测解析"].includes(normalized)) return { kind: "game-answer" };
  if (["下一题", "下一局", "再来一题"].includes(normalized)) return { kind: "game-question", text: normalized };
  if (["查看进度", "进度", "当前进度", "看进度", "统计", "排行榜"].includes(normalized)) return { kind: "game-status" };
  if (["放弃", "我放弃", "不玩了", "放弃游戏", "海龟汤结束", "结束成语接龙", "结束猜成语"].includes(normalized)) return { kind: "game-end" };
  return null;
}

export function isGameInputCandidate(value) {
  const normalized = normalizeInteractiveCommand(value);
  return Boolean(normalized && !parseInteractiveCommand(normalized));
}

function questionSummary(value) {
  const clean = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!clean) return "当前问题";
  const characters = Array.from(clean);
  return characters.length <= 80 ? clean : characters.slice(0, 79).join("") + "…";
}

function leaderboard(data) {
  const board = Array.isArray(data?.leaderboard) ? data.leaderboard : [];
  if (!board.length) return "暂无得分。";
  return board
    .map((item, index) => `${index + 1}. ${boundedName(item?.name)} ${String(item?.score ?? 0)}分`)
    .join("\n");
}

export function renderTurtleStart(data) {
  return [
    "🎮 海龟汤开始",
    "",
    "🤔 汤面：",
    String(data?.surface || ""),
    "",
    data?.notice ? "ℹ️ " + String(data.notice) : "",
    "直接发问题；需要提示就说“提示”，看状态就说“查看进度”，不想玩了就说“放弃”。",
    "📊 当前进度：" + String(data?.percent ?? 0) + "%",
  ].join("\n");
}

export function renderTurtleTurn(data) {
  const lines = [
    "❓问题：" + questionSummary(data?.question || data?.question_text || data?.text),
    "💬 主持人：" + String(data?.reply || "不重要"),
    "📊 进度：" + String(data?.percent ?? 0) + "%",
    "🔢 已提问：" + String(data?.questions_asked ?? 0) + "/" + String(data?.max_questions ?? 50),
  ];
  if (data?.ended) {
    lines.push("", "📖 完整答案：", String(data?.solution || ""));
    const hints = Array.isArray(data?.supplementary_info) ? data.supplementary_info : [];
    if (hints.length) lines.push("", "💡 相关线索：", hints.map((item) => "• " + String(item)).join("\n"));
  }
  return lines.join("\n");
}

export function renderTurtleStatus(data) {
  return [
    "📈 海龟汤进度",
    "🤔 汤面：" + String(data?.surface || ""),
    "📊 进度：" + String(data?.percent ?? 0) + "%",
    "🔢 已提问：" + String(data?.questions_asked ?? 0) + "/" + String(data?.max_questions ?? 50),
  ].join("\n");
}

export function renderTurtleEnd(data) {
  const lines = [
    "⏹ 海龟汤已结束",
    "🔢 总提问数：" + String(data?.questions_asked ?? 0),
    "",
    "📖 正确答案：",
    String(data?.solution || ""),
  ];
  const hints = Array.isArray(data?.supplementary_info) ? data.supplementary_info : [];
  if (hints.length) lines.push("", "💡 相关线索：", hints.map((item) => "• " + String(item)).join("\n"));
  return lines.join("\n");
}

export function renderChatStart(data) {
  if (data?.game_type && !["idiom-chain", "idiom-wordle"].includes(data.game_type)) {
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
      leaderboard(data),
    ].join("\n");
  }
  if (data?.game_type === "idiom-chain") {
    return [
      "🔗 成语接龙开始（" + String(data.mode_label || "同字接龙") + "）",
      "机器人先出：「" + String(data.current_word || "") + "」",
      "请直接发四字成语，接「" + String(data.target_char || "") + "」开头；任何人都可以接。",
      "提示：提示；状态：查看进度；结束：放弃。",
      "📏 当前长度：" + String(data.chain_length ?? 1) + "/" + String(data.max_rounds ?? 30),
    ].join("\n");
  }
  return [
    "🟩 猜成语开始",
    "群里共享同一个答案，直接发四字词语，最多猜" + String(data?.max_attempts ?? 10) + "次。",
    "🟩 位置正确　🟨 字在答案中但位置不对　⬜ 不在答案中",
    "提示：提示；状态：查看进度；结束：放弃。",
  ].join("\n");
}

function wordleRow(guess) {
  const word = Array.from(String(guess?.word || ""));
  const marks = Array.isArray(guess?.marks) ? guess.marks : [];
  const icons = { correct: "🟩", present: "🟨", absent: "⬜" };
  return word.map((char, index) => char + (icons[marks[index]] || "⬜")).join(" ");
}

export function renderChatTurn(data) {
  if (data?.game_type && !["idiom-chain", "idiom-wordle"].includes(data.game_type)) {
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
    if (data.leaderboard) lines.push("", "🏆 排行榜：", leaderboard(data));
    return lines.filter((line) => line !== "").join("\n");
  }
  if (data?.game_type === "idiom-chain") {
    const lines = [
      data.accepted === false
        ? "⚠️ " + String(data.message || "这条不能接。")
        : "✅ " + String(data.player || "群友") + " 接龙成功：「" + String(data.word || "") + "」",
    ];
    lines.push(
      data.accepted === false
        ? "当前仍需接：「" + String(data.target_char || "") + "」开头的四字成语。"
        : "下一棒：接「" + String(data.target_char || "") + "」开头的四字成语。",
      "📏 长度：" + String(data.chain_length ?? 0) + "/" + String(data.max_rounds ?? 30),
    );
    if (data.ended) {
      lines.push(
        "",
        data.end_reason === "max-rounds" ? "🏁 达到本局长度上限，游戏结束。" : "🏁 没有新的可接成语，游戏结束。",
        "🏆 排行榜：",
        leaderboard(data),
      );
    }
    return lines.join("\n");
  }
  const lines = [
    data.accepted === false ? "⚠️ " + String(data.message || "这条不能算一次猜测。") : wordleRow(data),
  ];
  if (data.accepted !== false) lines.push("👤 " + String(data.player || "群友") + "　剩余 " + String(data.remaining ?? 0) + " 次");
  if (data.ended) {
    lines.push(
      "",
      data.result === "win" ? "🎉 猜中了！" : "😵 次数用完了。",
      "📖 答案：「" + String(data.answer || "") + "」",
      data.explanation ? "释义：" + String(data.explanation) : "",
      "🏆 排行榜：",
      leaderboard(data),
    );
  }
  return lines.join("\n");
}

export function renderChatStatus(data) {
  if (data?.game_type && !["idiom-chain", "idiom-wordle"].includes(data.game_type)) {
    return [
      "📈 " + String(data.title || "小游戏") + "进度",
      data.exam_category ? "📚 题型：" + String(data.exam_category) : "",
      "🔢 第" + String(data.round ?? 1) + "题" + (data.awaiting_next ? "（已结束）" : "（进行中）"),
      "📌 题面：" + String(data.prompt || ""),
      "🏆 排行榜：",
      leaderboard(data),
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
      leaderboard(data),
    ].join("\n");
  }
  const guesses = Array.isArray(data?.guesses) ? data.guesses : [];
  const rows = guesses.map((guess) => String(guess?.player || "群友") + "：" + wordleRow(guess));
  return [
    "📈 猜成语进度",
    "已猜：" + String(data?.attempts ?? 0) + "/" + String(data?.max_attempts ?? 10) + "　剩余：" + String(data?.remaining ?? 0),
    rows.length ? rows.join("\n") : "还没有人提交猜测。",
    "提示次数：" + String(data?.hint_count ?? 0),
    "🏆 排行榜：",
    leaderboard(data),
  ].join("\n");
}

export function renderChatHint(data) {
  if (data?.game_type && !["idiom-chain", "idiom-wordle"].includes(data.game_type)) {
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
  return "💡 " + String(data?.message || "暂无可用提示。");
}

export function renderChatEnd(data) {
  if (data?.game_type && !["idiom-chain", "idiom-wordle"].includes(data.game_type)) {
    return [
      "⏹ " + String(data.title || "小游戏") + "已结束",
      data.answer !== undefined ? "📖 答案：" + String(data.answer) : "",
      data.explanation ? "📝 解析：" + String(data.explanation) : "",
      "🏆 排行榜：",
      leaderboard(data),
    ].join("\n");
  }
  if (data?.game_type === "idiom-chain") {
    return [
      "⏹ 成语接龙已结束",
      "链长：" + String(data.chain_length ?? 0),
      Array.isArray(data.chain) && data.chain.length ? data.chain.join(" → ") : "",
      "🏆 排行榜：",
      leaderboard(data),
    ].join("\n");
  }
  return [
    "⏹ 猜成语已结束",
    "📖 答案：「" + String(data?.answer || "") + "」",
    data?.explanation ? "释义：" + String(data.explanation) : "",
    "🏆 排行榜：",
    leaderboard(data),
  ].join("\n");
}

function requestSignal(timeoutMs) {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
}

async function gameRequest(baseUrl, pathname, payload, fetchImpl, timeoutMs, logger) {
  try {
    const signal = requestSignal(timeoutMs);
    const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      // A non-JSON failure is reported by status only.
    }
    return { status: response.status, data };
  } catch (error) {
    logger?.warn?.("[onebot] game service request failed: " + String(error?.message || error).slice(0, 160));
    return null;
  }
}

function gamePayload({ sessionId, playerId, playerName }) {
  return {
    session_id: String(sessionId),
    player_id: String(playerId || "anonymous"),
    player_name: boundedName(playerName),
  };
}

function unavailableText(action) {
  return action.kind === "chat-game-start" ? "文字小游戏服务暂时不可用，请稍后再试。" : "海龟汤主持服务暂时不可用，请稍后再试。";
}

export async function runInteractiveAction(
  action,
  {
    sessionId,
    playerId = "anonymous",
    playerName = "群友",
    gameServiceUrl = "http://127.0.0.1:18104",
    fetchImpl = globalThis.fetch,
    logger = console,
    ttsStyle = "normal",
  } = {},
) {
  if (!action) return { handled: false };
  if (action.kind === "menu") return { handled: true, text: menuText(ttsStyle) };
  if (action.kind === "tts-style") {
    const style = normalizeTtsStyle(action.style);
    return { handled: true, ttsStyle: style, text: `✅ 当前朗读语调已切换为「${TTS_STYLE_NAMES[style] || "正常"}」。之后显式朗读或语音入站回复时生效；普通文字回复仍然是文字。` };
  }
  if (action.kind === "tts-status") return { handled: true, text: `📊 当前朗读语调：「${TTS_STYLE_NAMES[normalizeTtsStyle(ttsStyle)] || "正常"}」` };
  if (action.kind === "menu-ai") {
    return {
      handled: true,
      text: "🤖 AI增强\n海龟汤：开始海龟汤，可附带悬疑/场景主题\n通用问答：@我后直接提问\n\n海龟汤的出题和主持使用现有模型；行测题干、答案、解析和基础判分直接来自题库，不依赖模型。",
    };
  }
  if (action.kind === "menu-other") {
    return {
      handled: true,
      text: "🧰 其他工具\n菜单：查看一级菜单\n读：内容：单次朗读\n提示 / 查看进度 / 答案 / 下一题 / 放弃：当前游戏控制",
    };
  }
  if (action.kind === "read") {
    return {
      handled: false,
      read: {
        text: action.text,
        style: normalizeTtsStyle(action.explicitStyle || ttsStyle),
      },
    };
  }
  if (action.kind === "game-help") {
    return { handled: true, text: gameHelp(action.category || "", action.page || 1) };
  }
  const payload = gamePayload({ sessionId, playerId, playerName });
  let request;
  let renderKind = action.kind;
  if (action.kind === "chat-game-start") {
    request = await gameRequest(
      gameServiceUrl,
      "/v1/chat-games/start",
      { ...payload, game: action.game, mode: action.mode || "same", category: action.category || "" },
      fetchImpl,
      30000,
      logger,
    );
    if (request?.status === 200 && request.data) {
      return {
        handled: true,
        active: request.data.active !== false,
        text: request.data.ok === false ? String(request.data.message || "当前已有进行中的小游戏。") : renderChatStart(request.data),
      };
    }
    return { handled: true, text: unavailableText(action) };
  }
  if (action.kind === "game-start") {
    request = await gameRequest(
      gameServiceUrl,
      "/v1/games/start",
      { session_id: payload.session_id, theme: action.theme || "" },
      fetchImpl,
      600000,
      logger,
    );
    if (request?.status === 200 && request.data) {
      return {
        handled: true,
        active: request.data.active !== false,
        text: request.data.ok === false ? String(request.data.message || "当前已有进行中的海龟汤。") : renderTurtleStart(request.data),
      };
    }
    return { handled: true, text: unavailableText(action) };
  }
  if (action.kind === "game-hint") {
    request = await gameRequest(gameServiceUrl, "/v1/chat-games/hint", payload, fetchImpl, 30000, logger);
    if (request?.status === 404) request = await gameRequest(gameServiceUrl, "/v1/games/hint", payload, fetchImpl, 30000, logger);
  } else if (action.kind === "game-answer") {
    request = await gameRequest(gameServiceUrl, "/v1/chat-games/answer", payload, fetchImpl, 30000, logger);
    if (request?.status === 404) {
      request = await gameRequest(gameServiceUrl, "/v1/games/end", payload, fetchImpl, 30000, logger);
      renderKind = "game-end";
    }
  } else if (action.kind === "game-status") {
    request = await gameRequest(gameServiceUrl, "/v1/chat-games/status", payload, fetchImpl, 30000, logger);
    if (request?.status === 404) request = await gameRequest(gameServiceUrl, "/v1/games/status", payload, fetchImpl, 30000, logger);
  } else if (action.kind === "game-end") {
    request = await gameRequest(gameServiceUrl, "/v1/chat-games/end", payload, fetchImpl, 30000, logger);
  } else if (action.kind === "game-input" || action.kind === "game-question") {
    request = await gameRequest(
      gameServiceUrl,
      "/v1/chat-games/input",
      { ...payload, text: action.text },
      fetchImpl,
      30000,
      logger,
    );
    if (request?.status === 404) {
      request = await gameRequest(
        gameServiceUrl,
        "/v1/games/ask",
        { session_id: payload.session_id, text: action.text },
        fetchImpl,
        600000,
        logger,
      );
    }
  } else {
    return { handled: false };
  }

  if (!request) return { handled: action.kind !== "game-input" && action.kind !== "game-question", text: unavailableText(action) };
  if (request.status === 404) return { handled: false };
  if (request.status !== 200 || !request.data) return { handled: true, text: unavailableText(action) };
  const data = request.data;
  if (data.game_type) {
    const legacyChatGame = ["idiom-chain", "idiom-wordle"].includes(data.game_type);
    let text;
    if (renderKind === "game-hint" || (renderKind === "game-answer" && !legacyChatGame)) text = renderChatHint(data);
    else if (renderKind === "game-answer" && legacyChatGame) text = renderChatEnd(data);
    else if (renderKind === "game-status") text = data.active ? renderChatStatus(data) : "当前没有进行中的文字小游戏。";
    else if (renderKind === "game-end") text = renderChatEnd(data);
    else text = renderChatTurn(data);
    return { handled: true, active: data.active === true, text };
  }
  if (renderKind === "game-hint") {
    const hint = data.hint
      ? "💡 提示 [" + String(data.current ?? 0) + "/" + String(data.total ?? 0) + "]：\n" + String(data.hint)
      : String(data.message || "暂无可用提示。");
    return { handled: true, active: data.active === true, text: hint };
  }
  if (renderKind === "game-status") return { handled: true, active: data.active === true, text: data.active ? renderTurtleStatus(data) : "当前没有进行中的海龟汤。" };
  if (renderKind === "game-end" || renderKind === "game-answer") return { handled: true, active: false, text: renderTurtleEnd(data) };
  return {
    handled: true,
    active: data.active === true,
    text: renderTurtleTurn({ ...data, question: data.question || action.text }),
  };
}

export function readPrompt(read, maxChars = 2000) {
  const text = String(read?.text || "").trim();
  const style = TTS_STYLE_NAMES[normalizeTtsStyle(read?.style)] || "正常";
  const safeText = Array.from(text).slice(0, maxChars).join("");
  return [
    "[QQ TTS tone instruction]",
    "This is an explicit read-aloud request. Keep the requested wording and punctuation.",
    `Use only [[tts:text]]【语气:${style}】${safeText}[[/tts:text]][[audio_as_voice]] and do not add a duplicate plain-text reply.`,
    "[/QQ TTS tone instruction]",
  ].join("\n");
}

export function splitInteractiveText(value, maxChars = 3500) {
  return splitTextForOneBot(value, maxChars);
}
