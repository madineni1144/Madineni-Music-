"use strict";
// Typed provider errors. `retryable` drives the bounded-retry loop; messages never contain credentials.
class ProviderError extends Error {
  constructor(code, message, { provider = "unknown", status = null, retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code; // timeout | rate_limited | unavailable | malformed | not_found | unauthorized | disabled | config | budget
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}
module.exports = { ProviderError };
