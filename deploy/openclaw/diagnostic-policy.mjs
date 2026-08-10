function isGroupSession(sessionKey) {
  const value = String(sessionKey ?? "");
  return value.includes(":qqbot:group:") || value.includes("qqbot:group:");
}

function readText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(readText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  return [value.text, value.content, value.body, value.message].map(readText).filter(Boolean).join("\n");
}

export function isProcessPreamble(payload) {
  const text = readText(payload).trim().replace(/\s+/g, " ");
  if (!text || text.length > 240 || /[\u3400-\u9fff]/u.test(text)) return false;
  const startsLikePreamble = /^(let me|i(?:'m| am) going to|i(?:'ll| will) first|first,? let me|now i(?:'ll| will)|i need to)\b/i.test(text);
  const describesInternalStep = /(look at (the )?image|understand (the )?image|analy[sz]e (the )?image|search for (it|this|that)|check (whether|if)|inspect (the )?image)/i.test(text);
  return /^[\x00-\x7f\s.,'!?()\-:;]+$/.test(text) && startsLikePreamble && describesInternalStep;
}

export function shouldSuppressQQPayload({ channel, sessionKey, payload = {} }) {
  if (String(channel ?? "").toLowerCase() !== "qqbot") return { suppress: false };
  if (isProcessPreamble(payload)) return { suppress: true, reason: "qqbot_process_preamble_suppressed" };
  if (!isGroupSession(sessionKey)) return { suppress: false };
  if (payload.isError === true || payload.isFallbackNotice === true) {
    return { suppress: true, reason: "qqbot_group_diagnostic_suppressed" };
  }
  return { suppress: false };
}
