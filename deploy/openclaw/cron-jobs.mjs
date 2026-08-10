export const PROACTIVE_REVIEW_JOBS = Object.freeze([
  { name: "qqbot-proactive-review", cron: "*/10 8-23,0-1 * * *", declarationKey: "qqbot-proactive-review" },
  { name: "qqbot-proactive-review-night", cron: "*/30 2-7 * * *", declarationKey: "qqbot-proactive-review-night" },
]);

export function reconcileDeclarativeJobs(existingJobs, desiredJobs = PROACTIVE_REVIEW_JOBS) {
  const existing = new Map(
    (existingJobs ?? []).filter((job) => job?.declarationKey).map((job) => [job.declarationKey, job]),
  );
  return desiredJobs.map((job) => ({ ...job, action: existing.has(job.declarationKey) ? "reuse" : "add" }));
}
