export function extractSessionKey(line) {
  return line.match(/sessionKey=(agent:[A-Za-z0-9._:-]+)/)?.[1] ?? null;
}

export function isRecoverableGroupSession(sessionKey) {
  return /^agent:[^:]+:qqbot:group:[A-Za-z0-9._-]+$/i.test(String(sessionKey ?? ""));
}

export class RecoveryState {
  constructor({ now = () => Date.now(), pendingTtlMs = 30_000, resetCooldownMs = 60_000 } = {}) {
    this.now = now;
    this.pendingTtlMs = pendingTtlMs;
    this.resetCooldownMs = resetCooldownMs;
    this.pendingSessionKeys = new Map();
    this.lastResetAt = new Map();
    this.resetInFlight = new Set();
  }

  rememberSessionKey(line, at = this.now()) {
    const sessionKey = extractSessionKey(line);
    if (sessionKey && /context-overflow-(precheck|diag)/i.test(line)) this.pendingSessionKeys.set(sessionKey, at);
    return sessionKey;
  }

  findRecentPendingSessionKey(at = this.now()) {
    for (const [sessionKey, seenAt] of this.pendingSessionKeys) {
      if (at - seenAt > this.pendingTtlMs) this.pendingSessionKeys.delete(sessionKey);
    }
    return [...this.pendingSessionKeys.entries()]
      .sort((left, right) => right[1] - left[1])
      .find(([sessionKey]) => isRecoverableGroupSession(sessionKey))?.[0] ?? null;
  }

  claimReset(sessionKey, at = this.now()) {
    if (!isRecoverableGroupSession(sessionKey)) return null;
    if (this.resetInFlight.has(sessionKey)) return null;
    if (at - (this.lastResetAt.get(sessionKey) ?? 0) < this.resetCooldownMs) return null;
    this.resetInFlight.add(sessionKey);
    this.lastResetAt.set(sessionKey, at);
    return sessionKey;
  }

  completeReset(sessionKey) {
    this.resetInFlight.delete(sessionKey);
  }

  handleLine(line, at = this.now()) {
    const explicitSessionKey = this.rememberSessionKey(line, at);
    const isOverflow = /context overflow detected/i.test(line) || /exhausted provider overflow recovery/i.test(line) || /auto-compaction failed.*context overflow/i.test(line);
    const isStalled = /stalled session:.*(?:stalled_agent_run|state=processing)/i.test(line);
    if (!isOverflow && !isStalled) return null;
    return this.claimReset(explicitSessionKey ?? this.findRecentPendingSessionKey(at), at);
  }
}
