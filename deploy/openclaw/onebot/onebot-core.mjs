import crypto from "node:crypto";

const MAX_NORMALIZED_TEXT = 12000;
const MAX_SEGMENT_TEXT = 4000;

function stringValue(value) {
  return value === undefined || value === null ? "" : String(value);
}

function clampText(value, max = MAX_NORMALIZED_TEXT) {
  const text = stringValue(value);
  return Array.from(text).slice(0, max).join("");
}

function decodeCQValue(value) {
  const decoded = stringValue(value)
    .replace(/&#44;/g, ",")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&amp;/g, "&");
  try {
    return decodeURIComponent(decoded);
  } catch {
    return decoded;
  }
}

function parseCQAttributes(value) {
  const data = {};
  for (const item of stringValue(value).split(",")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    data[item.slice(0, separator)] = decodeCQValue(item.slice(separator + 1));
  }
  return data;
}

function parseCQMessage(value) {
  const source = stringValue(value);
  const segments = [];
  let cursor = 0;
  const pattern = /\[CQ:([a-zA-Z0-9_-]+)(?:,([^\]]*))?\]/g;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      segments.push({ type: "text", data: { text: source.slice(cursor, match.index) } });
    }
    segments.push({
      type: match[1],
      data: parseCQAttributes(match[2] || ""),
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) {
    segments.push({ type: "text", data: { text: source.slice(cursor) } });
  }
  return segments.length ? segments : [{ type: "text", data: { text: source } }];
}

export function parseOneBotSegments(message) {
  if (Array.isArray(message)) return message;
  if (typeof message === "string") return parseCQMessage(message);
  if (message && typeof message === "object" && typeof message.type === "string") return [message];
  return [];
}

function segmentData(segment) {
  return segment && typeof segment.data === "object" && segment.data !== null
    ? segment.data
    : {};
}

function firstValue(data, ...keys) {
  for (const key of keys) {
    const value = data?.[key];
    if (value !== undefined && value !== null && String(value) !== "") return String(value);
  }
  return "";
}

function displayName(sender) {
  return clampText(
    firstValue(sender, "card", "nickname", "username", "title") || "群友",
    80,
  );
}

function canonicalImage(segment) {
  const data = segmentData(segment);
  return {
    kind: "image",
    file: firstValue(data, "file", "file_id", "id"),
    url: firstValue(data, "url", "src"),
    name: clampText(firstValue(data, "name", "filename"), 160),
  };
}

function canonicalAudio(segment) {
  const data = segmentData(segment);
  return {
    kind: "audio",
    file: firstValue(data, "file", "file_id", "id"),
    url: firstValue(data, "url", "src"),
  };
}

function canonicalFile(segment) {
  const data = segmentData(segment);
  return {
    kind: "file",
    file: firstValue(data, "file", "file_id", "id"),
    name: clampText(firstValue(data, "name", "file_name", "filename"), 160).replace(/[\r\n\t]+/g, " "),
    url: firstValue(data, "url", "path"),
    size: firstValue(data, "size", "file_size"),
  };
}

function findRichValue(value, keys, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return "";
  const directText = (candidate) => typeof candidate === "string" ? clampText(candidate, 600).trim() : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRichValue(item, keys, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  for (const key of keys) {
    const direct = directText(value[key]);
    if (direct) return direct;
    const found = findRichValue(value[key], keys, depth + 1);
    if (found) return found;
  }
  for (const item of Object.values(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") continue;
    const found = findRichValue(item, keys, depth + 1);
    if (found) return found;
  }
  return "";
}

function richCardSummary(type, data) {
  const raw = data.data ?? data.content ?? data.text ?? data.title ?? data.prompt ?? data.description;
  let parsed = raw;
  if (type === "json" && typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }
  if (type === "json" && parsed && typeof parsed === "object") {
    const title = findRichValue(parsed, ["title", "name"]);
    const description = findRichValue(parsed, ["desc", "description", "prompt", "content"]);
    const parts = [];
    if (title) parts.push(`标题：${title}`);
    if (description && description !== title) parts.push(`说明：${description}`);
    return clampText(parts.join("；") || "JSON 卡片", 1200)
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[链接]")
      .replace(/[\r\n\t]+/g, " ");
  }
  if (type === "json") return "JSON 卡片（未提取到可读标题或说明）";
  return clampText(stringValue(raw), 1200)
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[链接]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

function canonicalSegment(segment, selfId) {
  if (typeof segment === "string") return { kind: "text", text: clampText(segment, MAX_SEGMENT_TEXT) };
  const type = stringValue(segment?.type).toLowerCase();
  const data = segmentData(segment);
  if (type === "text") {
    return { kind: "text", text: clampText(data.text, MAX_SEGMENT_TEXT) };
  }
  if (type === "at" || type === "mention") {
    const userId = firstValue(data, "qq", "user_id", "userId", "id");
    return {
      kind: "mention",
      user_id: userId,
      name: clampText(firstValue(data, "name", "display", "text"), 80),
      is_self: Boolean(selfId && userId && userId === String(selfId)),
    };
  }
  if (type === "image" || type === "flashimage") return canonicalImage(segment);
  if (type === "record" || type === "audio" || type === "voice") return canonicalAudio(segment);
  if (type === "file") return canonicalFile(segment);
  if (type === "reply" || type === "quote") {
    return { kind: "reply", message_id: firstValue(data, "id", "message_id", "messageId") };
  }
  if (type === "forward" || type === "node" || type === "nodes") {
    return {
      kind: "forward",
      id: firstValue(data, "id", "res_id", "forward_id"),
      title: clampText(firstValue(data, "title", "prompt"), 240),
    };
  }
  if (type === "json" || type === "xml" || type === "markdown" || type === "share") {
    return {
      kind: "rich",
      type,
      text: richCardSummary(type, data),
    };
  }
  return {
    kind: "other",
    type: type || "unknown",
    text: clampText(firstValue(data, "text", "title", "prompt"), 400),
  };
}

function quoteFromReply(replySegment, quotedMessage) {
  const messageId = stringValue(replySegment?.message_id);
  if (!messageId && !quotedMessage) return null;
  if (!quotedMessage) return { message_id: messageId };
  return {
    message_id: messageId || quotedMessage.message_id,
    user_id: quotedMessage.user_id,
    sender_name: quotedMessage.sender_name,
    text: quotedMessage.text,
    segments: quotedMessage.segments,
    images: quotedMessage.images,
    has_content: quotedMessage.has_content,
  };
}

function normalizePayload(payload, { selfId = "", quotedMessage = null, fallbackMessageType = "" } = {}) {
  if (!payload || typeof payload !== "object") return null;
  const messageType = stringValue(payload.message_type || fallbackMessageType).toLowerCase();
  const isGroup = messageType === "group" || payload.group_id !== undefined;
  const isPrivate = messageType === "private" || payload.user_id !== undefined;
  if (!isGroup && !isPrivate) return null;
  const sender = payload.sender && typeof payload.sender === "object" ? payload.sender : {};
  const userId = firstValue(payload, "user_id") || firstValue(sender, "user_id", "userId");
  const groupId = firstValue(payload, "group_id");
  const messageId = firstValue(payload, "message_id", "messageId", "id");
  const segments = parseOneBotSegments(payload.message ?? payload.raw_message ?? payload.content)
    .map((segment) => canonicalSegment(segment, selfId));
  const mentions = segments.filter((segment) => segment.kind === "mention");
  const images = segments.filter((segment) => segment.kind === "image");
  const files = segments.filter((segment) => segment.kind === "file");
  const replies = segments.filter((segment) => segment.kind === "reply");
  const text = clampText(
    segments
      .map((segment) => {
        if (segment.kind === "text") return segment.text;
        if (segment.kind === "mention") {
          if (segment.is_self) return "";
          return "@" + (segment.name || "群友");
        }
        if (segment.kind === "image") return "[图片]";
        if (segment.kind === "audio") return "[语音]";
        if (segment.kind === "file") return segment.name ? `[文件：${segment.name}]` : "[文件]";
        if (segment.kind === "reply") return "";
        if (segment.kind === "forward") return segment.title ? `[合并转发：${segment.title}]` : "[合并转发]";
        if (segment.kind === "rich") return segment.text ? `[卡片：${segment.text}]` : "[卡片]";
        return segment.text ? `[${segment.text}]` : "";
      })
      .join("")
      .replace(/[ \t\f\v]+/g, " ")
      .trim(),
  );
  const conversationId = isGroup ? `group:${groupId}` : `private:${userId}`;
  const route = isGroup
    ? { scope: "group", target_id: groupId }
    : { scope: "private", target_id: userId };
  const quote = quoteFromReply(replies[0], quotedMessage);
  return {
    kind: "message",
    transport: "onebot11",
    message_type: isGroup ? "group" : "private",
    user_id: userId,
    conversation_id: conversationId,
    message_id: messageId,
    sender_name: displayName(sender),
    text,
    segments,
    images,
    files,
    mentions,
    quote,
    self_mentioned: mentions.some((mention) => mention.is_self),
    replied_to_self: Boolean(quote?.user_id && selfId && quote.user_id === String(selfId)),
    has_content: Boolean(text || images.length || segments.some((segment) => segment.kind !== "text")),
    route,
  };
}

export function normalizeOneBotMessagePayload(payload, options = {}) {
  return normalizePayload(payload, options);
}

export function normalizeOneBotEvent(event, options = {}) {
  if (!event || typeof event !== "object" || event.post_type !== "message") return null;
  return normalizePayload(event, options);
}

export function parseCsv(value) {
  return new Set(
    stringValue(value)
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function stableOpaqueId(prefix, value) {
  const digest = crypto.createHash("sha256").update(stringValue(value)).digest("hex").slice(0, 24);
  return `${prefix}:${digest}`;
}

export function boundedName(value, fallback = "群友") {
  const name = clampText(value, 80).replace(/[\r\n\t]+/g, " ").trim();
  return name || fallback;
}

export function isExplicitCommandText(text) {
  const value = stringValue(text).trim();
  if (!value) return false;
  if (/^(?:\/menu|菜单|功能菜单|功能)$/.test(value)) return true;
  if (/^(?:(?:小游戏|游戏)(?:\s|$)|(?:行测|开始行测)(?:\s|$|[:：])|(?:开始海龟汤|(?:开始)?成语接龙|猜成语|开始猜成语|AI玩法|AI功能|其他工具|工具)(?:\s|$|[:：])|(?:朗读语调|语调|tts)(?:\s|[:：])|(?:温柔|播音|戏剧|正常)?读(?:\s|[:：]|$))/.test(value)) return true;
  return [
    "提示", "给个提示", "来个提示", "海龟汤提示", "猜成语提示", "接龙提示",
    "答案", "解析", "答案解析", "行测答案", "行测解析", "下一题", "下一局", "再来一题",
    "查看进度", "进度", "当前进度", "看进度", "统计", "排行榜", "放弃", "我放弃",
    "不玩了", "放弃游戏", "海龟汤结束", "结束成语接龙", "结束猜成语",
  ].includes(value);
}

export function decideMessageAccess(
  message,
  {
    allowedGroupIds = new Set(),
    allowedUserIds = new Set(),
    dmPolicy = "allowlist",
    groupRequireMention = true,
    commandsBypassMention = true,
    strictGroupMention = true,
    explicitCommand = false,
    activeGame = false,
  } = {},
) {
  if (!message || message.kind !== "message") return { allowed: false, reason: "not-message" };
  if (message.message_type === "group") {
    if (!allowedGroupIds.has("*") && !allowedGroupIds.has(String(message.route.target_id))) {
      return { allowed: false, reason: "group-not-allowlisted" };
    }
    if (
      groupRequireMention &&
      !message.self_mentioned &&
      (strictGroupMention || (
        !message.replied_to_self &&
        !(commandsBypassMention && explicitCommand) &&
        !activeGame
      ))
    ) {
      return { allowed: false, reason: "mention-required" };
    }
    return { allowed: true, reason: "group-allowed" };
  }
  if (dmPolicy === "disabled") return { allowed: false, reason: "private-disabled" };
  if (dmPolicy === "open") return { allowed: true, reason: "private-open" };
  if (!allowedUserIds.has(String(message.route.target_id))) {
    return { allowed: false, reason: "private-not-allowlisted" };
  }
  return { allowed: true, reason: "private-allowlisted" };
}

function contentText(value) {
  return clampText(value, 7000).replace(/[\r\n]+/g, " ").trim();
}

export function buildGatewayUserContent(
  message,
  { imageDataUrls = [], quoteImageDataUrls = [], recentContext = [], readInstruction = "" } = {},
) {
  const parts = [];
  const textSections = [];
  if (readInstruction) textSections.push(readInstruction);
  if (recentContext.length) {
    textSections.push(
      "【最近群聊候选上下文】\n" +
        recentContext
          .slice(-12)
          .map((item) => `- ${boundedName(item.sender_name)}：${contentText(item.text || "[非文字消息]")}`)
          .join("\n") +
        "\n只在与当前消息直接相关时使用这些候选，不要主动恢复无关旧话题。",
    );
  }
  if (message.quote) {
    const quoteText = contentText(message.quote.text) || (message.quote.images?.length ? "[引用图片]" : "[引用消息]");
    textSections.push(`【明确引用】\n${quoteText}`);
  }
  if (message.forward?.text) textSections.push(contentText(message.forward.text));
  if (message.text) textSections.push(message.text);
  if (!textSections.length && (imageDataUrls.length || quoteImageDataUrls.length)) {
    textSections.push("请先简要描述图片中可见的主要内容，再根据上下文自然回应；如果没有问题就给出简短反应。");
  }
  if (textSections.length) parts.push({ type: "text", text: textSections.join("\n\n") });
  for (const url of [...quoteImageDataUrls, ...imageDataUrls].slice(0, 1)) {
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts.length ? parts : [{ type: "text", text: "[空消息]" }];
}

function textFromGatewayContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      if (part && typeof part.content === "string") return part.content;
      return "";
    })
    .join("");
}

function mediaCandidate(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return stringValue(
    value.url ||
      value.mediaUrl ||
      value.file ||
      value.path ||
      value.image_url?.url ||
      value.audio_url?.url,
  ).trim();
}

function mediaCandidatesFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content.map(mediaCandidate).filter(Boolean);
}

export function normalizeGatewayResponse(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const message = choice?.message || choice?.delta || {};
  let text = textFromGatewayContent(message.content ?? choice?.text ?? payload?.text);
  const media = [];
  const mediaValues = [
    ...mediaCandidatesFromContent(message.content),
    ...(Array.isArray(message.mediaUrls) ? message.mediaUrls : []),
    ...(Array.isArray(message.media) ? message.media : []),
    ...(Array.isArray(message.attachments) ? message.attachments : []),
    ...(Array.isArray(payload?.mediaUrls) ? payload.mediaUrls : []),
    ...(Array.isArray(payload?.media) ? payload.media : []),
    ...(Array.isArray(payload?.attachments) ? payload.attachments : []),
    mediaCandidate(message.mediaUrl),
    mediaCandidate(payload?.mediaUrl),
  ];
  for (const value of mediaValues) {
    const candidate = mediaCandidate(value);
    if (candidate && !media.includes(candidate)) media.push(candidate);
  }
  text = text.replace(/^\s*MEDIA:\s*([^\r\n]+)\s*$/gim, (_match, value) => {
    const candidate = String(value).trim();
    if (candidate && !media.includes(candidate)) media.push(candidate);
    return "";
  });
  const ttsMatches = [...text.matchAll(/\[\[tts:([^\]]*)\]\]([\s\S]*?)\[\[\/tts(?::text)?\]\]/gi)];
  const ttsText = ttsMatches.map((match) => match[2].trim()).filter(Boolean).join("\n");
  const audioAsVoice = /\[\[audio_as_voice\]\]/i.test(text);
  text = text
    .replace(/\[\[tts:[^\]]*\]\][\s\S]*?\[\[\/tts(?::text)?\]\]/gi, "")
    .replace(/\[\[audio_as_voice\]\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text && ttsText && !media.length) text = ttsText;
  if (text === "NO_REPLY") text = "";
  return { text, media, ttsText, audioAsVoice };
}

export function splitTextForOneBot(value, maxChars = 3500) {
  const text = stringValue(value);
  if (!text) return [];
  const characters = Array.from(text);
  const chunks = [];
  for (let index = 0; index < characters.length; index += maxChars) {
    chunks.push(characters.slice(index, index + maxChars).join(""));
  }
  return chunks;
}

export function normalizeDataUrl(value, maxBytes = 20 * 1024 * 1024, allowedMimePrefixes = null) {
  const source = stringValue(value).trim();
  if (!source.startsWith("data:")) return null;
  const comma = source.indexOf(",");
  if (comma < 0 || !source.slice(0, comma).includes(";base64")) return null;
  const mime = source.slice(5, comma).split(";", 1)[0].trim().toLowerCase();
  if (!mime || (Array.isArray(allowedMimePrefixes) && !allowedMimePrefixes.some((prefix) => mime.startsWith(String(prefix).toLowerCase())))) {
    throw new Error("data URL media type is not allowed");
  }
  const encoded = source.slice(comma + 1).replace(/\s+/g, "");
  if (encoded.length > Math.ceil(maxBytes / 3) * 4 + 8) throw new Error("data URL exceeds media limit");
  return source;
}

export function logSafeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED_SECRET]")
    .replace(/([?&](?:access[_-]?token|api[_-]?key|client[_-]?secret|password|secret|token)=)[^&#\s]+/gi, "$1[REDACTED_SECRET]")
    .replace(/((?:access[_-]?token|api[_-]?key|client[_-]?secret|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED_SECRET]")
    .slice(0, 180);
}
