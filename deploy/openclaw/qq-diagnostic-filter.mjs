import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

function isGroupSession(sessionKey) {
  const value = String(sessionKey ?? "");
  return value.includes(":qqbot:group:") || value.includes("qqbot:group:");
}

export default definePluginEntry({
  id: "qq-diagnostic-filter",
  name: "QQ Diagnostic Filter",
  description: "Suppresses internal error and model-fallback payloads in QQ groups.",
  register(api) {
    api.on(
      "reply_payload_sending",
      async (event, ctx) => {
        const channel = String(event.channel ?? ctx?.channelId ?? "").toLowerCase();
        if (channel !== "qqbot") return;

        const sessionKey = event.sessionKey ?? ctx?.sessionKey;
        if (!isGroupSession(sessionKey)) return;

        const payload = event.payload ?? {};
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
