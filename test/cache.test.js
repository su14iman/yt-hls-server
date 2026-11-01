import { describe, expect, it } from "vitest";
import cacheModule from "../src/cache.js";
import configModule from "../src/config.js";

const { TtlCache, ttlFromUrl, cacheKey } = cacheModule;
const config = configModule.load({});

describe("ttlFromUrl", () => {
  const now = 1_700_000_000_000;

  it("derives the ttl from an expire path segment", () => {
    const expire = Math.floor(now / 1000) + 3600; // one hour out
    const url = `https://manifest.googlevideo.com/api/manifest/hls_variant/expire/${expire}/file/index.m3u8`;
    const ttl = ttlFromUrl(url, config, now);
    // One hour minus the 60s safety margin.
    expect(ttl).toBe(3600_000 - config.cacheExpiryMarginMs);
  });

  it("derives the ttl from an expire query parameter", () => {
    const expire = Math.floor(now / 1000) + 1800;
    const url = `https://example.googlevideo.com/playlist.m3u8?itag=96&expire=${expire}&sig=x`;
    expect(ttlFromUrl(url, config, now)).toBe(1800_000 - config.cacheExpiryMarginMs);
  });

  it("refuses to cache a url that already expired", () => {
    const expire = Math.floor(now / 1000) - 10;
    const url = `https://x/expire/${expire}/index.m3u8`;
    expect(ttlFromUrl(url, config, now)).toBe(0);
  });

  it("refuses to cache a url expiring inside the safety margin", () => {
    const expire = Math.floor(now / 1000) + 30; // margin is 60s
    const url = `https://x/expire/${expire}/index.m3u8`;
    expect(ttlFromUrl(url, config, now)).toBe(0);
  });

  it("caps a very distant expiry", () => {
    const expire = Math.floor(now / 1000) + 30 * 24 * 3600;
    const url = `https://x/expire/${expire}/index.m3u8`;
    expect(ttlFromUrl(url, config, now)).toBe(config.cacheMaxTtlMs);
  });

  it("falls back to the configured ttl when no expiry is present", () => {
    expect(ttlFromUrl("https://example.com/index.m3u8", config, now)).toBe(config.cacheTtlMs);
  });
});

describe("TtlCache", () => {
  const withClock = (maxEntries = 10) => {
    let t = 1000;
    const cache = new TtlCache({ maxEntries, clock: () => t });
    return { cache, advance: (ms) => (t += ms) };
  };

  it("returns a value before it expires and not after", () => {
    const { cache, advance } = withClock();
    cache.set("k", "v", 100);
    expect(cache.get("k")).toBe("v");
    advance(99);
    expect(cache.get("k")).toBe("v");
    advance(2);
    expect(cache.get("k")).toBeUndefined();
  });

  it("ignores a non-positive ttl", () => {
    const { cache } = withClock();
    cache.set("k", "v", 0);
    cache.set("j", "v", -5);
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry past the limit", () => {
    const { cache } = withClock(2);
    cache.set("a", 1, 10_000);
    cache.set("b", 2, 10_000);
    cache.get("a"); // "a" becomes most recent
    cache.set("c", 3, 10_000);
    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("prunes expired entries", () => {
    const { cache, advance } = withClock();
    cache.set("a", 1, 50);
    cache.set("b", 2, 5000);
    advance(100);
    expect(cache.prune()).toBe(1);
    expect(cache.size).toBe(1);
  });

  it("counts hits and misses", () => {
    const { cache } = withClock();
    cache.set("a", 1, 5000);
    cache.get("a");
    cache.get("nope");
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });
});

describe("cacheKey", () => {
  it("separates different quality requests for the same url", () => {
    const url = "https://www.youtube.com/@x/live";
    expect(cacheKey(url, 720, 0)).not.toBe(cacheKey(url, 1080, 0));
    expect(cacheKey(url, 720, 0)).not.toBe(cacheKey(url, 720, 480));
    expect(cacheKey(url, 720, 480)).toBe(cacheKey(url, 720, 480));
  });

  it("treats absent heights as zero", () => {
    const url = "https://www.youtube.com/@x/live";
    expect(cacheKey(url, null, 0)).toBe(cacheKey(url, 0, 0));
  });
});
