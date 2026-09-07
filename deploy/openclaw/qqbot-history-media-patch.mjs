import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildInjectedMediaPolicySource } from "./media-policy.mjs";
import {
  buildInjectedQqbotContextPolicySource,
  QQBOT_CONTEXT_POLICY_MARKER,
} from "./qqbot-context-policy-core.mjs";

const PATCH_MARKER = "/* qqbot-history-media-v1 */";
const MEDIA_CAPABILITY_MARKER = "/* qqbot-media-capabilities-v1 */";
const VIDEO_MENTION_GATE_MARKER = "/* qqbot-video-mention-gate-v2 */";
const LEGACY_VIDEO_MENTION_GATE_MARKER = "/* qqbot-video-mention-gate-v1 */";
const HISTORICAL_MEDIA_DISABLED_MARKER = "/* qqbot-historical-media-disabled-v2 */";
const QUOTE_IMAGE_CONTEXT_MARKER = "/* qqbot-single-image-context-v1 */";
const QUOTE_MEDIA_PREFETCH_MARKER = "/* qqbot-quote-media-prefetch-v1 */";
const TENCENT_MEDIA_OVERLAY_MARKER = "/* qqbot-tencent-media-overlay-v4 */";
const LEGACY_TENCENT_MEDIA_OVERLAY_MARKERS = [
  "/* qqbot-tencent-media-overlay-v3 */",
  "/* qqbot-tencent-media-overlay-v2 */",
  "/* qqbot-tencent-media-overlay-v1 */",
];
const TENCENT_QQ_MEDIA_PROXY_MARKER = "/* qqbot-qq-media-proxy-v1 */";
const TENCENT_FORWARD_RECORD_MARKER = "/* qqbot-forward-record-v1 */";
const TENCENT_CANONICAL_MEDIA_MARKER = "/* qqbot-canonical-inbound-media-v1 */";
const TENCENT_ATTACHMENT_NORMALIZATION_MARKER = "/* qqbot-tencent-attachment-normalization-v1 */";
const TENCENT_IMAGE_GENERATION_PROGRESS_MARKER = "/* qqbot-image-generation-progress-v4 */";
const TENCENT_CONTEXT_POLICY_MARKER = QQBOT_CONTEXT_POLICY_MARKER;
const LEGACY_TENCENT_IMAGE_GENERATION_PROGRESS_MARKERS = [
  "/* qqbot-image-generation-progress-v3 */",
  "/* qqbot-image-generation-progress-v2 */",
  "/* qqbot-image-generation-progress-v1 */",
];
const LEGACY_MARKER_REPLACEMENTS = [
  ["/* hermes-qq-history-media-v1 */", PATCH_MARKER],
  ["/* hermes-qq-media-capabilities-v1 */", MEDIA_CAPABILITY_MARKER],
  ["/* hermes-qq-video-mention-gate-v2 */", VIDEO_MENTION_GATE_MARKER],
  ["/* hermes-qq-video-mention-gate-v1 */", LEGACY_VIDEO_MENTION_GATE_MARKER],
  ["/* hermes-qq-historical-media-disabled-v2 */", HISTORICAL_MEDIA_DISABLED_MARKER]
];
const MEDIA_CAPABILITIES_PATH = "/home/node/.openclaw/media-capabilities.json";
const stateDir = process.env.OPENCLAW_STATE_DIR || "/home/node/.openclaw";
const projectsDir = path.join(stateDir, "npm", "projects");

function findGatewayBundle() {
  if (!fs.existsSync(projectsDir)) return null;
  for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const distDir = path.join(
      projectsDir,
      project.name,
      "node_modules",
      "@openclaw",
      "qqbot",
      "dist",
    );
    if (!fs.existsSync(distDir)) continue;
    for (const file of fs.readdirSync(distDir)) {
      if (!/^gateway-.*\.js$/.test(file)) continue;
      const candidate = path.join(distDir, file);
      const source = fs.readFileSync(candidate, "utf8");
      if (
        source.includes("function buildInboundContext(event, deps)") &&
        source.includes("async function processAttachments(attachments, ctx)")
      ) {
        return candidate;
      }
    }
  }
  return null;
}

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
      source.includes("function historyBuffer(options = {})") &&
      source.includes("function attachmentProcessor(opts)") &&
      source.includes("function buildCtxPayload(params)")
    ) {
      candidates.push({
        file: candidate,
        mtimeMs: fs.statSync(candidate).mtimeMs,
      });
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.file ?? null;
}

function replaceOnce(source, label, before, after) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`QQ history-media patch marker not found: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`QQ history-media patch marker is ambiguous: ${label}`);
  }
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

function normalizeLegacyMarkers(source) {
  for (const [legacy, current] of LEGACY_MARKER_REPLACEMENTS) {
    if (!source.includes(legacy)) continue;
    source = source.replaceAll(legacy, current);
  }
  return source;
}

function upgradeMediaCapabilityGate(source) {
  const legacyHelper = `function readMediaCapabilities() {
	try {
		const value = JSON.parse(fs$1.readFileSync("${MEDIA_CAPABILITIES_PATH}", "utf8"));
		return { image: value.image === true, video: value.video === true };
	} catch {
		return { image: false, video: false };
	}
}

function filterMediaByCapability(processed) {
	const capabilities = readMediaCapabilities();
	return {
		...processed,
		imageUrls: capabilities.image ? (processed.imageUrls ?? []) : [],
		imageMediaTypes: capabilities.image ? (processed.imageMediaTypes ?? []) : [],
		videoAttachmentPaths: capabilities.video ? (processed.videoAttachmentPaths ?? []) : [],
		videoAttachmentTypes: capabilities.video ? (processed.videoAttachmentTypes ?? []) : []
	};
}

${MEDIA_CAPABILITY_MARKER}
`;
  const videoHelper = `function filterVideoByMention(processed, allowVideo) {
	if (allowVideo) return processed;
	return {
		...processed,
		videoAttachmentPaths: [],
		videoAttachmentTypes: []
	};
}

${VIDEO_MENTION_GATE_MARKER}
`;
  const helper = `${buildInjectedMediaPolicySource(MEDIA_CAPABILITIES_PATH)}\n${MEDIA_CAPABILITY_MARKER}\n${VIDEO_MENTION_GATE_MARKER}\n`;
  const existingVideoGateCall = /\n\t\/\* qqbot-video-mention-gate-v[12] \*\/\n\tprocessed = filterVideoByMention\(\n\t\tprocessed,\n\t\t!event\?\.groupOpenid \|\| groupInfo\?\.gate\?\.effectiveWasMentioned === true,\n\t\);\n/g;
  source = source.replace(existingVideoGateCall, "\n");
  if (!source.includes(MEDIA_CAPABILITY_MARKER)) {
    source = source.replace(`${PATCH_MARKER}\n`, `${helper}${PATCH_MARKER}\n`);
  } else if (
    !source.includes("function ensureLocalQqImage(")
    || !source.includes("function extractQqMediaDownloadUrl(")
    || !source.includes("function downloadQqImageToLocal(")
    || !source.includes('async function resolveQuoteImageMedia(attachments, account, deps, log, text = "", processed = null)')
  ) {
    const helperStart = source.indexOf("function readMediaCapabilities() {");
    const markerIndex = source.indexOf(MEDIA_CAPABILITY_MARKER, helperStart);
    if (helperStart < 0 || markerIndex < 0) {
      throw new Error("QQ media capability patch found an unversioned helper block");
    }
    source = `${source.slice(0, helperStart)}${buildInjectedMediaPolicySource(MEDIA_CAPABILITIES_PATH)}${source.slice(markerIndex)}`;
  }
  if (!source.includes("function filterVideoByMention(processed, allowVideo)")) {
    source = source.replace(`${MEDIA_CAPABILITY_MARKER}\n`, `${helper}`);
  } else {
    source = source.replaceAll(LEGACY_VIDEO_MENTION_GATE_MARKER, VIDEO_MENTION_GATE_MARKER);
  }
  let userContentPrefix = source.includes(`\tlet { parsedContent, userContent } = buildUserContent({`)
    ? `\tlet { parsedContent, userContent } = buildUserContent({`
    : `\tconst { parsedContent, userContent } = buildUserContent({`;
  if (!source.includes("userContent = sanitizeQqMediaUrls(userContent)")) {
    const tab = String.fromCharCode(9);
    const constContentPrefix = tab + "const { parsedContent, userContent } = buildUserContent({";
    const letContentPrefix = tab + "let { parsedContent, userContent } = buildUserContent({";
    if (source.includes(constContentPrefix)) {
      source = replaceOnce(source, "mutable-user-content", constContentPrefix, letContentPrefix);
      userContentPrefix = letContentPrefix;
    }
    const replyQuoteLine = tab + "const replyTo = await resolveQuote(event, deps);";
    source = replaceOnce(
      source,
      "sanitize-qq-media-content",
      replyQuoteLine,
      [
        tab + "parsedContent = sanitizeQqMediaUrls(parsedContent);",
        tab + "userContent = sanitizeQqMediaUrls(userContent);",
        replyQuoteLine,
      ].join("\n"),
    );
  }
  if (!source.includes("processed = filterMediaByCapability(processed);")) {
    source = replaceOnce(
      source,
      "direct-media-capability-filter",
      userContentPrefix,
      `\tprocessed = filterMediaByCapability(processed);\n${userContentPrefix}`,
    );
  }
  if (!source.includes("processed = filterVideoByMention(")) {
    const gateAnchor = `\t}\n\t/* ${HISTORICAL_MEDIA_DISABLED_MARKER.slice(3, -3)} */`;
    if (source.includes(gateAnchor)) {
      source = replaceOnce(
        source,
        "video-gate-after-group-info",
        gateAnchor,
        `\t}
\t${VIDEO_MENTION_GATE_MARKER}
\tprocessed = filterVideoByMention(
\t\tprocessed,
\t\t!event?.groupOpenid || groupInfo?.gate?.effectiveWasMentioned === true,
\t);
\t/* ${HISTORICAL_MEDIA_DISABLED_MARKER.slice(3, -3)} */`,
      );
    }
  }
  if (!source.includes("processed = mergeSingleQuotedImage(processed")) {
    const replyQuoteLine = `\tconst replyTo = await resolveQuote(event, deps);`;
    source = replaceOnce(
      source,
      "single-image-context",
      replyQuoteLine,
      `${replyQuoteLine}
\tconst recentImage = event.type === "group" && event.groupOpenid && deps.groupHistories
\t\t? selectRecentGroupImage(deps.groupHistories.get(event.groupOpenid), userContent)
\t\t: null;
\tprocessed = mergeSingleQuotedImage(processed, replyTo, recentImage, userContent);`,
    );
  }
  if (!source.includes("recentImage = await ensureLocalQqImage")) {
    const tab = String.fromCharCode(9);
    const recentImageBlock = [
      tab + "const recentImage = event.type === \"group\" && event.groupOpenid && deps.groupHistories",
      tab.repeat(2) + "? selectRecentGroupImage(deps.groupHistories.get(event.groupOpenid), userContent)",
      tab.repeat(2) + ": null;",
      tab + "processed = mergeSingleQuotedImage(processed, replyTo, recentImage, userContent);",
    ].join("\n");
    const recentImageWithFetch = [
      tab + "let recentImage = event.type === \"group\" && event.groupOpenid && deps.groupHistories",
      tab.repeat(2) + "? selectRecentGroupImage(deps.groupHistories.get(event.groupOpenid), userContent)",
      tab.repeat(2) + ": null;",
      tab + "if (!processed.imageUrls?.length && !replyTo?.media?.[0]) recentImage = await ensureLocalQqImage(recentImage, account, deps, log);",
      tab + "processed = mergeSingleQuotedImage(processed, replyTo, recentImage, userContent);",
    ].join("\n");
    if (source.includes(recentImageBlock)) {
      source = replaceOnce(source, "recent-qq-image-prefetch", recentImageBlock, recentImageWithFetch);
    }
  }
  source = addQuoteImageContext(source);
  return source;
}

function disableHistoricalMediaPromotion(source) {
  if (source.includes(HISTORICAL_MEDIA_DISABLED_MARKER)) return source;

  const historicalBlock = /\n\tif \(groupInfo\?\.gate\?\.effectiveWasMentioned && !event\.attachments\?\.length && event\.groupOpenid\) \{[\s\S]*?\n\t\}\n\tconst body = buildBody\(\{/;
  if (historicalBlock.test(source)) {
    return source.replace(
      historicalBlock,
      `\n\t${HISTORICAL_MEDIA_DISABLED_MARKER}\n\tconst body = buildBody({`,
    );
  }

  if (source.includes("resolveLatestHistoricalMedia") || source.includes("promoteHistoricalMedia")) {
    throw new Error("QQ history-media patch found an unexpected historical-media block");
  }

  return source.replace(
    "async function buildInboundContext(event, deps) {",
    `${HISTORICAL_MEDIA_DISABLED_MARKER}\nasync function buildInboundContext(event, deps) {`,
  );
}

function patchBundle(file) {
  let source = fs.readFileSync(file, "utf8");
  source = normalizeLegacyMarkers(source);
  if (source.includes(PATCH_MARKER)) {
    const upgraded = upgradeMediaCapabilityGate(disableHistoricalMediaPromotion(source));
    if (upgraded === source) return false;
    const tempFile = `${file}.qqbot-history-media.tmp`;
    fs.writeFileSync(tempFile, upgraded, "utf8");
    fs.renameSync(tempFile, file);
    return true;
  }

  source = replaceOnce(
    source,
    "empty-result",
    `\tattachmentLocalPaths: []\n};`,
    `\tattachmentLocalPaths: [],\n\tvideoAttachmentPaths: [],\n\tvideoAttachmentTypes: []\n};`,
  );
  source = replaceOnce(
    source,
    "attachment-state",
    `\tconst attachmentLocalPaths = [];\n\tconst otherAttachments = [];`,
    `\tconst attachmentLocalPaths = [];\n\tconst videoAttachmentPaths = [];\n\tconst videoAttachmentTypes = [];\n\tconst otherAttachments = [];`,
  );
  source = replaceOnce(
    source,
    "video-result-type",
    `\t\t\t\tfilename: att.filename,\n\t\t\t\tmeta`,
    `\t\t\t\tfilename: att.filename,\n\t\t\t\tcontentType: att.content_type,\n\t\t\t\tmeta`,
  );
  source = replaceOnce(
    source,
    "video-result-collection",
    `\t\t} else if (result.type === "other" && result.localPath) {\n\t\t\totherAttachments.push(\`[Attachment: \${result.localPath}]\`);\n\t\t\tattachmentLocalPaths.push(result.localPath);`,
    `\t\t} else if (result.type === "other" && result.localPath) {\n\t\t\tif (result.contentType?.startsWith("video/")) {\n\t\t\t\tvideoAttachmentPaths.push(result.localPath);\n\t\t\t\tvideoAttachmentTypes.push(result.contentType);\n\t\t\t} else {\n\t\t\t\totherAttachments.push(\`[Attachment: \${result.localPath}]\`);\n\t\t\t}\n\t\t\tattachmentLocalPaths.push(result.localPath);`,
  );
  source = replaceOnce(
    source,
    "processed-return",
    `\t\tvoiceTranscriptSources,\n\t\tattachmentLocalPaths\n\t};\n}`,
    `\t\tvoiceTranscriptSources,\n\t\tattachmentLocalPaths,\n\t\tvideoAttachmentPaths,\n\t\tvideoAttachmentTypes\n\t};\n}`,
  );
  source = replaceOnce(
    source,
    "classify-video",
    `\tconst uniqueVoicePaths = uniqueStrings(processed.voiceAttachmentPaths);`,
    `\tconst videoPaths = processed.videoAttachmentPaths ?? [];\n\tconst videoTypes = processed.videoAttachmentTypes ?? [];\n\tfor (let i = 0; i < videoPaths.length; i++) {\n\t\tconst videoPath = videoPaths[i];\n\t\tif (!videoPath) continue;\n\t\tlocalMediaPaths.push(videoPath);\n\t\tlocalMediaTypes.push(videoTypes[i] ?? mimeTypeFromFilePath(videoPath) ?? "video/mp4");\n\t}\n\tconst uniqueVoicePaths = uniqueStrings(processed.voiceAttachmentPaths);`,
  );
  source = replaceOnce(
    source,
    "history-marker",
    `async function buildInboundContext(event, deps) {`,
    `${PATCH_MARKER}\n${HISTORICAL_MEDIA_DISABLED_MARKER}\nasync function buildInboundContext(event, deps) {`,
  );
  source = replaceOnce(
    source,
    "mutable-processed",
    `\tconst processed = await processAttachments(event.attachments, {`,
    `\tlet processed = await processAttachments(event.attachments, {`,
  );
  source = upgradeMediaCapabilityGate(source);

  const tempFile = `${file}.qqbot-history-media.tmp`;
  fs.writeFileSync(tempFile, source, "utf8");
  fs.renameSync(tempFile, file);
  return true;
}

function upgradeQuoteMediaPrefetch(source) {
  const tab = String.fromCharCode(9);
  if (source.includes(QUOTE_MEDIA_PREFETCH_MARKER)) {
    const cacheMissMediaLine = tab.repeat(3) + "media: imageMediaFromAttachments(refElement.attachments, quotedProcessed)";
    if (source.includes(cacheMissMediaLine)) {
      source = replaceOnce(
        source,
        "quote-media-prefetch-cache-miss",
        cacheMissMediaLine,
        tab.repeat(3) + "media: await resolveQuoteImageMedia(refElement.attachments, account, deps, log, refData.content, quotedProcessed)",
      );
    }
    return source;
  }
  const cachedMediaLine = tab.repeat(3) + "media: imageMediaFromAttachments(refEntry.attachments)";
  if (source.includes(cachedMediaLine)) {
    source = replaceOnce(
      source,
      "quote-media-prefetch-cache",
      cachedMediaLine,
      tab.repeat(3) + "media: await resolveQuoteImageMedia(refEntry.attachments, account, deps, log, refEntry.content)",
    );
  }
  const cacheMissMediaLine = tab.repeat(3) + "media: imageMediaFromAttachments(refElement.attachments, quotedProcessed)";
  if (source.includes(cacheMissMediaLine)) {
    source = replaceOnce(
      source,
      "quote-media-prefetch-cache-miss",
      cacheMissMediaLine,
      tab.repeat(3) + "media: await resolveQuoteImageMedia(refElement.attachments, account, deps, log, refData.content, quotedProcessed)",
    );
  }
  const resolveQuoteAnchor = QUOTE_IMAGE_CONTEXT_MARKER + "\nasync function resolveQuote(event, deps) {";
  source = replaceOnce(
    source,
    "quote-media-prefetch-marker",
    resolveQuoteAnchor,
    QUOTE_MEDIA_PREFETCH_MARKER + "\n" + resolveQuoteAnchor,
  );
  source = source.replaceAll(
    tab.repeat(3) + "body: formatRefEntryForAgent(refEntry),",
    tab.repeat(3) + "body: sanitizeQqMediaUrls(formatRefEntryForAgent(refEntry)),",
  );
  source = source.replaceAll(
    tab.repeat(3) + "body: refBody || void 0,",
    tab.repeat(3) + "body: sanitizeQqMediaUrls(refBody) || void 0,",
  );
  return source;
}
function addQuoteImageContext(source) {
  if (source.includes(QUOTE_IMAGE_CONTEXT_MARKER)) return upgradeQuoteMediaPrefetch(source);
  source = replaceOnce(
    source,
    "quote-resolve-marker",
    "async function resolveQuote(event, deps) {",
    `${QUOTE_IMAGE_CONTEXT_MARKER}\nasync function resolveQuote(event, deps) {`,
  );
  source = replaceOnce(
    source,
    "ref-cache-image-media",
    `\t\treturn {
\t\t\tid: event.refMsgIdx,
\t\t\tbody: formatRefEntryForAgent(refEntry),
\t\t\tsender: refEntry.senderName ?? refEntry.senderId,
\t\t\tisQuote: true
\t\t};`,
    `\t\treturn {
\t\t\tid: event.refMsgIdx,
\t\t\tbody: formatRefEntryForAgent(refEntry),
\t\t\tsender: refEntry.senderName ?? refEntry.senderId,
\t\t\tisQuote: true,
\t\t\tmedia: imageMediaFromAttachments(refEntry.attachments)
\t\t};`,
  );
  source = replaceOnce(
    source,
    "quote-processed-state",
    `\t\tconst attachmentProcessor = {`,
    `\t\tlet quotedProcessed;
\t\tconst attachmentProcessor = {`,
  );
  source = replaceOnce(
    source,
    "quote-processed-capture",
    `\t\t\t\t});
\t\t\t\treturn {
\t\t\t\t\tattachmentInfo: result.attachmentInfo,`,
    `\t\t\t\t});
\t\t\t\tquotedProcessed = result;
\t\t\t\treturn {
\t\t\t\t\tattachmentInfo: result.attachmentInfo,`,
  );
  source = replaceOnce(
    source,
    "quote-cache-miss-image-media",
    `\t\treturn {
\t\t\tid: event.refMsgIdx,
\t\t\tbody: refBody || void 0,
\t\t\tisQuote: true
\t\t};`,
    `\t\treturn {
\t\t\tid: event.refMsgIdx,
\t\t\tbody: refBody || void 0,
\t\t\tisQuote: true,
\t\t\tmedia: imageMediaFromAttachments(refElement.attachments, quotedProcessed)
\t\t};`,
  );
  return upgradeQuoteMediaPrefetch(source);
}

function buildTencentMediaRecoverySource() {
  return String.raw`
${TENCENT_QQ_MEDIA_PROXY_MARKER}
const qqbotOverlayMediaFs = require("node:fs");
const qqbotOverlayMediaPath = require("node:path");
const qqbotOverlayMediaCrypto = require("node:crypto");
const qqbotOverlayQqImageMaxBytes = 12 * 1024 * 1024;

function qqbotOverlayIsImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  if (buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return true;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return true;
  if (buffer.subarray(0, 2).toString("ascii") === "BM") return true;
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return true;
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp" && /^(?:avif|avis|heic|heix|mif1)$/i.test(buffer.subarray(8, 12).toString("ascii"))) return true;
  return false;
}

function qqbotOverlayImageExtension(contentType, filename, buffer) {
  const typeExtension = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/avif": ".avif",
    "image/heic": ".heic",
    "image/heif": ".heif"
  };
  if (typeExtension[contentType]) return typeExtension[contentType];
  const fromName = qqbotOverlayMediaPath.extname(String(filename ?? "")).toLowerCase();
  if (/^\.(?:jpe?g|png|gif|webp|bmp|tiff?|avif|heic|heif)$/.test(fromName)) return fromName;
  if (buffer?.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return ".png";
  if (buffer?.[0] === 0xff && buffer?.[1] === 0xd8) return ".jpg";
  if (buffer?.subarray(0, 6).toString("ascii").startsWith("GIF")) return ".gif";
  if (buffer?.subarray(0, 4).toString("ascii") === "RIFF") return ".webp";
  return ".img";
}

async function qqbotOverlayDownloadQqImage(url, filename, log4) {
  if (!qqbotOverlayIsQqDownloadUrl(url)) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  try {
    // The fixed QQ media host is routed through the host proxy by NODE_USE_ENV_PROXY=1.
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "image/*",
        "User-Agent": "OpenClaw-QQBot/2.0"
      }
    });
    if (!response.ok) {
      log4?.debug?.("[qqbot] QQ image fetch returned HTTP " + response.status);
      return null;
    }
    const contentType = String(response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0].trim();
    const declaredBytes = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > qqbotOverlayQqImageMaxBytes) {
      log4?.debug?.("[qqbot] QQ image exceeds the local size limit");
      return null;
    }
    const chunks = [];
    let totalBytes = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        totalBytes += chunk.byteLength ?? chunk.length ?? 0;
        if (totalBytes > qqbotOverlayQqImageMaxBytes) {
          log4?.debug?.("[qqbot] QQ image exceeds the local size limit while reading");
          return null;
        }
        chunks.push(Buffer.from(chunk));
      }
    } else {
      const chunk = Buffer.from(await response.arrayBuffer());
      totalBytes = chunk.length;
      if (totalBytes > qqbotOverlayQqImageMaxBytes) {
        log4?.debug?.("[qqbot] QQ image exceeds the local size limit");
        return null;
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks, totalBytes);
    if (!contentType.startsWith("image/") && !qqbotOverlayIsImageBuffer(buffer)) {
      log4?.debug?.("[qqbot] QQ media response is not an image");
      return null;
    }
    const originalName = String(filename ?? "qq-image");
    const safeBase = (qqbotOverlayMediaPath.parse(originalName).name || "qq-image")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .slice(0, 80) || "qq-image";
    const extension = qqbotOverlayImageExtension(contentType, originalName, buffer);
    const targetDir = getQQBotMediaDir("downloads");
    qqbotOverlayMediaFs.mkdirSync(targetDir, { recursive: true });
    const targetPath = qqbotOverlayMediaPath.join(
      targetDir,
      safeBase + "_" + Date.now() + "_" + qqbotOverlayMediaCrypto.randomBytes(3).toString("hex") + extension
    );
    qqbotOverlayMediaFs.writeFileSync(targetPath, buffer);
    log4?.debug?.("[qqbot] QQ image saved locally (" + buffer.length + " bytes)");
    return targetPath;
  } catch (err) {
    // Do not include the signed QQ URL or query string in logs.
    log4?.debug?.("[qqbot] QQ image fetch failed (" + (err instanceof Error ? err.name : "unknown error") + ")");
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

${TENCENT_FORWARD_RECORD_MARKER}
const qqbotForwardRecordNestedKeys = [
  "nodes",
  "messages",
  "records",
  "forward",
  "multi_msg",
  "multimsg",
  "chat_record",
  "chatRecord",
  "raw_message",
  "msg_elements",
  "elements",
  "message",
  "card",
  "json",
  "extra",
  "card_data",
  "json_data",
  "data",
  "raw",
  "payload",
  "content"
];
const qqbotForwardRecordMaxDepth = 10;
const qqbotForwardRecordMaxMessages = 80;
const qqbotForwardRecordMaxChars = 12000;

function qqbotForwardRecordDecodeEntities(value) {
  return String(value ?? "")
    .replace(/&#(?:44|x2c);/gi, ",")
    .replace(/&#(?:91|x5b);/gi, "[")
    .replace(/&#(?:93|x5d);/gi, "]")
    .replace(/&#(?:61|x3d);/gi, "=")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&");
}

function qqbotForwardRecordParseJson(value) {
  if (typeof value !== "string") return null;
  let text = qqbotForwardRecordDecodeEntities(value.trim());
  for (let attempt = 0; attempt < 3; attempt++) {
    const wrapped = text.match(/^\[(?:CQ:)?json(?:,data=|,data:)([\s\S]*)\]$/i);
    if (wrapped) text = qqbotForwardRecordDecodeEntities(wrapped[1].trim());
    if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
    if (!/(com\.tencent\.multimsg|multimsg|multi_msg|chat[_-]?record|forward|nodes|messages|records)/i.test(text)) return null;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string" && parsed.trim() && parsed.trim() !== text) {
        text = qqbotForwardRecordDecodeEntities(parsed.trim());
        continue;
      }
      return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function qqbotForwardRecordIsCard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const app = String(value.app ?? value.app_name ?? value.type ?? "").toLowerCase();
  const config = value.config;
  const detail = value.meta?.detail ?? value.detail;
  const title = String(value.prompt ?? value.summary ?? value.desc ?? value.title ?? "");
  return app === "com.tencent.multimsg" ||
    config?.forward === 1 || config?.forward === true ||
    Array.isArray(detail?.news) || Array.isArray(value.news) ||
    /(?:合并转发|聊天记录)/.test(title) && (value.resid || value.extra || detail);
}

function qqbotForwardRecordCleanText(value) {
  return String(value ?? "")
    .replace(/https:\/\/multimedia\.nt\.qq\.com\.cn\/download\?\S+/gi, "[QQ image attachment]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/\r/g, "")
    .trim();
}

function qqbotForwardRecordInlineText(value, depth = 0) {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") return qqbotForwardRecordCleanText(value);
  if (typeof value !== "object") return "";
  if (Array.isArray(value)) {
    return value.map((item) => qqbotForwardRecordInlineText(item, depth + 1)).filter(Boolean).join(" ");
  }
  const parts = [];
  for (const key of ["text", "content", "body", "raw_content", "description", "title"]) {
    const part = qqbotForwardRecordInlineText(value[key], depth + 1);
    if (part && !parts.includes(part)) parts.push(part);
  }
  return parts.join(" ");
}

function qqbotForwardRecordSender(value) {
  if (!value || typeof value !== "object") return "";
  const sender = value.sender ?? value.author ?? value.user;
  return qqbotForwardRecordCleanText(
    value.senderName ?? value.sender_name ?? value.nickname ?? value.username ?? value.name ??
    sender?.name ?? sender?.username ?? sender?.nickname ?? ""
  );
}

function qqbotForwardRecordAddLine(state, value) {
  if (!state || state.lines.length >= qqbotForwardRecordMaxMessages) {
    if (state) state.truncated = true;
    return;
  }
  const line = qqbotForwardRecordCleanText(value);
  if (!line || /^(?:群聊的聊天记录|聊天记录|合并转发|查看聊天记录)$/i.test(line)) return;
  if (state.seenLines.has(line)) return;
  const remaining = qqbotForwardRecordMaxChars - state.charCount;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  const bounded = line.length > remaining ? line.slice(0, remaining) : line;
  state.lines.push(bounded);
  state.seenLines.add(line);
  state.charCount += bounded.length;
  if (bounded.length < line.length) state.truncated = true;
}

function qqbotForwardRecordAddImage(state, candidate) {
  if (!candidate || (!candidate.url && !candidate.localPath)) return;
  const key = candidate.localPath || candidate.url;
  if (!key || state.imageKeys.has(key)) return;
  state.imageKeys.add(key);
  state.imageCandidates.push(candidate);
}

function qqbotForwardRecordCollectCqImages(value, state) {
  if (typeof value !== "string") return;
  const tokens = value.match(/\[(?:CQ:)?image(?:,[^\]]*)?\]/gi) ?? [];
  for (const token of tokens) {
    const params = token.slice(token.indexOf(",") + 1, -1);
    const getParam = (name) => {
      const match = params.match(new RegExp("(?:^|,)" + name + "=([^,\\]]+)", "i"));
      return match ? qqbotForwardRecordDecodeEntities(match[1]) : "";
    };
    const url = [getParam("url"), getParam("file_url"), getParam("file")]
      .find((candidate) => /^https?:\/\//i.test(candidate)) ?? "";
    if (!url) continue;
    qqbotForwardRecordAddImage(state, qqbotOverlayImageCandidate({
      type: "image",
      url,
      filename: getParam("filename") || getParam("name") || getParam("file")
    }));
  }
}

function qqbotForwardRecordCollectImages(value, state, depth = 0) {
  if (depth > qqbotForwardRecordMaxDepth || value == null) return;
  if (typeof value === "string") {
    qqbotForwardRecordCollectCqImages(value, state);
    const parsed = qqbotForwardRecordParseJson(value);
    if (parsed) qqbotForwardRecordCollectImages(parsed, state, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) qqbotForwardRecordCollectImages(item, state, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const candidate = qqbotOverlayImageCandidate(value);
  if (candidate) qqbotForwardRecordAddImage(state, candidate);
  for (const key of [
    "attachments",
    "attachment",
    "image",
    "media",
    "download_url",
    "downloadUrl",
    "file_url",
    "fileUrl",
    "raw_message",
    "src",
    "source",
    "href",
    "file",
    "resource",
    ...qqbotForwardRecordNestedKeys,
    "meta",
    "detail",
    "news"
  ]) {
    const child = value[key];
    if (child && child !== value) qqbotForwardRecordCollectImages(child, state, depth + 1);
  }
}

function qqbotForwardRecordNodeLine(value, state) {
  if (typeof value === "string") return qqbotForwardRecordCleanText(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const parts = [];
  for (const key of ["content", "text", "body", "raw_content", "description", "title"]) {
    const part = qqbotForwardRecordInlineText(value[key]);
    if (part && !parts.includes(part)) parts.push(part);
  }
  const sender = qqbotForwardRecordSender(value);
  if (!parts.length && state.imageCandidates.length > state.imageCountBeforeNode) parts.push("[image attachment]");
  if (!parts.length) return "";
  return sender ? sender + ": " + parts.join(" ") : parts.join(" ");
}

function qqbotForwardRecordWalkNode(value, state, depth = 0) {
  if (depth > qqbotForwardRecordMaxDepth || state.lines.length >= qqbotForwardRecordMaxMessages) {
    state.truncated = true;
    return;
  }
  const parsed = qqbotForwardRecordParseJson(value);
  if (parsed) {
    qqbotForwardRecordWalkNode(parsed, state, depth + 1);
    return;
  }
  if (typeof value === "string") {
    qqbotForwardRecordAddLine(state, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) qqbotForwardRecordWalkNode(item, state, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (qqbotForwardRecordIsCard(value)) {
    qqbotForwardRecordWalkCard(value, state, depth + 1);
    return;
  }
  if (state.seenNodes.has(value)) return;
  state.seenNodes.add(value);
  state.imageCountBeforeNode = state.imageCandidates.length;
  qqbotForwardRecordCollectImages(value, state, depth);
  qqbotForwardRecordAddLine(state, qqbotForwardRecordNodeLine(value, state));
  for (const key of [...qqbotForwardRecordNestedKeys, "attachments"]) {
    const child = value[key];
    if (child == null || child === value) continue;
    if (key === "content" && typeof child === "string") continue;
    qqbotForwardRecordWalkNode(child, state, depth + 1);
  }
}

function qqbotForwardRecordWalkCard(value, state, depth = 0) {
  if (depth > qqbotForwardRecordMaxDepth || !value || typeof value !== "object") return;
  if (state.seenCards.has(value)) return;
  state.seenCards.add(value);
  state.sawCard = true;
  const detail = value.meta?.detail ?? value.detail ?? {};
  const resid = value.resid ?? value.resource_id ?? detail.resid ?? detail.resource_id;
  if (resid) state.referenceOnly = true;

  const news = Array.isArray(detail.news) ? detail.news : Array.isArray(value.news) ? value.news : [];
  if (news.length) state.sawPreview = true;
  for (const item of news) qqbotForwardRecordWalkNode(item, state, depth + 1);

  let sawExpandedEntries = false;
  for (const key of ["nodes", "messages", "records", "forward", "multi_msg", "multimsg", "chat_record", "chatRecord", "msg_elements", "elements", "attachments", "data", "extra", "raw_message"]) {
    const child = value[key] ?? detail[key];
    if (child == null) continue;
    sawExpandedEntries = true;
    state.sawExpanded = true;
    qqbotForwardRecordWalkNode(child, state, depth + 1);
  }
  if (!news.length && !sawExpandedEntries) {
    for (const key of ["data", "content", "message", "body", "raw", "payload"]) {
      const child = value[key];
      if (child == null || child === value) continue;
      const parsed = qqbotForwardRecordParseJson(child);
      if (parsed) {
        if (qqbotForwardRecordIsCard(parsed)) qqbotForwardRecordWalkCard(parsed, state, depth + 1);
        else qqbotForwardRecordWalkNode(parsed, state, depth + 1);
      } else if (typeof child === "object") {
        qqbotForwardRecordWalkNode(child, state, depth + 1);
      }
    }
  }
  qqbotForwardRecordCollectImages(value, state, depth);
}

function qqbotForwardRecordWalkRoot(value, state, depth = 0) {
  if (depth > qqbotForwardRecordMaxDepth || value == null) return;
  const parsed = qqbotForwardRecordParseJson(value);
  if (parsed) {
    qqbotForwardRecordWalkRoot(parsed, state, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) qqbotForwardRecordWalkRoot(item, state, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (qqbotForwardRecordIsCard(value)) {
    qqbotForwardRecordWalkCard(value, state, depth + 1);
    return;
  }
  if (state.seenRoots.has(value)) return;
  state.seenRoots.add(value);
  qqbotForwardRecordCollectImages(value, state, depth);
  for (const key of ["msg_elements", "elements", "data", "extra", "raw_message", "raw", "payload", "card", "message", "content", "attachments"]) {
    const child = value[key];
    if (child == null || child === value) continue;
    qqbotForwardRecordWalkRoot(child, state, depth + 1);
  }
}

function qqbotOverlayExtractForwardRecord(ctx) {
  const state = {
    lines: [],
    seenLines: new Set(),
    seenRoots: new Set(),
    seenCards: new Set(),
    seenNodes: new Set(),
    imageKeys: new Set(),
    imageCandidates: [],
    imageCountBeforeNode: 0,
    charCount: 0,
    sawCard: false,
    sawPreview: false,
    sawExpanded: false,
    referenceOnly: false,
    truncated: false
  };
  const message = ctx?.message;
  for (const source of [message?.raw, message?.msgElements, message?.attachments, message?.content]) {
    qqbotForwardRecordWalkRoot(source, state);
  }
  if (!state.sawCard) return null;
  let header = state.sawExpanded
    ? "[QQ forwarded chat record (expanded entries)]"
    : state.sawPreview
      ? "[QQ forwarded chat record (preview data)]"
      : "[QQ forwarded chat record]";
  if (state.referenceOnly && !state.sawExpanded) {
    header += "\nOnly the forward-card preview/reference was delivered; the original forwarded message bodies and image pixels were not delivered in this event.";
  } else if (!state.lines.length && state.referenceOnly) {
    header += "\nThe event only contained a record reference; the forwarded message bodies were not delivered.";
  }
  const numbered = state.lines.map((line, index) => "[message " + (index + 1) + "] " + line);
  if (state.truncated) numbered.push("[further forwarded entries omitted by the local safety limit]");
  return {
    text: [header, ...numbered].join("\n"),
    imageCandidates: state.imageCandidates
  };
}

async function qqbotOverlayPrepareForwardRecord(ctx, log4) {
  const record = qqbotOverlayExtractForwardRecord(ctx);
  if (!record) return null;
  let image = null;
  if (qqbotOverlayReadCapabilities().image) {
    image = await qqbotOverlayResolveImage(record.imageCandidates, log4);
  }
  log4?.debug?.("[qqbot] forward record parsed (image candidates=" + record.imageCandidates.length + ", image resolved=" + (image ? "yes" : "no") + ")");
  return { ...record, image };
}

`;
}

function buildTencentCanonicalInboundMediaSource() {
  return String.raw`
${TENCENT_CANONICAL_MEDIA_MARKER}
function qqbotOverlayBuildInboundMediaFacts(processed, voiceUrls = []) {
  if (!processed || typeof processed !== "object") return void 0;
  const media = [];
  const imageUrls = Array.isArray(processed.imageUrls) ? processed.imageUrls : [];
  const imageTypes = Array.isArray(processed.imageMediaTypes) ? processed.imageMediaTypes : [];
  for (let i = 0; i < imageUrls.length; i++) {
    const imagePath = imageUrls[i];
    if (typeof imagePath !== "string" || !imagePath || qqbotOverlayIsRemote(imagePath)) continue;
    media.push({
      path: imagePath,
      contentType: imageTypes[i] || "image/png",
      kind: "image"
    });
  }

  const localPaths = Array.isArray(processed.localMediaPaths) ? processed.localMediaPaths : [];
  const localTypes = Array.isArray(processed.localMediaTypes) ? processed.localMediaTypes : [];
  for (let i = 0; i < localPaths.length; i++) {
    const audioPath = localPaths[i];
    const audioType = String(localTypes[i] ?? "").toLowerCase();
    if (!audioPath || !audioType.startsWith("audio/")) continue;
    if (media.some((entry) => entry.path === audioPath)) continue;
    media.push({
      path: audioPath,
      contentType: localTypes[i] || "audio/wav",
      kind: "audio"
    });
  }
  for (const audioUrl of Array.isArray(voiceUrls) ? voiceUrls : []) {
    if (!audioUrl || media.some((entry) => entry.url === audioUrl)) continue;
    media.push({ url: audioUrl, contentType: "audio/wav", kind: "audio" });
  }
  return media.length > 0 ? media : void 0;
}
`;
}

function buildTencentAttachmentNormalizationSource() {
  return String.raw`
${TENCENT_ATTACHMENT_NORMALIZATION_MARKER}
function qqbotOverlayNormalizeAttachment(rawAttachment) {
  const raw = rawAttachment && typeof rawAttachment === "object" ? rawAttachment : {};
  const imageValue = raw.image ?? raw.image_url ?? raw.imageUrl;
  const imageObject = imageValue && typeof imageValue === "object" ? imageValue : null;
  const type = String(raw.type ?? raw.kind ?? raw.msg_type ?? "").toLowerCase();
  const contentType = String(raw.content_type ?? raw.contentType ?? "").toLowerCase() ||
    (type === "image" ? "image/png" : "");
  const normalizedContentType = contentType || void 0;
  return {
    ...raw,
    content_type: raw.content_type ?? normalizedContentType,
    contentType: raw.contentType ?? normalizedContentType,
    filename: raw.filename ?? raw.file_name ?? imageObject?.filename,
    url: raw.url ?? imageObject?.url ?? (typeof imageValue === "string" ? imageValue : void 0)
  };
}
`;
}

function buildTencentImageGenerationProgressSource() {
  return String.raw`
${TENCENT_IMAGE_GENERATION_PROGRESS_MARKER}
function qqbotOverlayImageRequestText(value) {
  return String(value ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^(?:<@!?[^>]+>\s*)+/, "")
    .trim();
}

function qqbotOverlayLooksLikeMainlandPoliticalRequest(value) {
  const text = qqbotOverlayImageRequestText(value);
  if (!text) return false;
  const mainland = /中国|中华人民共和国|大陆|墙内|简中|中共|共产党|党政|党委/.test(text);
  const politics = /政治|政府|领导|主席|总书记|选举|政策|抗议|示威|运动|审查|封禁|维稳|人权|民族|领土|宣传|制度|敏感|共产党|中共|党政|党委|党史|历史事件/.test(text);
  if (mainland && politics) return true;
  if (/(?:白纸革命|白纸抗议|坦克人|(?<!\d)8964(?!\d)|六四|6[·．./／\s]4)/.test(text)) return true;
  if (/小熊维尼/.test(text) && (mainland || politics)) return true;
  if (/404/.test(text) && /审查|封禁|敏感|墙|政治/.test(text)) return true;
  if (/(?:河蟹|草泥马)/.test(text) && /政治|审查|封禁|墙|维稳|敏感|中国大陆|中共/.test(text)) return true;
  return false;
}

function qqbotOverlayIsImageGenerationRequest(value) {
  const text = qqbotOverlayImageRequestText(value);
  if (!text) return false;
  if (qqbotOverlayLooksLikeMainlandPoliticalRequest(text)) return false;
  const candidates = [text];
  const shortened = text.replace(/^(?:请|帮我|请帮我|能不能|可以不可以|可不可以)\s*(?:帮我\s*)?/, "").trim();
  if (shortened && shortened !== text) candidates.push(shortened);
  const prefixes = [
    "生成一幅图",
    "生成一张图",
    "生成图片",
    "生成图像",
    "生成一幅",
    "生成一张",
    "生图",
    "画一幅",
    "画一张",
    "画个",
    "绘制一幅",
    "绘制一张",
    "绘制",
  ];
  return candidates.some((candidate) => {
    const prefix = prefixes.find((item) => candidate.startsWith(item));
    if (!prefix) return false;
    const description = candidate.slice(prefix.length).replace(/^[\s:：]+/, "").trim();
    return description.length > 0 && !/^(?:吗|么|呢|失败|了吗|了没有|怎么|如何|为什么|为何|多久|速度|还在)/.test(description);
  });
}

const qqbotOverlayImageGenerationInstruction = [
  "[QQ image-generation routing instruction]",
  "This is an explicit image-generation request. You must call the image_generate tool using the user's description. The QQ adapter has already sent the short progress message; do not send another progress message. After image_generate succeeds, send the generated image as a separate reply. If image_generate fails, send a brief failure notice and do not claim success.",
  "[/QQ image-generation routing instruction]"
].join("\n");

function qqbotOverlayAppendImageGenerationInstruction(value) {
  const base = typeof value === "string" ? value.trim() : "";
  if (base.includes("[QQ image-generation routing instruction]")) return base;
  return base ? base + "\n\n" + qqbotOverlayImageGenerationInstruction : qqbotOverlayImageGenerationInstruction;
}

function qqbotOverlayForceImageGenerationContext(payload) {
  if (!payload || typeof payload !== "object") return payload;
  try {
    for (const key of ["BodyForAgent", "bodyForAgent"]) {
      if (typeof payload[key] === "string") payload[key] = qqbotOverlayAppendImageGenerationInstruction(payload[key]);
    }
    if (payload.message && typeof payload.message === "object" && typeof payload.message.bodyForAgent === "string") {
      payload.message.bodyForAgent = qqbotOverlayAppendImageGenerationInstruction(payload.message.bodyForAgent);
    }
    if (typeof payload.GroupSystemPrompt === "string" || payload.GroupSystemPrompt === undefined) {
      payload.GroupSystemPrompt = qqbotOverlayAppendImageGenerationInstruction(payload.GroupSystemPrompt);
    }
    if (typeof payload.groupSystemPrompt === "string" || payload.groupSystemPrompt === undefined) {
      payload.groupSystemPrompt = qqbotOverlayAppendImageGenerationInstruction(payload.groupSystemPrompt);
    }
    for (const key of ["supplemental", "SupplementalContext"]) {
      const supplemental = payload[key];
      if (!supplemental || typeof supplemental !== "object") continue;
      supplemental.groupSystemPrompt = qqbotOverlayAppendImageGenerationInstruction(supplemental.groupSystemPrompt);
      supplemental.GroupSystemPrompt = qqbotOverlayAppendImageGenerationInstruction(supplemental.GroupSystemPrompt);
    }
  } catch {
    // Context shape is runtime-version dependent; the body-level routing hint remains best effort.
  }
  return payload;
}

function qqbotOverlayPrepareImageGenerationAssembled(assembled) {
  if (!assembled || typeof assembled !== "object") return assembled;
  return {
    ...assembled,
    agentBody: qqbotOverlayAppendImageGenerationInstruction(assembled.agentBody),
    systemPrompt: qqbotOverlayAppendImageGenerationInstruction(assembled.systemPrompt)
  };
}

async function qqbotOverlaySendImageGenerationProgress(envelope, account, log4) {
  try {
    const result = await sendText({
      to: envelope.targetId,
      text: "收到，正在生成～",
      accountId: account.accountId,
      replyToId: envelope.messageId,
      account
    });
    if (result?.error) {
      log4?.warn?.("[qqbot] image-generation progress message was not sent");
      return false;
    }
    return true;
  } catch {
    log4?.warn?.("[qqbot] image-generation progress message failed");
    return false;
  }
}
`;
}

function buildTencentMediaOverlaySource() {
  return String.raw`
${TENCENT_MEDIA_OVERLAY_MARKER}
${buildTencentMediaRecoverySource()}
const qqbotOverlayRecentImages = new Map();

function qqbotOverlayReadCapabilities() {
  try {
    const value = JSON.parse(require("node:fs").readFileSync(__QQBOT_MEDIA_CAPABILITIES_PATH__, "utf8"));
    return { image: value.image === true, video: value.video === true };
  } catch {
    return { image: false, video: false };
  }
}

function qqbotOverlayEmptyProcessed() {
  return {
    voiceText: "",
    imageUrls: [],
    imageMediaTypes: [],
    otherInfo: "",
    transcripts: [],
    localMediaPaths: [],
    localMediaTypes: [],
    remoteMediaUrls: []
  };
}

function qqbotOverlayIsRemote(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function qqbotOverlayIsQqDownloadUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase() === "multimedia.nt.qq.com.cn" &&
      parsed.pathname === "/download";
  } catch {
    return false;
  }
}

function qqbotOverlayImageCandidate(attachment) {
  if (!attachment || typeof attachment !== "object") return null;
  const contentType = String(
    attachment.contentType ?? attachment.content_type ?? attachment.mimeType ?? attachment.mime_type ??
    attachment.fileType ?? attachment.file_type ?? ""
  ).toLowerCase();
  const imageValue = attachment.image ?? attachment.image_url ?? attachment.imageUrl;
  const imageObject = imageValue && typeof imageValue === "object" ? imageValue : null;
  const url = [
    attachment.url,
    attachment.download_url,
    attachment.downloadUrl,
    attachment.file_url,
    attachment.fileUrl,
    attachment.href,
    typeof imageValue === "string" ? imageValue : "",
    imageObject?.url,
    imageObject?.download_url,
    imageObject?.downloadUrl
  ].find((value) => typeof value === "string" && /^https?:\/\//i.test(value)) ?? "";
  const localPath = [
    attachment.localPath,
    attachment.local_path,
    typeof imageValue === "string" && !/^https?:\/\//i.test(imageValue) ? imageValue : "",
    imageObject?.localPath,
    imageObject?.local_path,
    imageObject?.path,
    attachment.path,
    attachment.filePath,
    attachment.file_path
  ].find((value) => typeof value === "string" && value && !/^https?:\/\//i.test(value)) ?? "";
  const type = String(attachment.type ?? attachment.kind ?? attachment.msg_type ?? attachment.message_type ?? "").toLowerCase();
  const hasImageField = imageValue != null || imageObject != null;
  const isImage = /^(?:image|img|photo|picture|7)$/.test(type) || contentType.startsWith("image/") ||
    qqbotOverlayIsQqDownloadUrl(url) || (hasImageField && Boolean(url || localPath));
  if (!isImage || (!url && !localPath)) return null;
  return {
    url,
    localPath,
    filename: attachment.filename ?? attachment.file_name ?? attachment.name ?? imageObject?.filename ?? imageObject?.file_name,
    contentType: contentType || "image/png"
  };
}

function qqbotOverlayCollectImageCandidates(value, output, depth = 0) {
  if (!Array.isArray(value) || depth > 5) return;
  for (const attachment of value) {
    const candidate = qqbotOverlayImageCandidate(attachment);
    if (candidate) output.push(candidate);
    if (attachment && typeof attachment === "object") {
      qqbotOverlayCollectImageCandidates(attachment.attachments, output, depth + 1);
      qqbotOverlayCollectImageCandidates(attachment.msg_elements, output, depth + 1);
      qqbotOverlayCollectImageCandidates(attachment.elements, output, depth + 1);
    }
  }
}

function qqbotOverlayRememberImage(key, message) {
  if (!key || !message) return;
  const candidates = [];
  qqbotOverlayCollectImageCandidates(message.attachments, candidates);
  const latest = candidates[candidates.length - 1];
  if (!latest) return;
  const keys = new Set([String(key), String(message.groupOpenid ?? "")]);
  for (const cacheKey of keys) {
    if (!cacheKey) continue;
    qqbotOverlayRecentImages.set(cacheKey, latest);
  }
  while (qqbotOverlayRecentImages.size > 256) {
    qqbotOverlayRecentImages.delete(qqbotOverlayRecentImages.keys().next().value);
  }
}

function qqbotOverlayShouldUseRecentImage(text = "") {
  return /上图|上面的?图|刚才(?:那张)?图|前面(?:那张)?图|上一张(?:图|图片|截图)?|前一张(?:图|图片|截图)?|这张图|这图|图片里|图里|截图里|图上|画面/.test(String(text));
}

function qqbotOverlayIsImagePath(value) {
  return /\.(?:png|jpe?g|gif|webp|bmp|tiff?|avif)(?:$|[?#\]\)}\s])/i.test(String(value ?? ""));
}

function qqbotOverlayIsVideoPath(value) {
  const text = String(value ?? "");
  return text.toLowerCase().startsWith("video/") || /\.(?:mp4|m4v|mov|webm|mkv|avi|flv|wmv|mpeg?|3gp)(?:$|[?#\]\)}\s])/i.test(text);
}

async function qqbotOverlayResolveImage(candidates, log4) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (candidate.localPath && !qqbotOverlayIsRemote(candidate.localPath)) {
      return { path: candidate.localPath, contentType: candidate.contentType || "image/png" };
    }
    if (!candidate.url || !qqbotOverlayIsQqDownloadUrl(candidate.url)) continue;
    try {
      const localPath = await qqbotOverlayDownloadQqImage(candidate.url, candidate.filename, log4);
      if (localPath) return { path: localPath, contentType: candidate.contentType || "image/png" };
    } catch (err) {
      log4?.debug?.("[qqbot] image overlay fetch failed: " + (err instanceof Error ? err.message : String(err)).slice(0, 160));
    }
  }
  return null;
}

function qqbotOverlayCurrentLocalImage(processed) {
  const imageUrls = Array.isArray(processed?.imageUrls) ? processed.imageUrls : [];
  const imageMediaTypes = Array.isArray(processed?.imageMediaTypes) ? processed.imageMediaTypes : [];
  for (let i = 0; i < imageUrls.length; i++) {
    const value = imageUrls[i];
    if (value && !qqbotOverlayIsRemote(value)) {
      return { path: value, contentType: imageMediaTypes[i] || "image/png" };
    }
  }
  const paths = Array.isArray(processed?.localMediaPaths) ? processed.localMediaPaths : [];
  const types = Array.isArray(processed?.localMediaTypes) ? processed.localMediaTypes : [];
  for (let i = 0; i < paths.length; i++) {
    if (String(types[i] ?? "").toLowerCase().startsWith("image/")) {
      return { path: paths[i], contentType: types[i] || "image/png" };
    }
  }
  return null;
}

function qqbotOverlaySanitizeQuote(ctx) {
  const quote = ctx?.state?.quote;
  if (!quote || typeof quote !== "object") return;
  for (const field of ["text", "content"]) {
    if (typeof quote[field] === "string") {
      quote[field] = quote[field].replace(/https:\/\/multimedia\.nt\.qq\.com\.cn\/download\?[^\s<>"'\])}]+/gi, "[QQ image attachment]");
    }
  }
}

function qqbotOverlayCleanProcessed(processed, capabilities) {
  const base = { ...qqbotOverlayEmptyProcessed(), ...(processed ?? {}) };
  const imageUrls = Array.isArray(base.imageUrls) ? base.imageUrls : [];
  const imageUrlSet = new Set(imageUrls.filter(qqbotOverlayIsRemote));
  const paths = Array.isArray(base.localMediaPaths) ? base.localMediaPaths : [];
  const types = Array.isArray(base.localMediaTypes) ? base.localMediaTypes : [];
  const localMediaPaths = [];
  const localMediaTypes = [];
  for (let i = 0; i < paths.length; i++) {
    const mediaPath = paths[i];
    const mediaType = String(types[i] ?? "").toLowerCase();
    if (mediaType.startsWith("image/") || imageUrls.includes(mediaPath) || qqbotOverlayIsImagePath(mediaPath)) continue;
    if (!capabilities.video && (mediaType.startsWith("video/") || qqbotOverlayIsVideoPath(mediaPath))) continue;
    localMediaPaths.push(mediaPath);
    localMediaTypes.push(types[i] ?? "application/octet-stream");
  }
  const otherInfo = !capabilities.video && typeof base.otherInfo === "string"
    ? base.otherInfo.split("\n").filter((line) => !qqbotOverlayIsVideoPath(line)).join("\n")
    : base.otherInfo ?? "";
  const remoteMediaUrls = (Array.isArray(base.remoteMediaUrls) ? base.remoteMediaUrls : [])
    .filter((value) => !imageUrlSet.has(value));
  return {
    ...base,
    imageUrls: [],
    imageMediaTypes: [],
    otherInfo,
    localMediaPaths,
    localMediaTypes,
    remoteMediaUrls
  };
}

async function qqbotOverlayPrepareMedia(ctx, processed, log4) {
  const capabilities = qqbotOverlayReadCapabilities();
  const cleaned = qqbotOverlayCleanProcessed(processed, capabilities);
  qqbotOverlaySanitizeQuote(ctx);
  if (!capabilities.image) return cleaned;

  const quoteCandidates = [];
  const quote = ctx?.state?.quote;
  qqbotOverlayCollectImageCandidates(quote?.attachments, quoteCandidates);
  qqbotOverlayCollectImageCandidates(quote?.entry?.attachments, quoteCandidates);

  const currentCandidates = [];
  qqbotOverlayCollectImageCandidates(ctx?.message?.attachments, currentCandidates);

  let selected = await qqbotOverlayResolveImage(quoteCandidates, log4);
  if (!selected) selected = qqbotOverlayCurrentLocalImage(processed);
  if (!selected) selected = await qqbotOverlayResolveImage(currentCandidates, log4);

  const groupId = ctx?.message?.groupOpenid;
  if (!selected && ctx?.message?.kind === "group" && groupId && qqbotOverlayShouldUseRecentImage(ctx?.message?.content)) {
    selected = await qqbotOverlayResolveImage([qqbotOverlayRecentImages.get(String(groupId))], log4);
  }
  if (!selected?.path) return cleaned;

  const localMediaPaths = [...cleaned.localMediaPaths];
  const localMediaTypes = [...cleaned.localMediaTypes];
  if (!localMediaPaths.includes(selected.path)) {
    localMediaPaths.push(selected.path);
    localMediaTypes.push(selected.contentType || "image/png");
  }
  return {
    ...cleaned,
    imageUrls: [selected.path],
    imageMediaTypes: [selected.contentType || "image/png"],
    localMediaPaths,
    localMediaTypes
  };
}
` .replace("__QQBOT_MEDIA_CAPABILITIES_PATH__", JSON.stringify(MEDIA_CAPABILITIES_PATH));
}

function upgradeTencentMediaOverlay(source) {
  if (source.includes(TENCENT_MEDIA_OVERLAY_MARKER)) return source;
  const legacyMarker = LEGACY_TENCENT_MEDIA_OVERLAY_MARKERS.find((marker) => source.includes(marker));
  const legacyStart = legacyMarker ? source.indexOf(legacyMarker) : -1;
  if (legacyStart < 0) return source;
  const overlayEnd = source.indexOf("function historyBuffer(options = {})", legacyStart);
  if (overlayEnd < 0) {
    throw new Error("QQ history-media patch could not locate the end of the legacy Tencent media overlay");
  }
  return source.slice(0, legacyStart) + buildTencentMediaOverlaySource() + "\n" + source.slice(overlayEnd);
}

function patchTencentBundle(file) {
  let source = fs.readFileSync(file, "utf8");
  let changed = false;

  const upgradedOverlay = upgradeTencentMediaOverlay(source);
  if (upgradedOverlay !== source) {
    source = upgradedOverlay;
    changed = true;
  }
  if (!source.includes(TENCENT_MEDIA_OVERLAY_MARKER)) {
    source = replaceOnce(
      source,
      "tencent-media-overlay-injection",
      "function historyBuffer(options = {}) {",
      buildTencentMediaOverlaySource() + "\nfunction historyBuffer(options = {}) {",
    );
    changed = true;
  }
  if (!source.includes(TENCENT_QQ_MEDIA_PROXY_MARKER)) {
    source = replaceOnce(
      source,
      "tencent-media-recovery-injection",
      TENCENT_MEDIA_OVERLAY_MARKER + "\n",
      TENCENT_MEDIA_OVERLAY_MARKER + "\n" + buildTencentMediaRecoverySource(),
    );
    changed = true;
  }
  if (!source.includes(TENCENT_FORWARD_RECORD_MARKER)) {
    const recoverySource = buildTencentMediaRecoverySource();
    const forwardIndex = recoverySource.indexOf(TENCENT_FORWARD_RECORD_MARKER);
    if (forwardIndex < 0) throw new Error("QQ history-media patch forward-record source is missing its marker");
    source = replaceOnce(
      source,
      "tencent-forward-record-injection",
      TENCENT_QQ_MEDIA_PROXY_MARKER + "\n",
      TENCENT_QQ_MEDIA_PROXY_MARKER + "\n" + recoverySource.slice(forwardIndex),
    );
    changed = true;
  }
  if (!source.includes("qqbotOverlayDownloadQqImage(candidate.url, candidate.filename, log4)")) {
    source = replaceOnce(
      source,
      "tencent-overlay-qq-image-downloader",
      "      const localPath = await downloadMediaFile(candidate.url, candidate.filename, log4);",
      "      const localPath = await qqbotOverlayDownloadQqImage(candidate.url, candidate.filename, log4);",
    );
    changed = true;
  }
  if (!source.includes("    qqbotOverlayRememberImage(key, ctx.message);")) {
    source = replaceOnce(
      source,
      "tencent-history-image-cache",
      "    const key = getKey(ctx);",
      "    const key = getKey(ctx);\n    qqbotOverlayRememberImage(key, ctx.message);",
    );
    changed = true;
  }
  if (!source.includes("qqbotOverlayDownloadQqImage(url, att.filename, log4)")) {
    const imageDownloadLine = [
      "    if (isImage && url) {",
      "      const localPath = await downloadMediaFile(url, att.filename, log4);",
    ].join("\n");
    const imageDownloadReplacement = [
      "    if (isImage && url) {",
      "      const localPath = qqbotOverlayIsQqDownloadUrl(url)",
      "        ? await qqbotOverlayDownloadQqImage(url, att.filename, log4)",
      "        : await downloadMediaFile(url, att.filename, log4);",
    ].join("\n");
    source = replaceOnce(
      source,
      "tencent-image-processor-qq-download",
      imageDownloadLine,
      imageDownloadReplacement,
    );
    changed = true;
  }
  if (!source.includes(TENCENT_ATTACHMENT_NORMALIZATION_MARKER)) {
    source = replaceOnce(
      source,
      "tencent-attachment-normalization-helper",
      "async function processAttachments(attachments, cfg, log4) {",
      buildTencentAttachmentNormalizationSource() + "\nasync function processAttachments(attachments, cfg, log4) {",
    );
    changed = true;
  }
  if (!source.includes("const att = qqbotOverlayNormalizeAttachment(rawAttachment);")) {
    source = replaceOnce(
      source,
      "tencent-attachment-normalization-call",
      "  const tasks = attachments.map(async (att) => {",
      "  const tasks = attachments.map(async (rawAttachment) => {\n    const att = qqbotOverlayNormalizeAttachment(rawAttachment);",
    );
    changed = true;
  }
  if (!source.includes("qqbotOverlayPrepareMedia(ctx, result, ctx.log)")) {
    source = replaceOnce(
      source,
      "tencent-attachment-processor",
    `function attachmentProcessor(opts) {
  return async (ctx, next) => {
    const msg = ctx.message;
    const attachments = msg.attachments;
    if (attachments?.length) {
      const runtime2 = opts.getRuntime();
      const adapters = getAdapters(runtime2);
      const cfg = adapters.getConfig?.() ?? {};
      const log4 = ctx.log;
      const result = await processAttachments(attachments, cfg, log4);
      if (result.voiceText || result.imageUrls.length > 0 || result.otherInfo || result.localMediaPaths.length > 0) {
        ctx.state.processedAttachments = result;
      }
    }
    await next();
  };
}`,
    `function attachmentProcessor(opts) {
  return async (ctx, next) => {
    const msg = ctx.message;
    const attachments = msg.attachments;
    let result = null;
    if (attachments?.length) {
      const runtime2 = opts.getRuntime();
      const adapters = getAdapters(runtime2);
      const cfg = adapters.getConfig?.() ?? {};
      const log4 = ctx.log;
      result = await processAttachments(attachments, cfg, log4);
    }
    const enriched = await qqbotOverlayPrepareMedia(ctx, result, ctx.log);
    if (enriched.voiceText || enriched.imageUrls.length > 0 || enriched.otherInfo || enriched.localMediaPaths.length > 0) {
      ctx.state.processedAttachments = enriched;
    }
    await next();
  };
}`,
    );
    changed = true;
  }

  if (!source.includes("qqbotOverlayPrepareForwardRecord(ctx, ctx.log)")) {
    const enrichedLine = "    const enriched = await qqbotOverlayPrepareMedia(ctx, result, ctx.log);\n";
    const forwardBody = [
      "    const forwarded = await qqbotOverlayPrepareForwardRecord(ctx, ctx.log);",
      "    if (forwarded?.text && !String(msg.content ?? \"\").includes(\"[QQ forwarded chat record\")) {",
      "      msg.content = [String(msg.content ?? \"\").trim(), forwarded.text].filter(Boolean).join(\"\\n\");",
      "    }",
      "    let finalResult = enriched;",
      "    if (!enriched.imageUrls?.length && forwarded?.image?.path) {",
      "      const localMediaPaths = [...(enriched.localMediaPaths ?? [])];",
      "      const localMediaTypes = [...(enriched.localMediaTypes ?? [])];",
      "      if (!localMediaPaths.includes(forwarded.image.path)) {",
      "        localMediaPaths.push(forwarded.image.path);",
      "        localMediaTypes.push(forwarded.image.contentType || \"image/png\");",
      "      }",
      "      finalResult = {",
      "        ...enriched,",
      "        imageUrls: [forwarded.image.path],",
      "        imageMediaTypes: [forwarded.image.contentType || \"image/png\"],",
      "        localMediaPaths,",
      "        localMediaTypes",
      "      };",
      "    }"
    ].join("\n") + "\n";
    source = replaceOnce(
      source,
      "tencent-forward-record-processor",
      enrichedLine,
      enrichedLine + forwardBody,
    );
    source = replaceOnce(
      source,
      "tencent-forward-record-result-condition",
      "    if (enriched.voiceText || enriched.imageUrls.length > 0 || enriched.otherInfo || enriched.localMediaPaths.length > 0) {",
      "    if (finalResult.voiceText || finalResult.imageUrls.length > 0 || finalResult.otherInfo || finalResult.localMediaPaths.length > 0) {",
    );
    source = replaceOnce(
      source,
      "tencent-forward-record-result-state",
      "      ctx.state.processedAttachments = enriched;",
      "      ctx.state.processedAttachments = finalResult;",
    );
    changed = true;
  }

  if (!source.includes("qqbotOverlayCollectImageCandidates(message.msgElements, candidates);")) {
    source = replaceOnce(
      source,
      "tencent-history-image-source-expansion",
      "  qqbotOverlayCollectImageCandidates(message.attachments, candidates);",
      [
        "  qqbotOverlayCollectImageCandidates(message.attachments, candidates);",
        "  qqbotOverlayCollectImageCandidates(message.msgElements, candidates);",
        "  qqbotOverlayCollectImageCandidates(message.raw?.attachments, candidates);",
        "  qqbotOverlayCollectImageCandidates(message.raw?.msg_elements, candidates);"
      ].join("\n"),
    );
    changed = true;
  }
  if (!source.includes("qqbotOverlayCollectImageCandidates(ctx?.message?.msgElements, currentCandidates);")) {
    source = replaceOnce(
      source,
      "tencent-current-image-source-expansion",
      "  qqbotOverlayCollectImageCandidates(ctx?.message?.attachments, currentCandidates);",
      [
        "  qqbotOverlayCollectImageCandidates(ctx?.message?.attachments, currentCandidates);",
        "  qqbotOverlayCollectImageCandidates(ctx?.message?.msgElements, currentCandidates);",
        "  qqbotOverlayCollectImageCandidates(ctx?.message?.raw?.attachments, currentCandidates);",
        "  qqbotOverlayCollectImageCandidates(ctx?.message?.raw?.msg_elements, currentCandidates);"
      ].join("\n"),
    );
    changed = true;
  }

  if (!source.includes(TENCENT_CANONICAL_MEDIA_MARKER)) {
    source = replaceOnce(
      source,
      "tencent-canonical-inbound-media-helper",
      "function buildCtxPayload(params) {",
      buildTencentCanonicalInboundMediaSource() + "\nfunction buildCtxPayload(params) {",
    );
    changed = true;
  }
  const hasCurrentImageGenerationProgress = source.includes(TENCENT_IMAGE_GENERATION_PROGRESS_MARKER);
  const legacyImageGenerationProgressMarker = LEGACY_TENCENT_IMAGE_GENERATION_PROGRESS_MARKERS.find((marker) => source.includes(marker));
  const hasLegacyImageGenerationProgress = Boolean(legacyImageGenerationProgressMarker);
  if (hasCurrentImageGenerationProgress) {
    const imageInstructionDeclaration = "const qqbotOverlayImageGenerationInstruction = [";
    const firstInstruction = source.indexOf(imageInstructionDeclaration);
    const duplicateInstruction = source.indexOf(imageInstructionDeclaration, firstInstruction + imageInstructionDeclaration.length);
    if (firstInstruction >= 0 && duplicateInstruction >= 0) {
      const duplicateEnd = source.indexOf("function historyBuffer(options = {})", duplicateInstruction);
      if (duplicateEnd < 0) {
        throw new Error("QQ history-media patch could not remove a duplicate image-generation helper");
      }
      source = source.slice(0, duplicateInstruction) + source.slice(duplicateEnd);
      changed = true;
    }
  }
  if (hasLegacyImageGenerationProgress) {
    const legacyStart = source.indexOf(legacyImageGenerationProgressMarker);
    const legacyEnd = source.indexOf("function historyBuffer(options = {})", legacyStart);
    if (legacyStart < 0 || legacyEnd < 0) {
      throw new Error("QQ history-media patch could not locate the legacy image-generation helper");
    }
    if (hasCurrentImageGenerationProgress) {
      source = source.slice(0, legacyStart) + source.slice(legacyEnd);
    } else {
      source = source.slice(0, legacyStart) + buildTencentImageGenerationProgressSource() + "\n" + source.slice(legacyEnd);
    }
    changed = true;
  } else if (!hasCurrentImageGenerationProgress) {
    source = replaceOnce(
      source,
      "tencent-image-generation-progress-helper",
      "function historyBuffer(options = {}) {",
      buildTencentImageGenerationProgressSource() + "\nfunction historyBuffer(options = {}) {",
    );
    changed = true;
  }
  if (!source.includes("qqbotOverlaySendImageGenerationProgress(envelope, account, dlog)")) {
    source = replaceOnce(
      source,
      "tencent-image-generation-progress-dispatch",
      "  const qualifiedTarget = envelope.targetId;\n",
      [
        "  const qualifiedTarget = envelope.targetId;",
        "  const imageGenerationRequest = qqbotOverlayIsImageGenerationRequest(assembled.rawBody);",
        "  if (imageGenerationRequest) {",
        "    await qqbotOverlaySendImageGenerationProgress(envelope, account, dlog);",
        "  }",
        "  const agentAssembled = imageGenerationRequest",
        "    ? qqbotOverlayPrepareImageGenerationAssembled(assembled)",
        "    : assembled;",
        "",
      ].join("\n"),
    );
    source = replaceOnce(
      source,
      "tencent-image-generation-progress-context",
      "  const ctxPayload = buildCtxPayload({ assembled, envelope, route, msg, ctx, adapters });",
      [
        "  const ctxPayload = buildCtxPayload({ assembled: agentAssembled, envelope, route, msg, ctx, adapters });",
        "  if (imageGenerationRequest) qqbotOverlayForceImageGenerationContext(ctxPayload);",
      ].join("\n"),
    );
    source = replaceOnce(
      source,
      "tencent-image-generation-progress-ingest",
      "          textForAgent: assembled.agentBody,",
      "          textForAgent: agentAssembled.agentBody,",
    );
    changed = true;
  }
  if (!source.includes("media: qqbotOverlayBuildInboundMediaFacts(processed, voiceUrls),")) {
    const legacyMediaField = [
      "    media: voicePaths.length > 0 ? voicePaths.map((p2, i) => ({",
      "      contentType: processed?.localMediaTypes?.[i] ?? \"audio/silk\",",
      "      localPath: p2,",
      "      url: voiceUrls[i]",
      "    })) : voiceUrls.length > 0 ? voiceUrls.map((u2) => ({ contentType: \"audio/wav\", url: u2 })) : void 0,"
    ].join("\n");
    source = replaceOnce(
      source,
      "tencent-canonical-inbound-media-field",
      legacyMediaField,
      "    media: qqbotOverlayBuildInboundMediaFacts(processed, voiceUrls),",
    );
    changed = true;
  }

  // Inject this after legacy helper cleanup, which may remove text up to the
  // next historyBuffer declaration while upgrading older bundle patches.
  if (!source.includes(TENCENT_CONTEXT_POLICY_MARKER)) {
    source = replaceOnce(
      source,
      "tencent-context-policy-injection",
      "function historyBuffer(options = {}) {",
      buildInjectedQqbotContextPolicySource() + "\nfunction historyBuffer(options = {}) {",
    );
    changed = true;
  }
  if (!source.includes("ctx.state.history = qqbotContextSelectRelevantGroupHistory(buffered, ctx.message.content);")) {
    source = replaceOnce(
      source,
      "tencent-context-policy-selection",
      "    ctx.state.history = buffered;",
      "    ctx.state.history = qqbotContextSelectRelevantGroupHistory(buffered, ctx.message.content);",
    );
    changed = true;
  }

  if (!source.includes("qqbotOverlayPrepareMedia(ctx, result, ctx.log)") ||
      !source.includes("qqbotOverlayPrepareForwardRecord(ctx, ctx.log)") ||
      !source.includes("media: qqbotOverlayBuildInboundMediaFacts(processed, voiceUrls),") ||
      !source.includes(TENCENT_CONTEXT_POLICY_MARKER) ||
      !source.includes("ctx.state.history = qqbotContextSelectRelevantGroupHistory(buffered, ctx.message.content);") ||
      !source.includes(TENCENT_IMAGE_GENERATION_PROGRESS_MARKER) ||
      !source.includes("qqbotOverlaySendImageGenerationProgress(envelope, account, dlog)") ||
      !source.includes("qqbotOverlayForceImageGenerationContext(ctxPayload)")) {
    throw new Error("QQ history-media patch did not install Tencent media/forward-record overlay");
  }
  if (!changed) return false;
  const tempFile = `${file}.qqbot-tencent-media.tmp`;
  fs.writeFileSync(tempFile, source, "utf8");
  fs.renameSync(tempFile, file);
  return true;
}

export { buildTencentMediaOverlaySource, buildTencentMediaRecoverySource, upgradeTencentMediaOverlay };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const tencentBundle = findTencentBundle();
  if (tencentBundle) {
    const changed = patchTencentBundle(tencentBundle);
    console.log(`${changed ? "Applied" : "Already applied"} QQ media attachment safety patch: ${tencentBundle}`);
  } else {
    const bundle = findGatewayBundle();
    if (!bundle) throw new Error("QQ history-media patch: installed Tencent QQBot 2.x or legacy QQBot bundle was not found");
    const changed = patchBundle(bundle);
    console.log(`${changed ? "Applied" : "Already applied"} QQ media attachment safety patch: ${bundle}`);
  }
}
