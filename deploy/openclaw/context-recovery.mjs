import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const LOG_DIR = "/tmp/openclaw";
const POLL_MS = 1000;
const PENDING_TTL_MS = 30_000;
const RESET_COOLDOWN_MS = 60_000;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const pendingSessionKeys = new Map();
const lastResetAt = new Map();
const resetInFlight = new Set();
const offsets = new Map();

function extractSessionKey(line) {
  return line.match(/sessionKey=(agent:[A-Za-z0-9._:-]+)/)?.[1] ?? null;
}

function isRecoverableGroupSession(sessionKey) {
  return /^agent:[^:]+:qqbot:group:[A-Za-z0-9._-]+$/i.test(sessionKey);
}

function rememberSessionKey(line) {
  const sessionKey = extractSessionKey(line);
  if (!sessionKey) return;
  if (/context-overflow-(precheck|diag)/i.test(line)) {
    pendingSessionKeys.set(sessionKey, Date.now());
  }
  return sessionKey;
}

function findRecentPendingSessionKey() {
  const now = Date.now();
  for (const [sessionKey, seenAt] of pendingSessionKeys) {
    if (now - seenAt > PENDING_TTL_MS) pendingSessionKeys.delete(sessionKey);
  }
  return [...pendingSessionKeys.entries()]
    .sort((left, right) => right[1] - left[1])
    .find(([sessionKey]) => isRecoverableGroupSession(sessionKey))?.[0] ?? null;
}

function runGatewayReset(sessionKey) {
  if (!isRecoverableGroupSession(sessionKey)) return;
  const now = Date.now();
  if (resetInFlight.has(sessionKey)) return;
  if (now - (lastResetAt.get(sessionKey) ?? 0) < RESET_COOLDOWN_MS) return;
  resetInFlight.add(sessionKey);
  lastResetAt.set(sessionKey, now);

  const params = JSON.stringify({ key: sessionKey, reason: "reset" });
  const child = spawn(
    "node",
    [
      "dist/index.js",
      "gateway",
      "call",
      "sessions.reset",
      "--params",
      params,
      "--timeout",
      "15000",
    ],
    {
      cwd: "/app",
      env: {
        ...process.env,
        OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL ?? "ws://openclaw-gateway:18789",
        OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  child.on("close", (code) => {
    resetInFlight.delete(sessionKey);
    if (code === 0) {
      console.log(`[context-recovery] reset session after context overflow: ${sessionKey}`);
    } else {
      console.error(`[context-recovery] session reset failed: ${sessionKey} exit=${code}`);
    }
  });
  child.on("error", (error) => {
    resetInFlight.delete(sessionKey);
    console.error(`[context-recovery] reset process failed: ${sessionKey} ${error.message}`);
  });
}

function handleLine(line) {
  const explicitSessionKey = rememberSessionKey(line);
  const isOverflow =
    /context overflow detected/i.test(line) ||
    /exhausted provider overflow recovery/i.test(line) ||
    /auto-compaction failed.*context overflow/i.test(line);
  const isStalled = /stalled session:.*(?:stalled_agent_run|state=processing)/i.test(line);
  if (!isOverflow && !isStalled) return;
  const sessionKey = explicitSessionKey ?? findRecentPendingSessionKey();
  if (sessionKey) runGatewayReset(sessionKey);
}

function scanLog(file) {
  const stat = fs.statSync(file);
  if (!offsets.has(file)) {
    offsets.set(file, stat.size);
    return;
  }
  const previousOffset = offsets.get(file);
  const start = stat.size >= previousOffset ? previousOffset : 0;
  if (stat.size === start) return;
  const fd = fs.openSync(file, "r");
  try {
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    for (const line of buffer.toString("utf8").split(/\r?\n/)) {
      if (line) handleLine(line);
    }
  } finally {
    fs.closeSync(fd);
  }
  if (stat.size > MAX_LOG_BYTES) {
    // The gateway appends through `tee -a`, which keeps the file open in
    // append mode; truncating while it is open is safe because subsequent
    // writes continue at the new end of file. This caps the named volume so
    // a long-running gateway cannot grow the log without bound. Lines
    // appended between the read above and the truncate are re-processed on
    // the next poll, which is harmless because resets are idempotent and
    // cooldown-gated.
    fs.truncateSync(file, 0);
    offsets.set(file, 0);
  } else {
    offsets.set(file, stat.size);
  }
}

function scanLogs() {
  if (!fs.existsSync(LOG_DIR)) return;
  for (const name of fs.readdirSync(LOG_DIR)) {
    if (!name.endsWith(".log")) continue;
    scanLog(path.join(LOG_DIR, name));
  }
}

console.log("[context-recovery] watching OpenClaw logs for recoverable context overflow");
setInterval(() => {
  try {
    scanLogs();
  } catch (error) {
    console.error(`[context-recovery] log scan failed: ${error.message}`);
  }
}, POLL_MS);
scanLogs();
