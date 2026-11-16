"use strict";

const net = require("node:net");

/**
 * Request-origin helpers. Forwarded headers are attacker-controlled unless the
 * TCP peer is a proxy we trust, so Express's "trust proxy" is NOT used.
 *
 * Modes (MUSICAPP_PROXY_MODE):
 *   none        (default) forwarded headers are ignored; a request counts as
 *               HTTPS only if TLS terminates in this process.
 *   cloudflare  only when the TCP peer is in the trusted-proxy list (default:
 *               loopback, where cloudflared connects) AND
 *                 - the RIGHTMOST X-Forwarded-Proto value is "https", AND
 *                 - the CF-Visitor header says scheme "https".
 *               Using the rightmost value means a client-supplied
 *               "X-Forwarded-Proto: https" that an upstream hop appended
 *               "http" to is still treated as HTTP.
 */

function normalizeIp(address) {
  if (typeof address !== "string") return "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1] : address;
}

function isLoopback(address) {
  const ip = normalizeIp(address);
  return ip === "::1" || /^127\.\d+\.\d+\.\d+$/.test(ip);
}

function createProxyTrust({ mode = "none", trustedProxies = ["loopback"] } = {}) {
  const exact = new Set(trustedProxies.filter((p) => p !== "loopback").map(normalizeIp));
  const trustLoopback = trustedProxies.includes("loopback");

  function peer(req) {
    return normalizeIp(req.socket?.remoteAddress || "");
  }

  function isTrustedPeer(req) {
    const ip = peer(req);
    return (trustLoopback && isLoopback(ip)) || exact.has(ip);
  }

  function header(req, name) {
    const value = typeof req.get === "function" ? req.get(name) : req.headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value.join(",") : value;
  }

  function isSecure(req) {
    if (req.socket?.encrypted) return true;
    if (mode !== "cloudflare" || !isTrustedPeer(req)) return false;

    const protoParts = String(header(req, "x-forwarded-proto") || "")
      .split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (protoParts.at(-1) !== "https") return false;

    try {
      const visitor = JSON.parse(header(req, "cf-visitor") || "");
      return typeof visitor?.scheme === "string" && visitor.scheme.toLowerCase() === "https";
    } catch {
      return false;
    }
  }

  /** Address used as the rate-limit key. */
  function clientIp(req) {
    if (mode === "cloudflare" && isTrustedPeer(req)) {
      const forwarded = String(header(req, "cf-connecting-ip") || "").trim();
      if (net.isIP(forwarded)) return normalizeIp(forwarded);
    }
    return peer(req) || "unknown";
  }

  return { isSecure, clientIp, isTrustedPeer };
}

module.exports = { createProxyTrust, normalizeIp, isLoopback };
