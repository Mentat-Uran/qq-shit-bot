import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  allowHistoricalMedia,
  filterMediaByCapability,
  filterVideoByMention,
  buildInjectedMediaPolicySource,
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

test("the patcher's injected runtime policy follows the same fail-closed behavior", () => {
  const source = buildInjectedMediaPolicySource("/tmp/media-capabilities.json");
  const runtime = vm.runInNewContext(`${source}; ({ filterMediaByCapability, filterVideoByMention })`, {
    fs$1: { readFileSync: () => '{"image":true,"video":false}' },
  });
  assert.deepEqual(Array.from(runtime.filterMediaByCapability(processed).imageUrls), ["current-image"]);
  assert.deepEqual(Array.from(runtime.filterMediaByCapability(processed).videoAttachmentPaths), []);
  assert.deepEqual(Array.from(runtime.filterVideoByMention(processed, false).videoAttachmentPaths), []);
});
