import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { shouldSuppressQQPayload } from "./diagnostic-policy.mjs";

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

        const decision = shouldSuppressQQPayload({
          channel,
          sessionKey: event.sessionKey ?? ctx?.sessionKey,
          payload: event.payload ?? {},
        });
        if (!decision.suppress) return;
        api.logger.info?.(`suppressed QQ payload: ${decision.reason}`);
        return { cancel: true, reason: decision.reason };
      },
      { priority: 1000 },
    );
  },
});
