import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  allowHistoricalMedia,
  filterMediaByCapability,
  filterVideoByMention,
  buildInjectedMediaPolicySource,
  isQqMediaDownloadUrl,
  sanitizeQqMediaUrls,
  applySingleImageLimit,
  selectSingleImage,
  shouldUseRecentImage,
  parseMediaCapabilities,
} from "../../deploy/openclaw/media-policy.mjs";

const processed = {
  imageUrls: ["current-image"],
  imageMediaTypes: ["image/png"],
  videoAttachmentPaths: ["current-video"],
  videoAttachmentTypes: ["video/mp4"],
  otherAttachments: ["document"],
};

test("media capabilities fail closed and only expose enabled media", () => {
  assert.deepEqual(parseMediaCapabilities('{"image":true,"video":false}'), { image: true, video: false });
  const imageOnly = filterMediaByCapability(processed, { image: true, video: false });
  assert.deepEqual(imageOnly.imageUrls, ["current-image"]);
  assert.deepEqual(imageOnly.videoAttachmentPaths, []);
  assert.deepEqual(filterMediaByCapability(processed, "not-json").imageUrls, []);
});

test("video requires the current group mention but direct messages can pass", () => {
  assert.deepEqual(filterVideoByMention(processed, false).videoAttachmentPaths, []);
  assert.deepEqual(filterVideoByMention(processed, true).videoAttachmentPaths, ["current-video"]);
  assert.equal(allowHistoricalMedia({ isGroup: true, hasCurrentAttachments: false }), false);
  assert.equal(allowHistoricalMedia({ isGroup: true, hasCurrentAttachments: true }), true);
  assert.equal(allowHistoricalMedia({ isGroup: false, hasCurrentAttachments: false }), true);
});

test("group image selection keeps one relevant image", () => {
  assert.equal(shouldUseRecentImage("看看上面的图"), true);
  assert.equal(shouldUseRecentImage("今天天气不错"), false);
  assert.deepEqual(selectSingleImage({
    currentUrls: ["current-1", "current-2"],
    currentTypes: ["image/jpeg", "image/png"],
    quotedImage: { path: "quoted", contentType: "image/png" },
    recentImage: { path: "recent", contentType: "image/png" },
    text: "看看上面的图",
  }), { path: "quoted", contentType: "image/png", source: "quote" });
  assert.deepEqual(selectSingleImage({
    currentUrls: ["current-1", "current-2"],
    currentTypes: ["image/jpeg", "image/png"],
  }), { path: "current-1", contentType: "image/jpeg", source: "current" });
  assert.deepEqual(applySingleImageLimit({
    imageUrls: [],
    imageMediaTypes: [],
  }, {
    quotedImage: { path: "quoted", contentType: "image/png" },
    recentImage: { path: "recent", contentType: "image/png" },
    text: "看看上面的图",
  }).imageUrls, ["quoted"]);
  assert.deepEqual(applySingleImageLimit({
    imageUrls: [],
    imageMediaTypes: [],
  }, {
    recentImage: { path: "recent", contentType: "image/png" },
    text: "随便说说",
  }).imageUrls, []);
});

test("the patcher's injected runtime policy follows the same fail-closed behavior", () => {
  const source = buildInjectedMediaPolicySource("/tmp/media-capabilities.json");
  const runtime = vm.runInNewContext(`${source}; ({ filterMediaByCapability, filterVideoByMention, applySingleImageLimit, selectRecentGroupImage })`, {
    fs$1: { readFileSync: () => '{"image":true,"video":false}' },
  });
  assert.deepEqual(Array.from(runtime.filterMediaByCapability(processed).imageUrls), ["current-image"]);
  assert.deepEqual(Array.from(runtime.filterMediaByCapability(processed).videoAttachmentPaths), []);
  assert.deepEqual(Array.from(runtime.filterVideoByMention(processed, false).videoAttachmentPaths), []);
  assert.deepEqual(Array.from(runtime.applySingleImageLimit({
    imageUrls: [],
    imageMediaTypes: [],
  }, {
    recentImage: { path: "recent" },
    text: "看上面的图",
  }).imageUrls), ["recent"]);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.selectRecentGroupImage([
    { attachments: [{ type: "image", localPath: "recent-group-image" }] },
  ], "看上面的图"))), { path: "recent-group-image", contentType: "image/png" });

  const disabledRuntime = vm.runInNewContext(`${source}; ({ mergeSingleQuotedImage, imageMediaFromAttachments, isQqMediaDownloadUrl, sanitizeQqMediaUrls })`, {
    fs$1: { readFileSync: () => '{"image":false,"video":false}' },
    URL,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(disabledRuntime.mergeSingleQuotedImage({ imageUrls: [], imageMediaTypes: [] }, {
    media: [{ path: "quoted-image", contentType: "image/png" }],
  }, null, "看引用图"))), {
    imageUrls: [],
    imageMediaTypes: [],
    videoAttachmentPaths: [],
    videoAttachmentTypes: [],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(disabledRuntime.imageMediaFromAttachments([
    { type: "file", localPath: "not-an-image" },
    { type: "image", localPath: "actual-image" },
  ]))), [{ path: "actual-image", contentType: "image/png" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(disabledRuntime.imageMediaFromAttachments([
    { type: "image", url: "https://multimedia.nt.qq.com.cn/download?appid=x" },
  ]))), []);
  assert.equal(disabledRuntime.isQqMediaDownloadUrl("https://multimedia.nt.qq.com.cn/download?appid=x"), true);
  assert.equal(disabledRuntime.isQqMediaDownloadUrl("https://example.com/download?appid=x"), false);
  assert.equal(disabledRuntime.sanitizeQqMediaUrls("前 https://multimedia.nt.qq.com.cn/download?appid=x&rkey=y 后"), "前 [QQ image attachment] 后");
});

test("quoted QQ media uses a local download result and never returns the signed URL", async () => {
  const source = buildInjectedMediaPolicySource("/tmp/media-capabilities.json");
  const png = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  let fetchOptions;
  const runtime = vm.runInNewContext(`${source}; ({ resolveQuoteImageMedia })`, {
    URL,
    AbortController: class {
      signal = {};
      abort() {}
    },
    Buffer,
    clearTimeout,
    crypto: { randomBytes: () => ({ toString: () => "abcdef" }) },
    fetchWithSsrFGuard: async (options) => {
      fetchOptions = options;
      return {
      response: {
        ok: true,
        headers: { get: (name) => name === "content-type" ? "image/png" : "0" },
        body: [png],
      },
      release: async () => {},
      };
    },
    fs$1: {
      readFileSync: () => '{"image":true,"video":false}',
      mkdirSync: () => {},
      promises: { writeFile: async () => {} },
    },
    getQQBotMediaDir: () => "/home/node/.openclaw/media/qqbot/downloads",
    path$1: { join: (...parts) => parts.join("/") },
    parseImageSize: () => ({ width: 1, height: 1 }),
    setTimeout,
  });
  const media = await runtime.resolveQuoteImageMedia(
    [],
    { accountId: "default", config: {} },
    { cfg: {}, adapters: { audioConvert: {} } },
    { debug: () => {} },
    "引用内容 https://multimedia.nt.qq.com.cn/download?appid=x&rkey=y",
  );
  assert.equal(media.length, 1);
  assert.equal(media[0].contentType, "image/png");
  assert.match(media[0].path, /^\/home\/node\/\.openclaw\/media\/qqbot\/downloads\/qq-quoted-image_/);
  assert.deepEqual(JSON.parse(JSON.stringify(fetchOptions.policy)), {
    hostnameAllowlist: ["multimedia.nt.qq.com.cn"],
    allowedHostnames: ["multimedia.nt.qq.com.cn"],
  });
});

test("QQ signed media URLs are recognized narrowly and redacted from model text", () => {
  assert.equal(isQqMediaDownloadUrl("https://multimedia.nt.qq.com.cn/download?appid=x"), true);
  assert.equal(isQqMediaDownloadUrl("https://multimedia.nt.qq.com.cn.evil.example/download?appid=x"), false);
  assert.equal(sanitizeQqMediaUrls("图片 https://multimedia.nt.qq.com.cn/download?appid=x&rkey=y"), "图片 [QQ image attachment]");
});
