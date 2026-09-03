const DEFAULT_CAPABILITIES = Object.freeze({ image: false, video: false });

export function parseMediaCapabilities(value) {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  return { image: value?.image === true, video: value?.video === true };
}

export function filterMediaByCapability(processed, capabilities = DEFAULT_CAPABILITIES) {
  const allowed = parseMediaCapabilities(capabilities);
  return {
    ...processed,
    imageUrls: allowed.image ? (processed.imageUrls ?? []).slice(0, 1) : [],
    imageMediaTypes: allowed.image ? (processed.imageMediaTypes ?? []).slice(0, 1) : [],
    videoAttachmentPaths: allowed.video ? (processed.videoAttachmentPaths ?? []) : [],
    videoAttachmentTypes: allowed.video ? (processed.videoAttachmentTypes ?? []) : [],
  };
}

export function filterVideoByMention(processed, allowVideo) {
  if (allowVideo) return { ...processed };
  return { ...processed, videoAttachmentPaths: [], videoAttachmentTypes: [] };
}

export function allowHistoricalMedia({ isGroup, hasCurrentAttachments }) {
  return !isGroup || hasCurrentAttachments;
}

const RECENT_IMAGE_REFERENCE_RE = /上图|上面的?图|刚才(?:那张)?图|前面(?:那张)?图|这张图|这图|图片里|图里|截图里|图上|画面/;

export function shouldUseRecentImage(text = "") {
  return RECENT_IMAGE_REFERENCE_RE.test(String(text));
}

export function selectSingleImage({ currentUrls = [], currentTypes = [], quotedImage, recentImage, text = "" } = {}) {
  if (quotedImage?.path) return { ...quotedImage, source: "quote" };
  if (currentUrls[0]) return { path: currentUrls[0], contentType: currentTypes[0] || "image/png", source: "current" };
  if (shouldUseRecentImage(text) && recentImage?.path) return { ...recentImage, source: "recent" };
  return null;
}

export function applySingleImageLimit(processed, { quotedImage, recentImage, text = "" } = {}) {
  const selected = selectSingleImage({
    currentUrls: processed.imageUrls,
    currentTypes: processed.imageMediaTypes,
    quotedImage,
    recentImage,
    text,
  });
  return {
    ...processed,
    imageUrls: selected ? [selected.path] : [],
    imageMediaTypes: selected ? [selected.contentType || "image/png"] : [],
  };
}

const QQ_MEDIA_DOWNLOAD_URL_RE = /https:\/\/multimedia\.nt\.qq\.com\.cn\/download\?[^\s<>"'\])}]+/gi;

export function isQqMediaDownloadUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "https:"
      && parsed.hostname.toLowerCase() === "multimedia.nt.qq.com.cn"
      && parsed.pathname === "/download";
  } catch {
    return false;
  }
}

export function sanitizeQqMediaUrls(value) {
  return String(value ?? "").replace(QQ_MEDIA_DOWNLOAD_URL_RE, "[QQ image attachment]");
}

// The installed QQ bundle cannot import this repository module after it has
// been patched, so the patcher injects this same policy with its local fs alias.
export function buildInjectedMediaPolicySource(mediaCapabilitiesPath) {
  return `function readMediaCapabilities() {
\ttry {
\t\tconst value = JSON.parse(fs$1.readFileSync(${JSON.stringify(mediaCapabilitiesPath)}, "utf8"));
\t\treturn { image: value.image === true, video: value.video === true };
\t} catch {
\t\treturn { image: false, video: false };
\t}
}

function filterMediaByCapability(processed) {
\tconst capabilities = readMediaCapabilities();
\treturn {
\t\t...processed,
\t\timageUrls: capabilities.image ? (processed.imageUrls ?? []).slice(0, 1) : [],
\t\timageMediaTypes: capabilities.image ? (processed.imageMediaTypes ?? []).slice(0, 1) : [],
\t\tvideoAttachmentPaths: capabilities.video ? (processed.videoAttachmentPaths ?? []) : [],
\t\tvideoAttachmentTypes: capabilities.video ? (processed.videoAttachmentTypes ?? []) : []
\t};
}

function filterVideoByMention(processed, allowVideo) {
\tif (allowVideo) return processed;
\treturn {
\t\t...processed,
\t\tvideoAttachmentPaths: [],
\t\tvideoAttachmentTypes: []
\t};
}

const RECENT_IMAGE_REFERENCE_RE = /上图|上面的?图|刚才(?:那张)?图|前面(?:那张)?图|这张图|这图|图片里|图里|截图里|图上|画面/;

function shouldUseRecentImage(text = "") {
\treturn RECENT_IMAGE_REFERENCE_RE.test(String(text));
}

function selectSingleImage({ currentUrls = [], currentTypes = [], quotedImage, recentImage, text = "" } = {}) {
\tif (quotedImage?.path) return { ...quotedImage, source: "quote" };
\tif (currentUrls[0]) return { path: currentUrls[0], contentType: currentTypes[0] || "image/png", source: "current" };
\tif (shouldUseRecentImage(text) && recentImage?.path) return { ...recentImage, source: "recent" };
\treturn null;
}

function applySingleImageLimit(processed, { quotedImage, recentImage, text = "" } = {}) {
\tconst selected = selectSingleImage({
\t\tcurrentUrls: processed.imageUrls,
\t\tcurrentTypes: processed.imageMediaTypes,
\t\tquotedImage,
\t\trecentImage,
\t\ttext
\t});
\treturn {
\t\t...processed,
\t\timageUrls: selected ? [selected.path] : [],
\t\timageMediaTypes: selected ? [selected.contentType || "image/png"] : []
\t};
}

function selectRecentGroupImage(historyEntries, text = "") {
\tif (!shouldUseRecentImage(text)) return null;
\tconst entries = Array.isArray(historyEntries) ? historyEntries : [];
\tfor (let i = entries.length - 1; i >= 0; i--) {
\t\tconst attachments = Array.isArray(entries[i]?.attachments) ? entries[i].attachments : [];
\t\tfor (let j = attachments.length - 1; j >= 0; j--) {
\t\t\tconst attachment = attachments[j];
\t\t\tif (attachment?.type !== "image") continue;
\t\t\tconst path = attachment.localPath || attachment.url;
\t\t\tif (path) return { path, contentType: attachment.contentType || "image/png" };
\t\t}
\t}
\treturn null;
}

function imageMediaFromAttachments(attachments, processed) {
\tconst paths = processed?.attachmentLocalPaths ?? [];
\treturn (Array.isArray(attachments) ? attachments : [])
\t\t.map((attachment, index) => {
\t\t\tconst normalized = normalizeQuoteImageAttachment(attachment);
\t\t\tif (!normalized) return { path: null, contentType: "", isImage: false };
\t\t\tconst path = paths[index] || attachment?.localPath || (
\t\t\t\tisQqMediaDownloadUrl(attachment?.url) ? null : attachment?.url
\t\t\t);
\t\t\treturn { path, contentType: normalized.content_type, isImage: true };
\t\t})
\t\t.filter(({ isImage }) => isImage)
\t\t.filter(({ path }) => Boolean(path))
\t\t.slice(0, 1)
\t\t.map(({ path, contentType }) => ({ path, contentType }));
}

function isQqMediaDownloadUrl(value) {
\ttry {
\t\tconst parsed = new URL(String(value));
\t\treturn parsed.protocol === "https:"
\t\t\t&& parsed.hostname.toLowerCase() === "multimedia.nt.qq.com.cn"
\t\t\t&& parsed.pathname === "/download";
\t} catch {
\t\treturn false;
\t}
}

function sanitizeQqMediaUrls(value) {
\tconst text = String(value ?? "");
\tconst prefix = "https://multimedia.nt.qq.com.cn/download?";
\tlet cursor = 0;
\tlet output = "";
\twhile (true) {
\t\tconst start = text.indexOf(prefix, cursor);
\t\tif (start < 0) return output + text.slice(cursor);
\t\toutput += text.slice(cursor, start) + "[QQ image attachment]";
\t\tlet end = start + prefix.length;
\t\twhile (end < text.length) {
\t\t\tconst code = text.charCodeAt(end);
\t\t\tconst ch = text[end];
\t\t\tif (code <= 32 || code === 34 || code === 39 || ch === "<" || ch === ">" || ch === ")" || ch === "]" || ch === "}") break;
\t\t\tend += 1;
\t\t}
\t\tcursor = end;
\t}
}

function extractQqMediaDownloadUrl(value) {
\tconst text = String(value ?? "");
\tconst prefix = "https://multimedia.nt.qq.com.cn/download?";
\tconst start = text.indexOf(prefix);
\tif (start < 0) return null;
\tlet end = start + prefix.length;
\twhile (end < text.length) {
\t\tconst code = text.charCodeAt(end);
\t\tconst ch = text[end];
\t\tif (code <= 32 || code === 34 || code === 39 || ch === "<" || ch === ">" || ch === ")" || ch === "]" || ch === "}") break;
\t\tend += 1;
\t}
\treturn text.slice(start, end);
}

function normalizeQuoteImageAttachment(attachment) {
\tconst declaredType = String(attachment?.contentType ?? attachment?.content_type ?? "").toLowerCase();
\tconst isImage = attachment?.type === "image"
\t\t|| declaredType.startsWith("image/")
\t\t|| isQqMediaDownloadUrl(attachment?.url);
\tif (!isImage) return null;
\treturn {
\t\t...attachment,
\t\ttype: "image",
\t\tcontent_type: declaredType || "image/png"
\t};
}

function isRemoteMediaPath(value) {
\treturn typeof value === "string" && (value.startsWith("http://") || value.startsWith("https://"));
}

async function downloadQqImageToLocal(candidate, log) {
\tif (!isQqMediaDownloadUrl(candidate?.url)) return null;
\tconst controller = new AbortController();
\tconst timeoutId = setTimeout(() => controller.abort(), 30000);
\tlet release = async () => {};
\ttry {
\t\tconst guarded = await fetchWithSsrFGuard({
\t\t\turl: candidate.url,
\t\t\tinit: {
\t\t\t\tmethod: "GET",
\t\t\t\tredirect: "error",
\t\t\t\tsignal: controller.signal,
\t\t\t\theaders: {
\t\t\t\t\tAccept: "image/*",
\t\t\t\t\t"User-Agent": "OpenClaw-QQBot/1.0"
\t\t\t\t}
\t\t\t},
\t\t\tauditContext: "qqbot-quoted-media",
\t\t\tpolicy: {
\t\t\t\thostnameAllowlist: ["multimedia.nt.qq.com.cn"],
\t\t\t\tallowedHostnames: ["multimedia.nt.qq.com.cn"]
\t\t\t}
\t\t});
\t\trelease = guarded.release;
\t\tif (!guarded.response.ok) return null;
\t\tconst maxBytes = 12 * 1024 * 1024;
\t\tconst declaredLength = Number(guarded.response.headers.get("content-length") || 0);
\t\tif (declaredLength > maxBytes) return null;
\t\tconst chunks = [];
\t\tlet total = 0;
\t\tif (guarded.response.body) {
\t\t\tfor await (const chunk of guarded.response.body) {
\t\t\t\tconst bufferChunk = Buffer.from(chunk);
\t\t\t\ttotal += bufferChunk.length;
\t\t\t\tif (total > maxBytes) return null;
\t\t\t\tchunks.push(bufferChunk);
\t\t\t}
\t\t} else {
\t\t\tconst buffer = Buffer.from(await guarded.response.arrayBuffer());
\t\t\tif (buffer.length > maxBytes) return null;
\t\t\tchunks.push(buffer);
\t\t\ttotal = buffer.length;
\t\t}
\t\tconst buffer = Buffer.concat(chunks, total);
\t\tif (!parseImageSize(buffer)) return null;
\t\tconst contentType = (guarded.response.headers.get("content-type") || "").toLowerCase();
\t\tconst filename = String(candidate.filename || "").toLowerCase();
\t\tconst ext = contentType.includes("jpeg") || filename.endsWith(".jpg") || filename.endsWith(".jpeg") ? ".jpg" : contentType.includes("gif") || filename.endsWith(".gif") ? ".gif" : contentType.includes("webp") || filename.endsWith(".webp") ? ".webp" : contentType.includes("bmp") || filename.endsWith(".bmp") ? ".bmp" : ".png";
\t\tconst downloadDir = getQQBotMediaDir("downloads");
\t\tfs$1.mkdirSync(downloadDir, { recursive: true });
\t\tconst destination = path$1.join(downloadDir, "qq-quoted-image_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex") + ext);
\t\tawait fs$1.promises.writeFile(destination, buffer);
\t\treturn destination;
\t} catch (err) {
\t\tconst detail = err instanceof Error ? err.message : String(err);
\t\tlog?.debug?.("[qqbot] QQ quoted image fetch failed: " + detail.slice(0, 160));
\t\treturn null;
\t} finally {
\t\tclearTimeout(timeoutId);
\t\tawait release().catch(() => {});
\t}
}

async function resolveQuoteImageMedia(attachments, account, deps, log, text = "", processed = null) {
\tconst localMedia = imageMediaFromAttachments(attachments, processed);
\tif (localMedia.length > 0) return localMedia;
\tconst candidates = (Array.isArray(attachments) ? attachments : [])
\t\t.map(normalizeQuoteImageAttachment)
\t\t.filter((candidate) => candidate && (candidate.localPath || candidate.url));
\tconst embeddedUrl = extractQqMediaDownloadUrl(text);
\tif (embeddedUrl && !candidates.some((candidate) => candidate.url === embeddedUrl)) {
\t\tcandidates.push(normalizeQuoteImageAttachment({
\t\t\ttype: "image",
\t\t\tcontent_type: "image/png",
\t\t\turl: embeddedUrl
\t\t}));
\t}
\tcandidates.splice(1);
\tfor (const candidate of candidates) {
\t\tconst existingPath = candidate.localPath;
\t\tif (typeof existingPath === "string" && existingPath && !isRemoteMediaPath(existingPath)) {
\t\t\treturn [{ path: existingPath, contentType: candidate.content_type }];
\t\t}
\t\tif (!candidate.url) continue;
\t\tif (isQqMediaDownloadUrl(candidate.url)) {
\t\t\tconst localPath = await downloadQqImageToLocal(candidate, log);
\t\t\tif (localPath) return [{ path: localPath, contentType: candidate.content_type }];
\t\t\tcontinue;
\t\t}
\t\ttry {
\t\t\tconst processed = await processAttachments([candidate], {
\t\t\t\taccountId: account?.accountId,
\t\t\t\tcfg: deps?.cfg ?? account?.config,
\t\t\t\taudioConvert: deps?.adapters?.audioConvert,
\t\t\t\tlog
\t\t\t});
\t\t\tconst localPath = [...(processed?.imageUrls ?? []), ...(processed?.attachmentLocalPaths ?? [])]
\t\t\t\t.find((value) => typeof value === "string" && value && !isRemoteMediaPath(value));
\t\t\tif (localPath) return [{ path: localPath, contentType: candidate.content_type }];
\t\t} catch (err) {
\t\t\tconst detail = err instanceof Error ? err.message : String(err);
\t\t\tlog?.debug?.("[qqbot] quoted image download failed: " + detail.slice(0, 160));
\t\t}
\t}
\treturn [];
}
async function ensureLocalQqImage(image, account, deps, log) {
\tif (!image?.path || !isQqMediaDownloadUrl(image.path)) return image ?? null;
\tconst fetched = await resolveQuoteImageMedia([{
\t\ttype: "image",
\t\tcontentType: image.contentType || "image/png",
\t\turl: image.path
\t}], account, deps, log);
\treturn fetched[0] ?? null;
}

function mergeSingleQuotedImage(processed, replyTo, recentImage, text = "") {
\treturn filterMediaByCapability(applySingleImageLimit(processed, {
\t\tquotedImage: replyTo?.media?.[0],
\t\trecentImage,
\t\ttext
\t}));
}
`;
}
