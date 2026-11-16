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
    // How HTTPS is proven behind a proxy: "none" (default) or "cloudflare".
    // See backend/proxy.js and README. Unknown values fall back to "none".
    proxyMode: env.MUSICAPP_PROXY_MODE === "cloudflare" ? "cloudflare" : "none",
    // Peers allowed to supply forwarded headers: "loopback" and/or exact IPs.
    trustedProxies: (env.MUSICAPP_TRUSTED_PROXIES || "loopback")
      .split(",").map((p) => p.trim()).filter(Boolean),

    // Failed-auth lockout: per client, and a global ceiling.
    authFailMax: positiveInt(env.MUSICAPP_AUTH_FAIL_MAX, 10),
    authFailWindowMs: positiveInt(env.MUSICAPP_AUTH_FAIL_WINDOW_SEC, 900) * 1000,
    authFailGlobalMax: positiveInt(env.MUSICAPP_AUTH_FAIL_GLOBAL_MAX, 200),

    // Explicit lyrics refresh (?refresh=1) budgets.
    refreshSongCooldownMs: positiveInt(env.MUSICAPP_REFRESH_SONG_COOLDOWN_SEC, 300) * 1000,
    refreshPerClientHour: positiveInt(env.MUSICAPP_REFRESH_PER_CLIENT_HOUR, 20),
    refreshOverallHour: positiveInt(env.MUSICAPP_REFRESH_OVERALL_HOUR, 60),

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
