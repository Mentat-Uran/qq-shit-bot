import fs from "node:fs";
import path from "node:path";

const PATCH_MARKER = "/* hermes-qq-history-media-v1 */";
const MEDIA_CAPABILITY_MARKER = "/* hermes-qq-media-capabilities-v1 */";
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

function upgradeMediaCapabilityGate(source) {
  if (source.includes(MEDIA_CAPABILITY_MARKER)) return source;

  const helper = `function readMediaCapabilities() {
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
  source = source.replace(`${PATCH_MARKER}\n`, `${helper}${PATCH_MARKER}\n`);
  source = replaceOnce(
    source,
    "direct-media-capability-filter",
    `\tlet { parsedContent, userContent } = buildUserContent({`,
    `\tprocessed = filterMediaByCapability(processed);\n\tlet { parsedContent, userContent } = buildUserContent({`,
  );
  source = replaceOnce(
    source,
    "historical-media-capability-filter",
    `\t\tif (historicalMedia) {\n\t\t\tprocessed = promoteHistoricalMedia(processed, historicalMedia);\n\t\t\tconst mediaLabel = historicalMedia.type === "video" ? "video" : "image";\n\t\t\tuserContent = [userContent, "[historical " + mediaLabel + ": " + (historicalMedia.filename ?? historicalMedia.messageId ?? "unnamed media") + "]"].filter(Boolean).join("\\n");\n\t\t\tlog?.info?.("QQ historical " + historicalMedia.type + " promoted for @mention");\n\t\t}`,
    `\t\tconst mediaCapabilities = readMediaCapabilities();\n\t\tif (historicalMedia && mediaCapabilities[historicalMedia.type] === true) {\n\t\t\tprocessed = promoteHistoricalMedia(processed, historicalMedia);\n\t\t\tconst mediaLabel = historicalMedia.type === "video" ? "video" : "image";\n\t\t\tuserContent = [userContent, "[historical " + mediaLabel + ": " + (historicalMedia.filename ?? historicalMedia.messageId ?? "unnamed media") + "]"].filter(Boolean).join("\\n");\n\t\t\tlog?.info?.("QQ historical " + historicalMedia.type + " promoted for @mention");\n\t\t} else if (historicalMedia) {\n\t\t\tconst mediaLabel = historicalMedia.type === "video" ? "video" : "image";\n\t\t\tuserContent = [userContent, "[" + mediaLabel + " unavailable: the corresponding local service is disabled]"] .filter(Boolean).join("\\n");\n\t\t\tlog?.info?.("QQ historical " + historicalMedia.type + " blocked because its local service is disabled");\n\t\t}`,
  );
  return source;
}

function patchBundle(file) {
  let source = fs.readFileSync(file, "utf8");
  if (source.includes(PATCH_MARKER)) {
    const upgraded = upgradeMediaCapabilityGate(source);
    if (upgraded === source) return false;
    const tempFile = `${file}.hermes-history-media.tmp`;
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
    "historical-helper",
    `async function buildInboundContext(event, deps) {`,
    `const HISTORICAL_MEDIA_MAX_AGE_MS = 15 * 60 * 1000;\n\nfunction resolveLatestHistoricalMedia(params) {\n\tconst entries = params.historyMap?.get(params.groupOpenid);\n\tif (!entries?.length) return null;\n\tconst now = Date.now();\n\tfor (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {\n\t\tconst entry = entries[entryIndex];\n\t\tif (Number.isFinite(entry.timestamp) && now - entry.timestamp > HISTORICAL_MEDIA_MAX_AGE_MS) continue;\n\t\tconst attachments = entry.attachments ?? [];\n\t\tfor (let attachmentIndex = attachments.length - 1; attachmentIndex >= 0; attachmentIndex--) {\n\t\t\tconst attachment = attachments[attachmentIndex];\n\t\t\tif (attachment.type !== "image" && attachment.type !== "video") continue;\n\t\t\tconst localPath = attachment.localPath;\n\t\t\tif (!localPath || !fs$1.existsSync(localPath)) continue;\n\t\t\treturn {\n\t\t\t\ttype: attachment.type,\n\t\t\t\tfilename: attachment.filename,\n\t\t\t\tlocalPath,\n\t\t\t\tcontentType: attachment.type === "video" ? "video/mp4" : "image/jpeg",\n\t\t\t\tmessageId: entry.messageId\n\t\t\t};\n\t\t}\n\t}\n\treturn null;\n}\n\nfunction promoteHistoricalMedia(processed, media) {\n\tconst attachmentLocalPaths = [...processed.attachmentLocalPaths, media.localPath];\n\tif (media.type === "video") return {\n\t\t...processed,\n\t\tattachmentLocalPaths,\n\t\tvideoAttachmentPaths: [...(processed.videoAttachmentPaths ?? []), media.localPath],\n\t\tvideoAttachmentTypes: [...(processed.videoAttachmentTypes ?? []), media.contentType]\n\t};\n\treturn {\n\t\t...processed,\n\t\tattachmentLocalPaths,\n\t\timageUrls: [...processed.imageUrls, media.localPath],\n\t\timageMediaTypes: [...processed.imageMediaTypes, media.contentType]\n\t};\n}\n\n/* hermes-qq-history-media-v1 */\nasync function buildInboundContext(event, deps) {`,
  );
  source = replaceOnce(
    source,
    "mutable-processed",
    `\tconst processed = await processAttachments(event.attachments, {`,
    `\tlet processed = await processAttachments(event.attachments, {`,
  );
  source = replaceOnce(
    source,
    "mutable-user-content",
    `\tconst { parsedContent, userContent } = buildUserContent({`,
    `\tlet { parsedContent, userContent } = buildUserContent({`,
  );
  source = replaceOnce(
    source,
    "promote-after-gate",
    `\t\tgroupInfo = gateOutcome.groupInfo;\n\t}\n\tconst body = buildBody({`,
    `\t\tgroupInfo = gateOutcome.groupInfo;\n\t}\n\tif (groupInfo?.gate?.effectiveWasMentioned && !event.attachments?.length && event.groupOpenid) {\n\t\tconst historicalMedia = resolveLatestHistoricalMedia({\n\t\t\thistoryMap: deps.groupHistories,\n\t\t\tgroupOpenid: event.groupOpenid\n\t\t});\n\t\tif (historicalMedia) {\n\t\t\tprocessed = promoteHistoricalMedia(processed, historicalMedia);\n\t\t\tconst mediaLabel = historicalMedia.type === "video" ? "video" : "image";\n\t\t\tuserContent = [userContent, "[historical " + mediaLabel + ": " + (historicalMedia.filename ?? historicalMedia.messageId ?? "unnamed media") + "]"].filter(Boolean).join("\\n");\n\t\t\tlog?.info?.("QQ historical " + historicalMedia.type + " promoted for @mention");\n\t\t}\n\t}\n\tconst body = buildBody({`,
  );

  const tempFile = `${file}.hermes-history-media.tmp`;
  fs.writeFileSync(tempFile, source, "utf8");
  fs.renameSync(tempFile, file);
  return true;
}

const bundle = findGatewayBundle();
if (!bundle) throw new Error("QQ history-media patch: installed @openclaw/qqbot gateway bundle was not found");
const changed = patchBundle(bundle);
console.log(`${changed ? "Applied" : "Already applied"} QQ historical media promotion: ${bundle}`);
