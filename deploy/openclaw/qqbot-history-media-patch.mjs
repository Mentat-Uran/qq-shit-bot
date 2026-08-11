import fs from "node:fs";
import path from "node:path";
import { buildInjectedMediaPolicySource } from "./media-policy.mjs";

const PATCH_MARKER = "/* qqbot-history-media-v1 */";
const MEDIA_CAPABILITY_MARKER = "/* qqbot-media-capabilities-v1 */";
const VIDEO_MENTION_GATE_MARKER = "/* qqbot-video-mention-gate-v2 */";
const LEGACY_VIDEO_MENTION_GATE_MARKER = "/* qqbot-video-mention-gate-v1 */";
const HISTORICAL_MEDIA_DISABLED_MARKER = "/* qqbot-historical-media-disabled-v2 */";
const QUOTE_IMAGE_CONTEXT_MARKER = "/* qqbot-single-image-context-v1 */";
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
  }
  if (!source.includes("function filterVideoByMention(processed, allowVideo)")) {
    source = source.replace(`${MEDIA_CAPABILITY_MARKER}\n`, `${helper}`);
  } else {
    source = source.replaceAll(LEGACY_VIDEO_MENTION_GATE_MARKER, VIDEO_MENTION_GATE_MARKER);
  }
  const userContentPrefix = source.includes(`\tlet { parsedContent, userContent } = buildUserContent({`)
    ? `\tlet { parsedContent, userContent } = buildUserContent({`
    : `\tconst { parsedContent, userContent } = buildUserContent({`;
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

const bundle = findGatewayBundle();
if (!bundle) throw new Error("QQ history-media patch: installed @openclaw/qqbot gateway bundle was not found");
const changed = patchBundle(bundle);
console.log(`${changed ? "Applied" : "Already applied"} QQ media attachment safety patch: ${bundle}`);
function addQuoteImageContext(source) {
  if (source.includes(QUOTE_IMAGE_CONTEXT_MARKER)) return source;
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
  return source;
}
