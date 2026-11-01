// src/config.js
// All runtime configuration is read from the environment exactly once, at startup.

"use strict";

const DEFAULT_ALLOWED_HOSTS = [
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "music.youtube.com",
];

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function list(value, fallback) {
  if (value === undefined) return fallback;
  const items = String(value)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // An explicit empty value disables host filtering altogether.
  return items;
}

function load(env = process.env) {
  return {
    port: num(env.PORT, 8000),
    logLevel: env.LOG_LEVEL || "info",

    // yt-dlp
    ytdlpPath: env.YTDLP_PATH || null, // resolved lazily, see src/ytdlp.js
    ytdlpTimeoutMs: num(env.YTDLP_TIMEOUT_MS, 25000),
    ytdlpConcurrency: Math.max(1, num(env.YTDLP_CONCURRENCY, 3)),
    ytdlpQueueLimit: Math.max(1, num(env.YTDLP_QUEUE_LIMIT, 50)),
    ytdlpAutoUpdate: bool(env.YTDLP_AUTO_UPDATE, false),
    ytdlpCookies: env.YTDLP_COOKIES || null,
    ytdlpProxy: env.YTDLP_PROXY || null,
    ytdlpExtractorArgs: env.YTDLP_EXTRACTOR_ARGS || null,
    ytdlpSocketTimeout: num(env.YTDLP_SOCKET_TIMEOUT, 15),
    ytdlpRetries: num(env.YTDLP_RETRIES, 2),

    // Input policy
    allowedHosts: list(env.ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS),

    // Cache
    cacheTtlMs: num(env.CACHE_TTL_MS, 240000),
    cacheMaxTtlMs: num(env.CACHE_MAX_TTL_MS, 3 * 3600 * 1000),
    cacheExpiryMarginMs: num(env.CACHE_EXPIRY_MARGIN_MS, 60000),
    cacheMaxEntries: Math.max(1, num(env.CACHE_MAX_ENTRIES, 500)),

    // Rate limiting
    rateLimitWindowMs: num(env.RATE_LIMIT_WINDOW_MS, 60000),
    rateLimitMax: num(env.RATE_LIMIT_MAX, 60), // 0 disables the limiter
    trustProxy: bool(env.TRUST_PROXY, false),

    // Optional shared-secret auth; unset means the API is open.
    apiToken: env.API_TOKEN || null,

    // Used when the server has to hand out a URL pointing back at itself (a
    // demuxed stream is served as a generated playlist). Derived from the
    // request when unset, which is correct unless a proxy rewrites the host.
    publicBaseUrl: env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/+$/, "") : null,

    shutdownTimeoutMs: num(env.SHUTDOWN_TIMEOUT_MS, 10000),
  };
}

module.exports = { load, DEFAULT_ALLOWED_HOSTS };
