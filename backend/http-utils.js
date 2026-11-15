"use strict";

const crypto = require("node:crypto");

/**
 * Escape LIKE/ILIKE wildcards so user input is matched literally.
 * PostgreSQL uses backslash as the default LIKE escape character.
 */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

/** Constant-time string comparison that is safe for unequal lengths. */
function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

/**
 * Bounded pagination. Invalid, missing or oversized values fall back to the
 * default / maximum instead of producing an unbounded query.
 */
function parsePagination(query, { defaultSize = 100, maxSize = 500 } = {}) {
  const rawLimit = Number.parseInt(query?.limit, 10);
  const rawOffset = Number.parseInt(query?.offset, 10);

  let limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : defaultSize;
  limit = Math.min(limit, maxSize);

  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  return { limit, offset };
}

function tooManyRequests(res, retryAfterSec, code, error) {
  res.set?.("Retry-After", String(retryAfterSec));
  return res.status(429).json({ success: false, code, error });
}

/**
 * Write-route guard. Fail-closed, evaluated in this order:
 *  1. token missing/too short      -> 503 (writes disabled, nothing is open)
 *  2. HTTPS required but not proven -> 403 (see proxy.js for how HTTPS is proven)
 *  3. this client is locked out     -> 429 (too many failed attempts)
 *  4. bad/missing bearer token      -> 401 (and the failure is counted)
 * Responses never contain the configured token.
 *
 * isSecure(req) must not trust client-supplied forwarded headers by itself;
 * the default treats every request as non-HTTPS.
 */
function requireWriteAuth({
  token = "",
  configured = false,
  requireHttps = true,
  isSecure = (req) => Boolean(req.secure),
  clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown",
  failLimiter = null,
  globalFailLimiter = null
} = {}) {
  return function writeGuard(req, res, next) {
    if (!configured || !token) {
      return res.status(503).json({
        success: false,
        code: "WRITE_AUTH_UNAVAILABLE",
        error: "Write operations are disabled: server authentication is not configured"
      });
    }

    if (requireHttps && !isSecure(req)) {
      return res.status(403).json({
        success: false,
        code: "HTTPS_REQUIRED",
        error: "Write operations require HTTPS"
      });
    }

    const ip = clientIp(req);
    const locked = failLimiter?.blocked(ip);
    if (locked) {
      return tooManyRequests(res, locked.retryAfterSec, "AUTH_LOCKED_OUT",
        "Too many failed authentication attempts. Try again later.");
    }

    const header = typeof req.get === "function"
      ? req.get("authorization")
      : req.headers?.authorization;
    const match = /^Bearer\s+(\S+)$/i.exec(header || "");

    if (!match || !safeEqual(match[1], token)) {
      const nowLocked = failLimiter?.hit(ip);
      const globalLocked = globalFailLimiter?.hit("global");
      const blocked = nowLocked || globalLocked;
      if (blocked) {
        return tooManyRequests(res, blocked.retryAfterSec, "AUTH_LOCKED_OUT",
          "Too many failed authentication attempts. Try again later.");
      }
      res.set?.("WWW-Authenticate", 'Bearer realm="musicapp-write"');
      return res.status(401).json({
        success: false,
        code: "AUTH_REQUIRED",
        error: "A valid write token is required"
      });
    }

    failLimiter?.reset(ip);
    return next();
  };
}

/**
 * Throttle for authenticated, provider-costly requests (explicit lyrics
 * refresh). Runs after the write guard so unauthenticated callers never
 * consume the budget. Limits: per song, per client, and overall.
 */
function refreshThrottle({ perSong, perClient, overall, clientIp }) {
  return function throttle(req, res, next) {
    const keys = [
      [perSong, `song:${req.params?.id}`],
      [perClient, `ip:${clientIp(req)}`],
      [overall, "all"]
    ];

    for (const [limiter, key] of keys) {
      const blocked = limiter.blocked(key);
      if (blocked) {
        return tooManyRequests(res, blocked.retryAfterSec, "RATE_LIMITED",
          "Lyrics refresh limit reached. Try again later.");
      }
    }

    for (const [limiter, key] of keys) limiter.hit(key);
    return next();
  };
}

/** Run middlewares in order. */
function chain(...middlewares) {
  return function run(req, res, next) {
    let i = 0;
    const step = (err) => {
      if (err) return next(err);
      const mw = middlewares[i++];
      return mw ? mw(req, res, step) : next();
    };
    step();
  };
}

/**
 * CORS options: only configured origins get CORS headers. Requests without
 * an Origin header (same-origin pages, curl) are unaffected. This does not
 * replace authentication.
 */
function buildCorsOptions(origins = []) {
  const allowed = new Set(origins);

  return {
    origin(origin, callback) {
      if (!origin || allowed.has(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["X-Total-Count"],
    maxAge: 600
  };
}

/**
 * Error response body. Internal error text is only included when allowed.
 */
function errorBody(message, error, exposeDetails) {
  const body = { success: false, error: message };

  if (exposeDetails && error && error.message) {
    body.details = error.message;
  }

  return body;
}

/** Final Express error handler: JSON responses, no stack traces. */
function jsonErrorHandler(exposeDetails) {
  // eslint-disable-next-line no-unused-vars
  return function handler(error, req, res, next) {
    const status =
      Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
        ? error.status
        : 500;

    const message =
      status === 400 ? "Invalid request body"
      : status === 413 ? "Request body too large"
      : "Internal server error";

    if (status >= 500) {
      console.error("Unhandled error:", error?.message);
    }

    res.status(status).json(errorBody(message, error, exposeDetails));
  };
}

module.exports = {
  escapeLike,
  safeEqual,
  parsePagination,
  requireWriteAuth,
  refreshThrottle,
  chain,
  buildCorsOptions,
  errorBody,
  jsonErrorHandler
};
