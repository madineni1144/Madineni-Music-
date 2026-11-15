"use strict";

const MIN_WRITE_TOKEN_LENGTH = 32;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read runtime configuration from an environment object.
 * Defaults match the existing Ubuntu deployment.
 *
 * Authentication is fail-closed: a missing or too-short MUSICAPP_WRITE_TOKEN
 * leaves writeAuthConfigured=false and every write route answers 503.
 */
function loadConfig(env = process.env) {
  const token = typeof env.MUSICAPP_WRITE_TOKEN === "string"
    ? env.MUSICAPP_WRITE_TOKEN.trim()
    : "";

  const production = env.NODE_ENV === "production";
  const maxPageSize = positiveInt(env.MUSICAPP_MAX_PAGE_SIZE, 500);
  const defaultPageSize = Math.min(
    positiveInt(env.MUSICAPP_DEFAULT_PAGE_SIZE, 100),
    maxPageSize
  );

  return {
    port: positiveInt(env.PORT, 3000),
    frontendDir: env.FRONTEND_DIR || "/opt/musicapp/app/frontend",
    musicDir: env.MUSIC_DIR || "/opt/musicapp/music/Songs",
    coversDir: env.COVERS_DIR || "/opt/musicapp/covers",

    writeToken: token,
    writeAuthConfigured: token.length >= MIN_WRITE_TOKEN_LENGTH,
    writeTokenTooShort: token.length > 0 && token.length < MIN_WRITE_TOKEN_LENGTH,
    // Writes must arrive over HTTPS unless explicitly relaxed (LAN/dev only).
    requireHttps: env.MUSICAPP_REQUIRE_HTTPS !== "false",
    // Express "trust proxy" value so req.secure honours X-Forwarded-Proto
    // from the local Cloudflare tunnel. Set to "false" to disable.
    trustProxy: env.MUSICAPP_TRUST_PROXY || "loopback",

    // Empty list => no cross-origin access (same-origin only).
    corsOrigins: (env.CORS_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),

    maxPageSize,
    defaultPageSize,

    // Internal error text reaches clients only outside production.
    exposeErrorDetails: !production && env.EXPOSE_ERROR_DETAILS === "true"
  };
}

module.exports = { loadConfig, MIN_WRITE_TOKEN_LENGTH };
