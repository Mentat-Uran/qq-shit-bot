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
    imageUrls: allowed.image ? (processed.imageUrls ?? []) : [],
    imageMediaTypes: allowed.image ? (processed.imageMediaTypes ?? []) : [],
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
\t\timageUrls: capabilities.image ? (processed.imageUrls ?? []) : [],
\t\timageMediaTypes: capabilities.image ? (processed.imageMediaTypes ?? []) : [],
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
`;
}
