import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { RecoveryState } from "./context-recovery-core.mjs";

const LOG_DIR = "/tmp/openclaw";
const POLL_MS = 1000;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const recoveryState = new RecoveryState();
const offsets = new Map();

function runGatewayReset(sessionKey) {
  const params = JSON.stringify({ key: sessionKey, reason: "reset" });
  const child = spawn(
    "node",
    ["dist/index.js", "gateway", "call", "sessions.reset", "--params", params, "--timeout", "15000"],
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
    recoveryState.completeReset(sessionKey);
    if (code === 0) console.log(`[context-recovery] reset session after recoverable failure: ${sessionKey}`);
    else console.error(`[context-recovery] session reset failed: ${sessionKey} exit=${code}`);
  });
  child.on("error", (error) => {
    recoveryState.completeReset(sessionKey);
    console.error(`[context-recovery] reset process failed: ${sessionKey} ${error.message}`);
  });
}

function scanLog(file) {
  const stat = fs.statSync(file);
  if (!offsets.has(file)) {
    offsets.set(file, stat.size);
    return;
  }
  const previousOffset = offsets.get(file);
  const start = stat.size >= previousOffset ? previousOffset : 0;
  if (stat.size !== start) {
    const fd = fs.openSync(file, "r");
    try {
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      for (const line of buffer.toString("utf8").split(/\r?\n/)) {
        if (!line) continue;
        const sessionKey = recoveryState.handleLine(line);
        if (sessionKey) runGatewayReset(sessionKey);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  if (stat.size > MAX_LOG_BYTES) {
    fs.truncateSync(file, 0);
    offsets.set(file, 0);
  } else {
    offsets.set(file, stat.size);
  }
}

function scanLogs() {
  if (!fs.existsSync(LOG_DIR)) return;
  for (const name of fs.readdirSync(LOG_DIR)) {
    if (name.endsWith(".log")) scanLog(path.join(LOG_DIR, name));
  }
}

console.log("[context-recovery] watching OpenClaw logs for recoverable context overflow and stalled group runs");
setInterval(() => {
  try {
    scanLogs();
  } catch (error) {
    console.error(`[context-recovery] log scan failed: ${error.message}`);
  }
}, POLL_MS);
scanLogs();
