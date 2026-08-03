import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

function isGroupSession(sessionKey) {
  const value = String(sessionKey ?? "");
  return value.includes(":qqbot:group:") || value.includes("qqbot:group:");
}

function readText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(readText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";

  return [value.text, value.content, value.body, value.message]
    .map(readText)
    .filter(Boolean)
    .join("\n");
}

function isProcessPreamble(payload) {
  const text = readText(payload).trim().replace(/\s+/g, " ");
  if (!text || text.length > 240 || /[\u3400-\u9fff]/u.test(text)) return false;

  const startsLikePreamble = /^(let me|i(?:'m| am) going to|i(?:'ll| will) first|first,? let me|now i(?:'ll| will)|i need to)\b/i.test(text);
  const describesInternalStep = /(look at (the )?image|understand (the )?image|analy[sz]e (the )?image|search for (it|this|that)|check (whether|if)|inspect (the )?image)/i.test(text);
  const asciiOnly = /^[\x00-\x7f\s.,'!?()\-:;]+$/.test(text);

  return asciiOnly && startsLikePreamble && describesInternalStep;
}

export default definePluginEntry({
  id: "qq-diagnostic-filter",
  name: "QQ Diagnostic Filter",
  description: "Suppresses internal diagnostics and process preambles in QQ groups.",
  register(api) {
    api.on(
      "reply_payload_sending",
      async (event, ctx) => {
        const channel = String(event.channel ?? ctx?.channelId ?? "").toLowerCase();
        if (channel !== "qqbot") return;

        const sessionKey = event.sessionKey ?? ctx?.sessionKey;
        const payload = event.payload ?? {};
        const processPreamble = isProcessPreamble(payload);
        if (processPreamble) {
          api.logger.info?.("suppressed QQ process preamble");
          return {
            cancel: true,
            reason: "qqbot_process_preamble_suppressed",
          };
        }

        if (!isGroupSession(sessionKey)) return;
        if (payload.isError !== true && payload.isFallbackNotice !== true) return;

        api.logger.info?.("suppressed QQ group diagnostic payload");
        return {
          cancel: true,
          reason: "qqbot_group_diagnostic_suppressed",
        };
      },
      { priority: 1000 },
    );
  },
});
