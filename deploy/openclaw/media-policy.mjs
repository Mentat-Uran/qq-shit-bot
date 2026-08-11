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
  if (currentUrls[0]) return { path: currentUrls[0], contentType: currentTypes[0] || "image/png", source: "current" };
  if (quotedImage?.path) return { ...quotedImage, source: "quote" };
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
\tif (currentUrls[0]) return { path: currentUrls[0], contentType: currentTypes[0] || "image/png", source: "current" };
\tif (quotedImage?.path) return { ...quotedImage, source: "quote" };
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
\t\t\tconst contentType = attachment?.contentType || attachment?.content_type || "image/png";
\t\t\treturn { attachment, path: paths[index] || attachment?.localPath || attachment?.url, contentType };
\t\t})
\t\t.filter(({ attachment, path, contentType }) => attachment?.type === "image" || contentType.startsWith("image/"))
\t\t.filter(({ path }) => Boolean(path))
\t\t.slice(0, 1)
\t\t.map(({ path, contentType }) => ({ path, contentType }));
}

function mergeSingleQuotedImage(processed, replyTo, recentImage, text = "") {
\treturn applySingleImageLimit(processed, {
\t\tquotedImage: replyTo?.media?.[0],
\t\trecentImage,
\t\ttext
\t});
}
`;
}
