"use strict";
const { ProviderError } = require("./errors");

// Shared HTTP layer for metadata providers: serialized requests with a minimum interval,
// per-request timeout, bounded retries with backoff, TTL cache, injectable fetch/clock.
// Credentials (if any) are passed in headers/params by the adapter and are never logged or put in errors.
const shared = new Map();
function createHttpProvider(opts) {
  const o = {
    name: "provider", baseUrl: "", userAgent: "", minIntervalMs: 1100, timeoutMs: 8000,
    maxRetries: 2, backoffMs: 500, maxBackoffMs: 5000, cacheTtlMs: 24 * 3600 * 1000, cacheMax: 500,
    fetch: globalThis.fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(),
    headers: {}, maxRequests: 100, isolate: false, ...opts
  };
  if (!o.baseUrl.startsWith("https://")) throw new ProviderError("config", `${o.name}: baseUrl must be https`, { provider: o.name });
  if (!o.userAgent) throw new ProviderError("config", `${o.name}: a descriptive User-Agent is required`, { provider: o.name });
  if (typeof o.fetch !== "function") throw new ProviderError("config", `${o.name}: no fetch available`, { provider: o.name });

  const cache = new Map();
  // One limiter per host for the whole process, so several provider instances (or concurrent callers)
  // can never exceed the host's rate limit together. `isolate` gives tests a private limiter.
  const host = new URL(o.baseUrl).host;
  const lim = o.isolate ? { chain: Promise.resolve(), lastStart: -Infinity } : (shared.get(host) || (shared.set(host, { chain: Promise.resolve(), lastStart: -Infinity }), shared.get(host)));
  const stats = { requests: 0, cacheHits: 0, retries: 0, failures: 0 };

  function schedule(task) {
    const run = lim.chain.then(task, task);
    lim.chain = run.catch(() => {});
    return run;
  }

  async function once(url) {
    if (stats.requests >= o.maxRequests) throw new ProviderError("budget", `${o.name}: request budget exhausted (${o.maxRequests})`, { provider: o.name });
    const wait = lim.lastStart + o.minIntervalMs - o.now();
    if (wait > 0) await o.sleep(wait);
    lim.lastStart = o.now();
    stats.requests += 1;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
    let res;
    try {
      res = await o.fetch(url, { signal: ctrl.signal, headers: { "User-Agent": o.userAgent, Accept: "application/json", ...o.headers } });
    } catch (e) {
      if (e && e.name === "AbortError") throw new ProviderError("timeout", `${o.name}: request timed out`, { provider: o.name, retryable: true });
      throw new ProviderError("unavailable", `${o.name}: network error`, { provider: o.name, retryable: true });
    } finally { clearTimeout(timer); }
    const status = res.status;
    if (status === 401 || status === 403) throw new ProviderError("unauthorized", `${o.name}: access refused (${status})`, { provider: o.name, status });
    if (status === 404) throw new ProviderError("not_found", `${o.name}: not found`, { provider: o.name, status });
    if (status === 429 || status === 503) {
      const ra = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
      throw new ProviderError("rate_limited", `${o.name}: rate limited or busy (${status})`, {
        provider: o.name, status, retryable: true, retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : null });
    }
    if (status >= 500) throw new ProviderError("unavailable", `${o.name}: upstream error (${status})`, { provider: o.name, status, retryable: true });
    if (status < 200 || status >= 300) throw new ProviderError("unavailable", `${o.name}: unexpected status ${status}`, { provider: o.name, status });
    let text;
    try { text = await res.text(); } catch { throw new ProviderError("malformed", `${o.name}: unreadable body`, { provider: o.name }); }
    if (text.length > 2_000_000) throw new ProviderError("malformed", `${o.name}: response too large`, { provider: o.name });
    try { return JSON.parse(text); } catch { throw new ProviderError("malformed", `${o.name}: response is not valid JSON`, { provider: o.name }); }
  }

  async function getJson(path, params = {}) {
    const url = new URL(path.replace(/^\//, ""), o.baseUrl.endsWith("/") ? o.baseUrl : o.baseUrl + "/");
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const key = url.toString();
    const hit = cache.get(key);
    if (hit && hit.exp > o.now()) { stats.cacheHits += 1; return hit.value; }
    return schedule(async () => {
      const again = cache.get(key); // an identical request queued ahead of us may have filled the cache
      if (again && again.exp > o.now()) { stats.cacheHits += 1; return again.value; }
      let attempt = 0;
      for (;;) {
        try {
          const value = await once(key);
          if (cache.size >= o.cacheMax) cache.delete(cache.keys().next().value);
          cache.set(key, { value, exp: o.now() + o.cacheTtlMs });
          return value;
        } catch (e) {
          if (!(e instanceof ProviderError) || !e.retryable || attempt >= o.maxRetries) { stats.failures += 1; throw e; }
          attempt += 1; stats.retries += 1;
          await o.sleep(e.retryAfterMs ?? Math.min(o.backoffMs * 2 ** (attempt - 1), o.maxBackoffMs));
        }
      }
    });
  }
  return { name: o.name, getJson, stats, _cache: cache };
}
module.exports = { createHttpProvider };
