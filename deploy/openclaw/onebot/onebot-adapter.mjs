import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { WebSocketServer } from "ws";

import {
  boundedName,
  buildGatewayUserContent,
  decideMessageAccess,
  logSafeError,
  normalizeDataUrl,
  normalizeGatewayResponse,
  normalizeOneBotEvent,
  normalizeOneBotMessagePayload,
  parseCsv,
  splitTextForOneBot,
  stableOpaqueId,
} from "./onebot-core.mjs";
import {
  isGameInputCandidate,
  normalizeTtsStyle,
  parseInteractiveCommand,
  runInteractiveAction,
  TTS_STYLE_NAMES,
} from "./onebot-interactive.mjs";

const WS_OPEN = 1;
const DEFAULT_WS_PATH = "/onebot/v11/ws";
const DEFAULT_PORT = 16700;
const MAX_WS_PAYLOAD = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MEDIA_ROOTS = ["/home/node/.openclaw/workspace", "/tmp/openclaw"];
const DEFAULT_IMAGE_ALLOWED_HOSTS = ["multimedia.nt.qq.com.cn"];
const CONTEXT_TTL_MS = 60 * 60 * 1000;
const MAX_CONTEXT_CONVERSATIONS = 2048;

function stringValue(value) {
  return value === undefined || value === null ? "" : String(value);
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(?:1|true|yes|on)$/i.test(String(value).trim());
}

function integerValue(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function trimBaseUrl(value, fallback) {
  const candidate = String(value || fallback).trim();
  return candidate.replace(/\/+$/, "");
}

function normalizePath(value, fallback) {
  const candidate = String(value || fallback).trim();
  return candidate.startsWith("/") ? candidate : `/${candidate}`;
}

function configuredSecret(value) {
  const candidate = String(value || "").trim();
  return candidate && !candidate.startsWith("replace-with-") ? candidate : "";
}

function configuredImageHosts(value) {
  const hosts = parseCsv(value);
  const values = hosts.size ? [...hosts] : DEFAULT_IMAGE_ALLOWED_HOSTS;
  return new Set(values.map((item) => item.toLowerCase()));
}

export function loadConfig(env = process.env) {
  const wsCredential = configuredSecret(env.ONEBOT_ACCESS_TOKEN);
  if (!wsCredential) throw new Error("ONEBOT_ACCESS_TOKEN is required");
  const gatewayToken = configuredSecret(env.OPENCLAW_GATEWAY_TOKEN);
  if (!gatewayToken) throw new Error("OPENCLAW_GATEWAY_TOKEN is required");

  const allowedGroupIds = parseCsv(env.ONEBOT_ALLOWED_GROUP_IDS);
  if (booleanValue(env.ONEBOT_ALLOW_ALL_GROUPS, false)) allowedGroupIds.add("*");
  const dmPolicy = String(env.ONEBOT_DM_POLICY || "allowlist").trim().toLowerCase();
  if (!["allowlist", "open", "disabled"].includes(dmPolicy)) {
    throw new Error("ONEBOT_DM_POLICY must be allowlist, open, or disabled");
  }
  const mediaRoots = parseCsv(env.ONEBOT_MEDIA_ROOTS);
  return {
    wsHost: String(env.ONEBOT_WS_HOST || "0.0.0.0").trim(),
    wsPort: integerValue(env.ONEBOT_WS_PORT, DEFAULT_PORT, 1, 65535),
    wsPath: normalizePath(env.ONEBOT_WS_PATH, DEFAULT_WS_PATH),
    accessToken: wsCredential,
    selfId: String(env.ONEBOT_SELF_ID || "").trim(),
    allowedGroupIds,
    allowedUserIds: parseCsv(env.ONEBOT_ALLOWED_USER_IDS),
    adminUserIds: parseCsv(env.ONEBOT_ADMIN_USER_IDS),
    dmPolicy,
    groupRequireMention: booleanValue(env.ONEBOT_GROUP_REQUIRE_MENTION, true),
    commandsBypassMention: booleanValue(env.ONEBOT_COMMANDS_BYPASS_MENTION, true),
    strictGroupMention: booleanValue(env.ONEBOT_STRICT_GROUP_MENTION, true),
    gatewayUrl: trimBaseUrl(env.ONEBOT_GATEWAY_URL, "http://openclaw-gateway:18789"),
    gatewayToken,
    gatewayModel: String(env.ONEBOT_GATEWAY_MODEL || "openclaw/default").trim(),
    gatewayMessageChannel: String(env.ONEBOT_GATEWAY_MESSAGE_CHANNEL || "qqbot").trim(),
    gatewayTimeoutMs: integerValue(env.ONEBOT_GATEWAY_TIMEOUT_MS, 900000, 1000, 1800000),
    inboundDebounceMs: integerValue(env.ONEBOT_INBOUND_DEBOUNCE_MS, 700, 0, 10000),
    queueCap: integerValue(env.ONEBOT_QUEUE_CAP, 2, 1, 8),
    gameServiceUrl: trimBaseUrl(env.ONEBOT_GAME_SERVICE_URL, "http://qqbot-game:18104"),
    asrUrl: trimBaseUrl(env.ONEBOT_ASR_URL, ""),
    asrModel: String(env.ONEBOT_ASR_MODEL || "Qwen/Qwen3-ASR-1.7B").trim(),
    ttsUrl: trimBaseUrl(env.ONEBOT_TTS_URL, ""),
    ttsModel: String(env.ONEBOT_TTS_MODEL || "Qwen3-TTS-12Hz-1.7B-Base").trim(),
    ttsVoice: String(env.ONEBOT_TTS_VOICE || "serena").trim(),
    autoVoiceReply: booleanValue(env.ONEBOT_AUTO_VOICE_REPLY, true),
    audioMaxBytes: integerValue(env.ONEBOT_AUDIO_MAX_BYTES, 32 * 1024 * 1024, 1024, 32 * 1024 * 1024),
    imageAllowedHosts: configuredImageHosts(env.ONEBOT_IMAGE_ALLOWED_HOSTS),
    imageMaxBytes: integerValue(env.ONEBOT_IMAGE_MAX_BYTES, MAX_IMAGE_BYTES, 1024, MAX_IMAGE_BYTES),
    replyToMessage: booleanValue(env.ONEBOT_REPLY_TO_MESSAGE, true),
    textChunkSize: integerValue(env.ONEBOT_TEXT_CHUNK_SIZE, 3500, 200, 8000),
    mediaRoots: mediaRoots.size ? [...mediaRoots].map((item) => path.resolve(item)) : DEFAULT_MEDIA_ROOTS,
    logger: console,
  };
}

function tokenMatches(request, expected) {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !/^Bearer\s+/i.test(header)) return false;
  const supplied = header.replace(/^Bearer\s+/i, "").trim();
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function responseText(response, body = "") {
  const content = `HTTP/1.1 ${response}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  return content;
}

function oneBotNumericId(value) {
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    if (Number.isSafeInteger(number)) return number;
  }
  return text;
}

function mimeForPath(value, fallback = "application/octet-stream") {
  const extension = path.extname(String(value)).toLowerCase();
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".silk": "audio/silk",
  }[extension] || fallback;
}

function isPathInside(candidate, roots) {
  const resolved = path.resolve(candidate);
  return roots.some((root) => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(`${base}${path.sep}`);
  });
}

function base64SourceToDataUrl(source, mime = "application/octet-stream", maxBytes = MAX_IMAGE_BYTES) {
  const value = String(source || "").trim();
  if (!value.startsWith("base64://")) return null;
  const encoded = value.slice("base64://".length).replace(/\s+/g, "");
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length > maxBytes) throw new Error("base64 media exceeds limit");
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function dataUrlToOneBotSource(source, maxBytes, allowedMimePrefixes = null) {
  const dataUrl = normalizeDataUrl(source, maxBytes, allowedMimePrefixes);
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(",");
  const mime = dataUrl.slice(5, comma).split(";")[0] || "application/octet-stream";
  const buffer = Buffer.from(dataUrl.slice(comma + 1), "base64");
  if (buffer.length > maxBytes) throw new Error("data URL media exceeds limit");
  return { source: `base64://${buffer.toString("base64")}`, mime };
}

async function readLocalMedia(value, roots, maxBytes) {
  const candidate = String(value || "").replace(/^file:\/\//, "");
  if (!path.isAbsolute(candidate) || !isPathInside(candidate, roots)) return null;
  // Check the resolved path as well as the lexical path. A media path can be
  // supplied by a transport or a tool, so a symlink inside an allowed root
  // must not become a read primitive for an unrelated host file.
  let resolvedCandidate;
  try {
    resolvedCandidate = await fs.realpath(candidate);
  } catch {
    return null;
  }
  const resolvedRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        return await fs.realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );
  if (!isPathInside(resolvedCandidate, resolvedRoots)) return null;
  const data = await fs.readFile(resolvedCandidate);
  if (data.length > maxBytes) throw new Error("local media exceeds limit");
  return {
    source: `base64://${data.toString("base64")}`,
    mime: mimeForPath(resolvedCandidate),
  };
}

function mediaKind(value) {
  const source = String(value || "").toLowerCase();
  if (source.startsWith("data:audio/") || /\.(?:mp3|wav|ogg|flac|m4a|silk)(?:[?#]|$)/i.test(source)) return "record";
  return "image";
}

class OneBotConnection {
  constructor(adapter, socket, serial) {
    this.adapter = adapter;
    this.socket = socket;
    this.serial = serial;
    this.pending = new Map();
    this.echoCounter = 0;
    this.closed = false;
    this.selfId = adapter.selfId;
    socket.on("message", (data) => this.receive(data));
    socket.on("close", () => this.closePending(new Error("OneBot WebSocket closed")));
    socket.on("error", (error) => adapter.log("warn", "OneBot WebSocket error: " + logSafeError(error)));
  }

  receive(data) {
    let frame;
    try {
      frame = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    } catch {
      this.adapter.log("warn", "ignored invalid OneBot JSON frame");
      return;
    }
    if (frame && Object.prototype.hasOwnProperty.call(frame, "echo")) {
      const key = String(frame.echo);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (frame.status === "ok" && (frame.retcode === undefined || Number(frame.retcode) === 0)) pending.resolve(frame);
      else pending.reject(new Error(`OneBot action failed: ${pending.action}`));
      return;
    }
    if (frame?.post_type) {
      void this.adapter.handleEvent(this, frame).catch((error) => {
        this.adapter.log("error", "OneBot event handling failed: " + logSafeError(error));
      });
    }
  }

  call(action, params = {}, timeoutMs = 15000) {
    if (this.closed || this.socket.readyState !== WS_OPEN) return Promise.reject(new Error("OneBot WebSocket is not connected"));
    const echo = `${this.serial}-${++this.echoCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot action timed out: ${action}`));
      }, timeoutMs);
      this.pending.set(echo, { action, resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error);
      }
    });
  }

  close(code = 1000, reason = "closed") {
    if (this.closed) return;
    this.closed = true;
    this.closePending(new Error("OneBot WebSocket closed"));
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }

  closePending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class OneBotAdapter {
  constructor(config, { fetchImpl = globalThis.fetch, logger = config.logger || console } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.selfId = config.selfId || "";
    this.server = null;
    this.webSocketServer = null;
    this.currentConnection = null;
    this.connections = new Set();
    this.connectionSerial = 0;
    this.seenEvents = new Map();
    this.contexts = new Map();
    this.activeGames = new Set();
    this.ttsStyles = new Map();
    this.queues = new Map();
    this.startedAt = Date.now();
  }

  log(level, message) {
    const method = this.logger?.[level] || this.logger?.log;
    if (typeof method === "function") method.call(this.logger, message);
  }

  healthPayload() {
    return {
      ok: true,
      protocol: "onebot11-reverse-websocket",
      connected: Boolean(this.currentConnection && !this.currentConnection.closed),
      active_connections: this.connections.size,
      self_id_known: Boolean(this.selfId),
      active_game_conversations: this.activeGames.size,
      queued_messages: [...this.queues.values()].reduce(
        (total, queue) => total + queue.items.length + (queue.running ? 1 : 0),
        0,
      ),
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  async listen() {
    this.webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
    this.server = http.createServer((request, response) => {
      const url = new URL(request.url || "/", "http://onebot-adapter.invalid");
      if (request.method === "GET" && url.pathname === "/health") {
        const body = JSON.stringify(this.healthPayload());
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(body);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found\n");
    });
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url || "/", "http://onebot-adapter.invalid");
      if (url.pathname !== this.config.wsPath) {
        socket.end(responseText("404 Not Found", "not found\n"));
        return;
      }
      if (!tokenMatches(request, this.config.accessToken)) {
        socket.end(responseText("401 Unauthorized", "unauthorized\n"));
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit("connection", webSocket, request);
      });
    });
    this.webSocketServer.on("connection", (socket, request) => this.acceptConnection(socket, request));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.wsPort, this.config.wsHost, resolve);
    });
    this.log("info", `[onebot] adapter listening on ${this.config.wsHost}:${this.config.wsPort}${this.config.wsPath}`);
  }

  acceptConnection(socket, request) {
    if (this.currentConnection && !this.currentConnection.closed) this.currentConnection.close(1000, "replaced");
    const connection = new OneBotConnection(this, socket, ++this.connectionSerial);
    const headerSelfId = request?.headers?.["x-self-id"];
    const negotiatedSelfId = Array.isArray(headerSelfId) ? headerSelfId[0] : headerSelfId;
    if (negotiatedSelfId) {
      connection.selfId = String(negotiatedSelfId);
      this.selfId = connection.selfId;
    }
    this.currentConnection = connection;
    this.connections.add(connection);
    socket.on("close", () => {
      connection.closed = true;
      connection.closePending(new Error("OneBot WebSocket closed"));
      this.connections.delete(connection);
      if (this.currentConnection === connection) this.currentConnection = null;
      this.log("info", "[onebot] reverse WebSocket disconnected");
    });
    this.log("info", "[onebot] reverse WebSocket connected");
  }

  async close() {
    for (const queue of this.queues.values()) {
      if (queue.timer) clearTimeout(queue.timer);
    }
    this.queues.clear();
    for (const connection of this.connections) connection.close(1000, "shutdown");
    this.connections.clear();
    await new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    if (this.webSocketServer) this.webSocketServer.close();
    this.server = null;
    this.webSocketServer = null;
  }

  eventWasSeen(event) {
    const messageId = stringValue(event.message_id || event.messageId);
    if (!messageId) return false;
    const key = `${stringValue(event.post_type)}:${messageId}`;
    const now = Date.now();
    for (const [seenKey, timestamp] of this.seenEvents) {
      if (now - timestamp > 10 * 60 * 1000) this.seenEvents.delete(seenKey);
    }
    if (this.seenEvents.has(key)) return true;
    if (this.seenEvents.size >= 4096) this.seenEvents.delete(this.seenEvents.keys().next().value);
    this.seenEvents.set(key, now);
    return false;
  }

  boundaryAccess(message) {
    if (message.message_type === "group") {
      return this.config.allowedGroupIds.has("*") || this.config.allowedGroupIds.has(String(message.route.target_id));
    }
    if (this.config.dmPolicy === "disabled") return false;
    if (this.config.dmPolicy === "open") return true;
    return this.config.allowedUserIds.has(String(message.route.target_id));
  }

  async enrichQuote(connection, message) {
    const quoteId = message.quote?.message_id;
    if (!quoteId) return;
    try {
      const response = await connection.call("get_msg", { message_id: oneBotNumericId(quoteId) }, 12000);
      const payload = response?.data;
      const quoted = normalizeOneBotMessagePayload(payload, {
        selfId: connection.selfId || this.selfId,
        fallbackMessageType: message.message_type,
      });
      if (!quoted) return;
      message.quote = {
        message_id: quoteId,
        user_id: quoted.user_id,
        sender_name: quoted.sender_name,
        text: quoted.text,
        segments: quoted.segments,
        images: quoted.images,
        has_content: quoted.has_content,
      };
      message.replied_to_self = Boolean(
        message.quote.user_id && (connection.selfId || this.selfId) && message.quote.user_id === String(connection.selfId || this.selfId),
      );
    } catch {
      // A quote is still useful as an opaque reference even when get_msg is unavailable.
    }
  }

  async enrichForward(connection, message) {
    const forwards = message.segments.filter((segment) => segment.kind === "forward" && segment.id);
    if (!forwards.length) return;
    const lines = [];
    const images = [];
    const walk = (value, depth = 0) => {
      if (depth > 4 || lines.length >= 32 || value === null || value === undefined) return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      if (typeof value !== "object") return;
      const type = stringValue(value.type).toLowerCase();
      const data = value.data && typeof value.data === "object" ? value.data : value;
      const candidateContentKey = ["content", "message", "message_chain"].find((key) => data[key] !== undefined);
      const hasNodeIdentity = candidateContentKey && (
        data.user_id !== undefined ||
        data.uin !== undefined ||
        data.nickname !== undefined ||
        data.name !== undefined ||
        data.sender !== undefined
      );
      const isNode = type === "node" || Boolean(hasNodeIdentity);
      const contentKey = isNode ? candidateContentKey || "" : "";
      const content = contentKey ? data[contentKey] : undefined;
      if (isNode && content !== undefined) {
        const normalized = normalizeOneBotMessagePayload(
          {
            message_type: message.message_type,
            user_id: data.user_id ?? data.uin ?? data.sender?.user_id,
            sender: data.sender || { nickname: data.nickname || data.name },
            message: content,
          },
          { selfId: connection.selfId || this.selfId, fallbackMessageType: message.message_type },
        );
        if (normalized) {
          const text = normalized.text || (normalized.images.length ? "[图片]" : "[非文字消息]");
          lines.push(`${boundedName(normalized.sender_name)}：${text}`);
          images.push(...normalized.images);
        }
      }
      for (const key of ["message", "messages", "nodes", "records", "forward", "content", "message_chain"]) {
        if (data[key] !== undefined && key !== contentKey) walk(data[key], depth + 1);
      }
    };
    for (const segment of forwards) {
      try {
        const response = await connection.call("get_forward_msg", { id: String(segment.id) }, 15000);
        walk(response?.data);
      } catch {
        // A title/reference-only forward stays a truthful incomplete summary.
      }
    }
    if (lines.length || images.length) {
      message.forward = {
        text: lines.length
          ? `[合并转发内容]\n${lines.join("\n")}`
          : "[合并转发中包含图片]",
        images,
      };
    }
  }

  async resolveBinarySource(connection, media, fallbackAction, maxBytes) {
    const candidates = [media?.url, media?.file].filter(Boolean).map(String);
    for (const candidate of candidates) {
      if (candidate.startsWith("data:")) {
        const dataUrl = normalizeDataUrl(candidate, maxBytes, ["audio/"]);
        if (!dataUrl) continue;
        const comma = dataUrl.indexOf(",");
        if (comma < 0) continue;
        const header = dataUrl.slice(5, comma);
        const buffer = Buffer.from(dataUrl.slice(comma + 1), "base64");
        if (buffer.length > maxBytes) throw new Error("media exceeds limit");
        return { buffer, mime: header.split(";")[0] || "application/octet-stream" };
      }
      if (candidate.startsWith("base64://")) {
        const buffer = Buffer.from(candidate.slice("base64://".length), "base64");
        if (buffer.length > maxBytes) throw new Error("media exceeds limit");
        return { buffer, mime: mimeForPath(candidate) };
      }
      const local = await readLocalMedia(candidate, this.config.mediaRoots, maxBytes);
      if (local) return { buffer: Buffer.from(local.source.slice("base64://".length), "base64"), mime: local.mime };
      if (/^https?:\/\//i.test(candidate)) {
        const url = new URL(candidate);
        if (this.config.imageAllowedHosts.size && !this.config.imageAllowedHosts.has(url.hostname.toLowerCase())) {
          throw new Error("media host is not allowlisted");
        }
        const response = await this.fetch(candidate, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`media download returned HTTP ${response.status}`);
        const length = Number(response.headers.get("content-length") || 0);
        if (length > maxBytes) throw new Error("media content-length exceeds limit");
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) throw new Error("media response exceeds limit");
        return {
          buffer,
          mime: String(response.headers.get("content-type") || "").split(";", 1)[0] || mimeForPath(url.pathname),
        };
      }
    }
    if (media?.file && fallbackAction) {
      const response = await connection.call(fallbackAction, { file: String(media.file), out_format: "mp3" }, 15000);
      const data = response?.data || {};
      const candidate = data.url || data.file || data.path || data.base64;
      if (candidate) {
        if (data.base64 && candidate === data.base64) {
          const encoded = String(candidate).replace(/^base64:\/\//, "").replace(/\s+/g, "");
          const buffer = Buffer.from(encoded, "base64");
          if (buffer.length > maxBytes) throw new Error("media exceeds limit");
          return { buffer, mime: mimeForPath(data.file || data.path || "", "application/octet-stream") };
        }
        return await this.resolveBinarySource(connection, { url: candidate }, "", maxBytes);
      }
    }
    return null;
  }

  async enrichAudioTranscript(connection, message) {
    if (!this.config.asrUrl || !message.segments.some((segment) => segment.kind === "audio")) return;
    const audio = message.segments.find((segment) => segment.kind === "audio");
    try {
      const source = await this.resolveBinarySource(connection, audio, "get_record", this.config.audioMaxBytes);
      if (!source) return;
      const form = new FormData();
      const extension = source.mime.includes("silk") ? "silk" : source.mime.includes("wav") ? "wav" : "mp3";
      form.append("file", new Blob([source.buffer], { type: source.mime }), `onebot-audio.${extension}`);
      form.append("model", this.config.asrModel);
      const response = await this.fetch(`${this.config.asrUrl}/audio/transcriptions`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(900000),
      });
      if (!response.ok) {
        this.log("warn", `[onebot] ASR returned HTTP ${response.status}`);
        return;
      }
      const payload = await response.json();
      const transcript = stringValue(payload?.text || payload?.transcript).trim();
      if (!transcript) return;
      message.text = [message.text.replace(/\[语音\]/g, "").trim(), transcript].filter(Boolean).join("\n");
      message.voice_transcript = true;
    } catch (error) {
      this.log("warn", "[onebot] voice transcription unavailable: " + logSafeError(error));
    }
  }

  async synthesizeSpeech(text, style) {
    if (!this.config.ttsUrl || !String(text || "").trim()) return null;
    const cleanText = String(text).trim();
    const tone = TTS_STYLE_NAMES[normalizeTtsStyle(style)] || "正常";
    try {
      const response = await this.fetch(`${this.config.ttsUrl}/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg, audio/*;q=0.9, application/json" },
        body: JSON.stringify({
          model: this.config.ttsModel,
          input: `【语气:${tone}】${cleanText}`,
          voice: this.config.ttsVoice,
          response_format: "mp3",
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) {
        this.log("warn", `[onebot] TTS returned HTTP ${response.status}`);
        return null;
      }
      const audio = Buffer.from(await response.arrayBuffer());
      if (!audio.length || audio.length > this.config.audioMaxBytes) return null;
      return { type: "record", data: { file: `base64://${audio.toString("base64")}` } };
    } catch (error) {
      this.log("warn", "[onebot] TTS unavailable: " + logSafeError(error));
      return null;
    }
  }

  responseTtsStyle(text, fallback) {
    const match = /^\s*【语气:(温柔|播音|戏剧|正常)】/.exec(String(text || ""));
    return match ? normalizeTtsStyle(match[1]) : normalizeTtsStyle(fallback);
  }

  responseTtsText(text) {
    return String(text || "").replace(/^\s*【语气:(?:温柔|播音|戏剧|正常)】/, "").trim();
  }

  async handleEvent(connection, event) {
    // OneBot includes self_id on events as well as the reverse-WS handshake.
    // Keep the event value as a fallback for clients that omit X-Self-ID or
    // delay their lifecycle meta event; this is needed for @-gating and for
    // suppressing self-echoes.
    if (event.self_id !== undefined && event.self_id !== null && String(event.self_id).trim()) {
      connection.selfId = String(event.self_id);
      this.selfId = connection.selfId;
    }
    if (event.post_type === "meta_event") {
      return;
    }
    if (event.post_type !== "message" || !["group", "private"].includes(String(event.message_type))) return;
    if (event.message_type === "message_sent" || this.eventWasSeen(event)) return;
    const senderId = stringValue(event.user_id || event.sender?.user_id);
    if (this.selfId && senderId === this.selfId) return;
    const message = normalizeOneBotEvent(event, { selfId: connection.selfId || this.selfId });
    if (!message || !message.message_id || !this.boundaryAccess(message)) return;
    await this.enrichQuote(connection, message);

    const action = parseInteractiveCommand(message.text);
    const activeGame = this.activeGames.has(message.conversation_id);
    const access = decideMessageAccess(message, {
      allowedGroupIds: this.config.allowedGroupIds,
      allowedUserIds: this.config.allowedUserIds,
      dmPolicy: this.config.dmPolicy,
      groupRequireMention: this.config.groupRequireMention,
      commandsBypassMention: this.config.commandsBypassMention,
      strictGroupMention: this.config.strictGroupMention,
      explicitCommand: Boolean(action),
      activeGame,
    });
    if (!access.allowed) return;

    await this.enrichForward(connection, message);
    await this.enrichAudioTranscript(connection, message);
    const contextEntry = this.contexts.get(message.conversation_id);
    const recentContext = (Array.isArray(contextEntry) ? contextEntry : contextEntry?.items)?.slice(-12) || [];
    this.recordContext(message);
    this.enqueueMessage(connection, message, action, recentContext);
  }

  enqueueMessage(connection, message, action, recentContext) {
    let queue = this.queues.get(message.conversation_id);
    if (!queue) {
      queue = { items: [], running: false, timer: null };
      this.queues.set(message.conversation_id, queue);
    }
    queue.items.push({ connection, message, action, recentContext });
    while (queue.items.length > this.config.queueCap) queue.items.shift();
    if (!queue.running && !queue.timer) {
      queue.timer = setTimeout(() => {
        queue.timer = null;
        void this.pumpQueue(message.conversation_id, queue);
      }, this.config.inboundDebounceMs);
    }
  }

  async pumpQueue(conversationId, queue) {
    if (queue.running) return;
    const item = queue.items.shift();
    if (!item) {
      if (this.queues.get(conversationId) === queue) this.queues.delete(conversationId);
      return;
    }
    queue.running = true;
    try {
      await this.processMessage(
        item.connection,
        item.message,
        item.action,
        this.activeGames.has(conversationId),
        item.recentContext,
      );
    } catch (error) {
      this.log("error", "[onebot] queued message failed: " + logSafeError(error));
    } finally {
      queue.running = false;
      if (queue.items.length) {
        queue.timer = setTimeout(() => {
          queue.timer = null;
          void this.pumpQueue(conversationId, queue);
        }, this.config.inboundDebounceMs);
      } else if (this.queues.get(conversationId) === queue) {
        this.queues.delete(conversationId);
      }
    }
  }

  recordContext(message) {
    if (message.message_type !== "group") return;
    const now = Date.now();
    for (const [conversationId, entry] of this.contexts) {
      if (now - Number(entry?.updatedAt || 0) > CONTEXT_TTL_MS) this.contexts.delete(conversationId);
    }
    const entry = this.contexts.get(message.conversation_id) || { items: [], updatedAt: now };
    const items = Array.isArray(entry) ? entry : entry.items;
    items.push({
      sender_name: message.sender_name,
      text: message.text || (message.images.length ? "[图片]" : "[非文字消息]"),
    });
    while (items.length > 12) items.shift();
    this.contexts.set(message.conversation_id, { items, updatedAt: now });
    while (this.contexts.size > MAX_CONTEXT_CONVERSATIONS) this.contexts.delete(this.contexts.keys().next().value);
  }

  sessionId(message) {
    return stableOpaqueId("onebot-session", message.conversation_id);
  }

  playerId(message) {
    return stableOpaqueId("onebot-player", message.user_id);
  }

  currentStyle(message) {
    return normalizeTtsStyle(this.ttsStyles.get(message.conversation_id) || "normal");
  }

  async processMessage(connection, message, action, activeGame, recentContext) {
    if (this.config.strictGroupMention && message.message_type === "group" && !message.self_mentioned) return;
    if (message.text === "/onebot/status" || message.text === "OneBot状态") {
      if (this.config.adminUserIds.has(String(message.user_id))) {
        await this.sendText(connection, message, `OneBot 适配器在线；反向 WS：${this.healthPayload().connected ? "已连接" : "未连接"}；活跃游戏房间：${this.activeGames.size}。`);
      }
      return;
    }

    let effectiveAction = action;
    if (!effectiveAction && activeGame && isGameInputCandidate(message.text)) {
      effectiveAction = { kind: "game-input", text: message.text };
    }
    if (effectiveAction?.kind === "read") {
      if (!effectiveAction.text) {
        await this.sendText(connection, message, "用法：读：内容；也可以用温柔读：内容、播音读：内容或戏剧读：内容。", false);
        return;
      }
      const style = normalizeTtsStyle(effectiveAction.explicitStyle || this.currentStyle(message));
      const audio = await this.synthesizeSpeech(effectiveAction.text, style);
      if (audio) await this.sendReply(connection, message, "", [audio]);
      else await this.sendText(connection, message, effectiveAction.text);
      return;
    }
    if (effectiveAction) {
      const result = await runInteractiveAction(effectiveAction, {
        sessionId: this.sessionId(message),
        playerId: this.playerId(message),
        playerName: message.sender_name,
        gameServiceUrl: this.config.gameServiceUrl,
        fetchImpl: this.fetch,
        logger: this.logger,
        ttsStyle: this.currentStyle(message),
      });
      if (result.ttsStyle) this.ttsStyles.set(message.conversation_id, normalizeTtsStyle(result.ttsStyle));
      if (result.active === true) this.activeGames.add(message.conversation_id);
      if (result.active === false) this.activeGames.delete(message.conversation_id);
      if (result.handled) {
        if (result.text) await this.sendText(connection, message, result.text);
        return;
      }
      if (effectiveAction.kind === "game-input" || effectiveAction.kind === "game-question") this.activeGames.delete(message.conversation_id);
    }
    if (
      message.message_type === "group" &&
      this.config.groupRequireMention &&
      !message.self_mentioned &&
      !message.replied_to_self
    ) return;
    await this.handleGateway(connection, message, recentContext);
  }

  async fetchImageSource(connection, image, kind = "image") {
    const candidates = [image?.url, image?.file].filter(Boolean).map(String);
    for (const candidate of candidates) {
      try {
        const local = await readLocalMedia(candidate, this.config.mediaRoots, this.config.imageMaxBytes);
        if (local && kind === "image") {
          return base64SourceToDataUrl(local.source, local.mime, this.config.imageMaxBytes);
        }
        if (candidate.startsWith("data:")) return normalizeDataUrl(candidate, this.config.imageMaxBytes, ["image/"]);
        if (candidate.startsWith("base64://")) return base64SourceToDataUrl(candidate, "image/png", this.config.imageMaxBytes);
        if (/^https?:\/\//i.test(candidate)) return await this.downloadDataUrl(candidate);
      } catch (error) {
        this.log("warn", `[onebot] ${kind} media source rejected: ${logSafeError(error)}`);
      }
    }
    if (image?.file) {
      try {
        const response = await connection.call("get_image", { file: String(image.file) }, 15000);
        const data = response?.data || {};
        const candidate = data.url || data.file || data.path || data.base64;
        if (candidate) {
          if (data.base64 && candidate === data.base64) {
            const encoded = String(candidate).replace(/^base64:\/\//, "").replace(/\s+/g, "");
            const buffer = Buffer.from(encoded, "base64");
            if (buffer.length > this.config.imageMaxBytes) throw new Error("image exceeds limit");
            return `data:image/jpeg;base64,${buffer.toString("base64")}`;
          }
          return await this.fetchImageSource(connection, { url: candidate }, kind);
        }
      } catch {
        // The event remains a text-only media reference when NapCat cannot expose pixels.
      }
    }
    return null;
  }

  async downloadDataUrl(source) {
    const url = new URL(source);
    if (this.config.imageAllowedHosts.size && !this.config.imageAllowedHosts.has(url.hostname.toLowerCase())) {
      throw new Error("image host is not allowlisted");
    }
    const response = await this.fetch(source, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`image download returned HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > this.config.imageMaxBytes) throw new Error("image content-length exceeds limit");
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > this.config.imageMaxBytes) throw new Error("image response exceeds limit");
    const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    const fallbackMime = mimeForPath(url.pathname, "");
    if (contentType && !contentType.startsWith("image/") && contentType !== "application/octet-stream") {
      throw new Error("image response is not an image");
    }
    const mime = contentType.startsWith("image/") ? contentType : fallbackMime;
    if (!mime || !mime.startsWith("image/")) throw new Error("image response has no image media type");
    return `data:${mime};base64,${body.toString("base64")}`;
  }

  async resolveImages(connection, message) {
    const quoted = Array.isArray(message.quote?.images) ? message.quote.images : [];
    const current = [
      ...(Array.isArray(message.images) ? message.images : []),
      ...(Array.isArray(message.forward?.images) ? message.forward.images : []),
    ];
    const candidates = quoted.length ? quoted : current;
    if (!candidates.length) return { imageDataUrls: [], quoteImageDataUrls: [] };
    const resolved = await this.fetchImageSource(connection, candidates[0], "image");
    if (!resolved) return { imageDataUrls: [], quoteImageDataUrls: [] };
    return quoted.length
      ? { imageDataUrls: [], quoteImageDataUrls: [resolved] }
      : { imageDataUrls: [resolved], quoteImageDataUrls: [] };
  }

  sessionKey(message) {
    return `agent:main:onebot:${stableOpaqueId("conversation", message.conversation_id).split(":")[1]}`;
  }

  async handleGateway(connection, message, recentContext, { readInstruction = "" } = {}) {
    const imageRequest = /^(?:生图|画一张|生成图片)[:：]/.test(message.text || "");
    if (imageRequest) await this.sendText(connection, message, "收到，正在生成～", false);
    const media = await this.resolveImages(connection, message);
    const body = {
      model: this.config.gatewayModel,
      messages: [{
        role: "user",
        content: buildGatewayUserContent(message, { ...media, recentContext, readInstruction }),
      }],
      stream: false,
    };
    let response;
    try {
      response = await this.fetch(`${this.config.gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.gatewayToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-openclaw-session-key": this.sessionKey(message),
          "x-openclaw-message-channel": this.config.gatewayMessageChannel,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.gatewayTimeoutMs),
      });
    } catch (error) {
      this.log("warn", "[onebot] Gateway request failed: " + logSafeError(error));
      await this.sendText(connection, message, "模型服务暂时不可用，请稍后再试。", false);
      return;
    }
    if (!response.ok) {
      this.log("warn", `[onebot] Gateway returned HTTP ${response.status}`);
      await this.sendText(connection, message, "模型服务暂时不可用，请稍后再试。", false);
      return;
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      this.log("warn", "[onebot] Gateway returned invalid JSON: " + logSafeError(error));
      await this.sendText(connection, message, "模型服务返回异常，请稍后再试。", false);
      return;
    }
    const reply = normalizeGatewayResponse(payload);
    const sentMedia = await this.prepareOutboundMedia(reply.media);
    const requestedVoiceText = reply.ttsText || reply.text;
    const shouldVoiceReply = (message.voice_transcript && this.config.autoVoiceReply) || reply.audioAsVoice;
    if (shouldVoiceReply && requestedVoiceText && !sentMedia.length) {
      const audio = await this.synthesizeSpeech(
        this.responseTtsText(requestedVoiceText),
        this.responseTtsStyle(requestedVoiceText, this.currentStyle(message)),
      );
      if (audio) {
        await this.sendReply(connection, message, "", [audio]);
        return;
      }
    }
    if (reply.text || sentMedia.length) await this.sendReply(connection, message, reply.text, sentMedia);
  }

  async prepareOutboundMedia(media) {
    const prepared = [];
    for (const source of Array.isArray(media) ? media.slice(0, 4) : []) {
      try {
        const value = String(source || "").trim();
        if (!value) continue;
        const kind = mediaKind(value);
        const maxBytes = kind === "record" ? this.config.audioMaxBytes : this.config.imageMaxBytes;
        const allowedMimePrefixes = kind === "record" ? ["audio/"] : ["image/"];
        const data = dataUrlToOneBotSource(value, maxBytes, allowedMimePrefixes);
        if (data) {
          prepared.push({ type: data.mime.startsWith("audio/") ? "record" : "image", data: { file: data.source } });
          continue;
        }
        const base64 = base64SourceToDataUrl(value, mimeForPath(value), maxBytes);
        if (base64) {
          const converted = dataUrlToOneBotSource(base64, maxBytes, allowedMimePrefixes);
          prepared.push({ type: converted.mime.startsWith("audio/") ? "record" : "image", data: { file: converted.source } });
          continue;
        }
        if (/^https?:\/\//i.test(value)) {
          const url = new URL(value);
          if (this.config.imageAllowedHosts.size && !this.config.imageAllowedHosts.has(url.hostname.toLowerCase())) continue;
          prepared.push({ type: mediaKind(value), data: { file: value } });
          continue;
        }
        const local = await readLocalMedia(value, this.config.mediaRoots, maxBytes);
        if (local) {
          if (!local.mime.startsWith(kind === "record" ? "audio/" : "image/")) continue;
          prepared.push({ type: kind, data: { file: local.source } });
        }
      } catch (error) {
        this.log("warn", "[onebot] outbound media omitted: " + logSafeError(error));
      }
    }
    return prepared;
  }

  async sendReply(connection, message, text, media = []) {
    const textChunks = splitTextForOneBot(text, this.config.textChunkSize);
    let first = true;
    for (const chunk of textChunks) {
      await this.sendMessage(connection, message, [{ type: "text", data: { text: chunk } }], first);
      first = false;
    }
    for (const segment of media) {
      await this.sendMessage(connection, message, [segment], first);
      first = false;
    }
  }

  async sendText(connection, message, text, includeReply = this.config.replyToMessage) {
    const chunks = splitTextForOneBot(text, this.config.textChunkSize);
    for (let index = 0; index < chunks.length; index += 1) {
      await this.sendMessage(connection, message, [{ type: "text", data: { text: chunks[index] } }], includeReply && index === 0);
    }
  }

  async sendMessage(connection, message, content, includeReply) {
    if (!connection || connection.closed || connection.socket.readyState !== WS_OPEN) return false;
    const segments = [];
    if (includeReply && this.config.replyToMessage && message.message_id) {
      segments.push({ type: "reply", data: { id: String(message.message_id) } });
    }
    segments.push(...content);
    const route = message.route || {};
    const action = route.scope === "group" ? "send_group_msg" : "send_private_msg";
    const params = route.scope === "group"
      ? { group_id: oneBotNumericId(route.target_id), message: segments }
      : { user_id: oneBotNumericId(route.target_id), message: segments };
    try {
      await connection.call(action, params, 30000);
      return true;
    } catch (error) {
      this.log("warn", `[onebot] ${action} failed: ${logSafeError(error)}`);
      return false;
    }
  }
}

export async function startFromEnvironment() {
  const adapter = new OneBotAdapter(loadConfig());
  await adapter.listen();
  const shutdown = async () => {
    await adapter.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return adapter;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startFromEnvironment().catch((error) => {
    console.error("[onebot] adapter failed to start: " + logSafeError(error));
    process.exitCode = 1;
  });
}
