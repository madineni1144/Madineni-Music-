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
 * Express middleware guarding write endpoints.
 *
 * - token set      -> requests must send "Authorization: Bearer <token>".
 * - token not set  -> requests pass through (current behaviour), so existing
 *                     deployments keep working until a token is configured.
 */
function requireWriteAuth(token) {
  const configured = typeof token === "string" ? token.trim() : "";

  return function writeGuard(req, res, next) {
    if (!configured) {
      return next();
    }

    const header = req.get ? req.get("authorization") : req.headers?.authorization;
    const match = /^Bearer\s+(.+)$/i.exec(header || "");

    if (!match || !safeEqual(match[1].trim(), configured)) {
      return res.status(401).json({
        success: false,
        error: "Authentication required"
      });
    }

    return next();
  };
}

/**
 * Build an error response body. Internal error text is only included
 * when explicitly allowed (development), never in production.
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
  requireWriteAuth,
  errorBody,
  jsonErrorHandler
};
