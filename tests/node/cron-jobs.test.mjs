import test from "node:test";
import assert from "node:assert/strict";
import { PROACTIVE_REVIEW_JOBS, reconcileDeclarativeJobs } from "../../deploy/openclaw/cron-jobs.mjs";

test("cron registration is declarative and idempotent by declaration key", () => {
  const first = reconcileDeclarativeJobs([]);
  assert.deepEqual(first.map((job) => job.action), ["add", "add"]);
  const second = reconcileDeclarativeJobs(PROACTIVE_REVIEW_JOBS);
  assert.deepEqual(second.map((job) => job.action), ["reuse", "reuse"]);
  assert.deepEqual(second.map((job) => job.declarationKey), [
    "qqbot-proactive-review",
    "qqbot-proactive-review-night",
  ]);
});
