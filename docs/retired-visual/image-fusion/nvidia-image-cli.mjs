import { readFile } from "node:fs/promises";
import { basename } from "node:path";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const mediaPath = option("--media-path");
const rawPrompt = option("--prompt", "识别图片中的主要对象、场景、文字和关键细节。");
const prompt = rawPrompt.includes("{{") ? "识别图片中的主要对象、场景、文字和关键细节。" : rawPrompt;
const maxChars = option("--max-chars", "2000");
const bridgeUrl = process.env.IMAGE_FUSION_BRIDGE_URL || "http://image-fusion:8080/analyze-image";

if (!mediaPath || mediaPath.includes("{{")) {
  console.error("A local image media path was not provided.");
  process.exit(2);
}

try {
  const bytes = await readFile(mediaPath);
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/jpeg" }), basename(mediaPath));
  form.append("prompt", prompt);
  form.append("max_chars", maxChars);

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
  console.error(`NVIDIA plus Qwen image analysis failed: ${error.message}`);
  process.exit(1);
}
