// src/cache.js
// A bounded TTL cache keyed by (url, targetHeight, minHeight).
//
// Caching is what keeps YouTube from rate-limiting the server: IPTV clients
// re-request the same channel constantly, and without this every one of those
// requests spawned a fresh yt-dlp process.

"use strict";

// Signed googlevideo URLs carry their own deadline, either as a path segment
// (/expire/1730000000/) or as a query parameter (?expire=1730000000).
const EXPIRE_RE = /[/?&]expire[/=](\d{10,})/;

/**
 * Derives how long a resolved stream URL stays usable.
 * Falls back to a fixed TTL when the URL carries no deadline.
 */
function ttlFromUrl(url, { cacheTtlMs, cacheMaxTtlMs, cacheExpiryMarginMs }, now = Date.now()) {
  const match = String(url || "").match(EXPIRE_RE);
  if (match) {
    const expiresAt = Number(match[1]) * 1000;
    const remaining = expiresAt - now - cacheExpiryMarginMs;
    if (remaining > 0) return Math.min(remaining, cacheMaxTtlMs);
    return 0; // already expired or inside the safety margin: do not cache
  }
  return Math.min(cacheTtlMs, cacheMaxTtlMs);
}

class TtlCache {
  constructor({ maxEntries = 500, clock = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.clock = clock;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.clock()) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Refresh insertion order so the LRU eviction below stays meaningful.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (!(ttlMs > 0)) return value;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.clock() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    return value;
  }

  // Drops expired entries; called periodically so idle keys do not pin memory.
  prune() {
    const now = this.clock();
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size() {
    return this.map.size;
  }

  stats() {
    return { size: this.map.size, hits: this.hits, misses: this.misses };
  }
}

function cacheKey(url, targetHeight, minHeight) {
  return `${url}|h=${targetHeight || 0}|min=${minHeight || 0}`;
}

module.exports = { TtlCache, ttlFromUrl, cacheKey, EXPIRE_RE };
