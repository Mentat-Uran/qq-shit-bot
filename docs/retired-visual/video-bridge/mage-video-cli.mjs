import { readFile } from "node:fs/promises";
import { basename } from "node:path";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const mediaPath = option("--media-path");
const rawPrompt = option("--prompt", "Describe the video, including the main events and their order.");
const prompt = rawPrompt.includes("{{") ? "Describe the video, including the main events and their order." : rawPrompt;
const maxChars = option("--max-chars", "2000");
const bridgeUrl = process.env.MAGE_VIDEO_BRIDGE_URL || "http://video-bridge:8080/analyze";

if (!mediaPath || mediaPath.includes("{{")) {
  console.error("A local video media path was not provided.");
  process.exit(2);
}

try {
  const bytes = await readFile(mediaPath);
  const form = new FormData();
  form.append("video", new Blob([bytes], { type: "video/mp4" }), basename(mediaPath));
  form.append("prompt", prompt);
  form.append("max_chars", maxChars);
  form.append("num_frames", process.env.MAGE_VIDEO_NUM_FRAMES || "8");

  const response = await fetch(bridgeUrl, { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || `bridge HTTP ${response.status}`);
  }
  if (!payload.text) {
    throw new Error("bridge returned an empty analysis");
  }
  process.stdout.write(String(payload.text).trim());
} catch (error) {
  console.error(`Mage-VL video analysis failed: ${error.message}`);
  process.exit(1);
}
