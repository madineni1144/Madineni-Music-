"use strict";

/**
 * Small in-memory fixed-window limiter with a hard cap on tracked keys, so an
 * attacker rotating addresses cannot grow memory without bound. State is per
 * process and resets on restart (acceptable for lockout/throttle purposes).
 */
function createRateLimiter({ windowMs, max, maxKeys = 5000, now = Date.now }) {
  const entries = new Map(); // key -> { count, resetAt }

  function live(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.resetAt <= now()) { entries.delete(key); return null; }
    return entry;
  }

  function makeRoom() {
    if (entries.size < maxKeys) return;
    const t = now();
    for (const [key, entry] of entries) if (entry.resetAt <= t) entries.delete(key);
    while (entries.size >= maxKeys) entries.delete(entries.keys().next().value); // oldest first
  }

  return {
    /** Is this key currently over the limit? Does not count. */
    blocked(key) {
      const entry = live(key);
      return entry && entry.count >= max
        ? { retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now()) / 1000)) }
        : null;
    },
    /** Count one event. Returns the blocked state *after* counting. */
    hit(key) {
      let entry = live(key);
      if (!entry) {
        makeRoom();
        entry = { count: 0, resetAt: now() + windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      return this.blocked(key);
    },
    reset(key) { entries.delete(key); },
    get size() { return entries.size; }
  };
}

module.exports = { createRateLimiter };
