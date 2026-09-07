import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import {
  buildTencentMediaOverlaySource,
  upgradeTencentMediaOverlay,
} from "../../deploy/openclaw/qqbot-history-media-patch.mjs";

const require = createRequire(import.meta.url);

function buildRuntime() {
  const source = buildTencentMediaOverlaySource();
  return vm.runInNewContext(
    `${source}; ({ qqbotOverlayExtractForwardRecord, qqbotOverlayImageCandidate, qqbotOverlayResolveImage })`,
    {
      require,
      Buffer,
      URL,
      setTimeout,
      clearTimeout,
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      getQQBotMediaDir: () => "/tmp/qqbot-forward-record-test",
    },
  );
}

const runtime = buildRuntime();
const signedImageUrl = "https://multimedia.nt.qq.com.cn/download?appid=test&rkey=test";
const nestedImage = { content_type: "image/png", url: signedImageUrl, filename: "forward.png" };
const expandedCard = {
  app: "com.tencent.multimsg",
  config: { forward: 1 },
  meta: { detail: { resid: "opaque-test", news: [{ text: "图片消息" }] } },
  nodes: [{ sender: "A", content: "一张图", attachments: [nestedImage] }],
};

test("forward records accept plain JSON and CQ JSON wrappers", () => {
  const plain = runtime.qqbotOverlayExtractForwardRecord({
    message: { content: JSON.stringify(expandedCard) },
  });
  const cq = runtime.qqbotOverlayExtractForwardRecord({
    message: { content: `[CQ:json,data=${JSON.stringify(expandedCard)}]` },
  });
  const cqEscaped = runtime.qqbotOverlayExtractForwardRecord({
    message: { content: `[CQ:json,data=${JSON.stringify(expandedCard).replaceAll(",", "&#44;")}]` },
  });
  const cqImage = runtime.qqbotOverlayExtractForwardRecord({
    message: {
      content: JSON.stringify({
        ...expandedCard,
        nodes: [{ raw_message: `[CQ:image,file=forward.png,url=${signedImageUrl}]` }],
      }),
    },
  });

  assert.equal(plain?.imageCandidates.length, 1);
  assert.equal(cq?.imageCandidates.length, 1);
  assert.equal(cqEscaped?.imageCandidates.length, 1);
  assert.equal(cqImage?.imageCandidates.length, 1);
  assert.match(cq.text, /一张图/);
});

test("forward records collect images from raw attachments outside the card payload", () => {
  const record = runtime.qqbotOverlayExtractForwardRecord({
    message: {
      content: JSON.stringify({ ...expandedCard, nodes: [] }),
      raw: { attachments: [{ type: "image", localPath: "/tmp/forward-raw.png" }] },
    },
  });

  assert.equal(record?.imageCandidates.length, 1);
  assert.equal(record?.imageCandidates[0].localPath, "/tmp/forward-raw.png");
});

test("forward image candidates accept QQ field variants without weakening URL safety", async () => {
  const candidate = runtime.qqbotOverlayImageCandidate({
    kind: "photo",
    image_url: { path: "/tmp/forward-variant.webp" },
    mime_type: "image/webp",
    name: "variant.webp",
  });

  assert.deepEqual(JSON.parse(JSON.stringify(candidate)), {
    url: "",
    localPath: "/tmp/forward-variant.webp",
    filename: "variant.webp",
    contentType: "image/webp",
  });
  const external = runtime.qqbotOverlayImageCandidate({ type: "image", url: "https://example.invalid/image.png" });
  assert.equal(external?.url, "https://example.invalid/image.png");
  assert.equal(await runtime.qqbotOverlayResolveImage([external], { debug() {} }), null);
  assert.equal(runtime.qqbotOverlayImageCandidate({ type: "text", path: "/tmp/not-an-image.png" }), null);
});

test("preview-only cards state that the original image pixels were not delivered", () => {
  const record = runtime.qqbotOverlayExtractForwardRecord({
    message: {
      content: JSON.stringify({
        app: "com.tencent.multimsg",
        config: { forward: 1 },
        meta: { detail: { resid: "opaque-test", news: [{ text: "仅摘要" }] } },
      }),
    },
  });

  assert.equal(record?.imageCandidates.length, 0);
  assert.match(record?.text ?? "", /image pixels were not delivered/);
});

test("an already-patched Tencent bundle upgrades the old overlay before it is reused", () => {
  const oldBundle = [
    "prefix",
    "/* qqbot-tencent-media-overlay-v1 */",
    "const oldOverlayHelper = true;",
    "function historyBuffer(options = {}) {}",
    "suffix",
  ].join("\n");
  const upgraded = upgradeTencentMediaOverlay(oldBundle);

  assert.match(upgraded, /qqbot-tencent-media-overlay-v4/);
  assert.match(upgraded, /qqbotForwardRecordDecodeEntities/);
  assert.doesNotMatch(upgraded, /oldOverlayHelper/);
  assert.equal(upgradeTencentMediaOverlay(upgraded), upgraded);
});
