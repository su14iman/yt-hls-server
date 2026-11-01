// src/extractor.js
// Composes the guards around a yt-dlp call:
//   cache -> single-flight -> concurrency semaphore -> yt-dlp -> track selection
//
// What is cached is the selected *stream descriptor*, not a single URL, because
// a demuxed stream needs both a video and an audio rendition.

"use strict";

const { TtlCache, ttlFromUrl, cacheKey } = require("./cache");
const { createSingleFlight, Semaphore } = require("./limit");
const { selectStream } = require("./select");
const { toHttpError } = require("./errors");

// The descriptor holds several signed URLs; the entry must retire when the
// earliest of them does.
function descriptorTtl(descriptor, config) {
  const urls = [
    descriptor.url,
    descriptor.video && descriptor.video.url,
    descriptor.audio && descriptor.audio.url,
  ].filter(Boolean);

  if (!urls.length) return 0;
  return Math.min(...urls.map((url) => ttlFromUrl(url, config)));
}

function createExtractor({ config, logger, ytdlp }) {
  const cache = new TtlCache({ maxEntries: config.cacheMaxEntries });
  const singleFlight = createSingleFlight();
  const semaphore = new Semaphore({
    concurrency: config.ytdlpConcurrency,
    queueLimit: config.ytdlpQueueLimit,
  });

  const pruneTimer = setInterval(() => {
    const removed = cache.prune();
    if (removed) logger.debug({ removed }, "pruned expired cache entries");
  }, 60000);
  pruneTimer.unref(); // never hold the event loop open

  async function resolve(url, { targetHeight = null, minHeight = 0 } = {}) {
    const key = cacheKey(url, targetHeight, minHeight);

    const cached = cache.get(key);
    if (cached) {
      logger.debug({ url }, "cache hit");
      return { stream: cached, cached: true };
    }

    const stream = await singleFlight(key, async () => {
      // Re-check inside the single-flight: a request that queued behind an
      // identical one may find the result already populated.
      const fresh = cache.get(key);
      if (fresh) return fresh;

      return semaphore.run(async () => {
        let info;
        try {
          info = await ytdlp.dumpJson(url);
        } catch (err) {
          // Log the raw failure, hand the client a sanitised one.
          logger.warn(
            { url, stderr: err.stderr || err.message, code: err.code },
            "yt-dlp failed",
          );
          throw toHttpError(err);
        }

        const descriptor = selectStream(info, { targetHeight, minHeight });
        const ttl = descriptorTtl(descriptor, config);
        if (ttl > 0) cache.set(key, descriptor, ttl);
        logger.info(
          {
            url,
            kind: descriptor.kind,
            videoHeight: descriptor.video ? descriptor.video.height : undefined,
            audioFormat: descriptor.audio ? descriptor.audio.format_id : undefined,
            ttlMs: ttl,
          },
          "resolved stream",
        );
        return descriptor;
      });
    });

    return { stream, cached: false };
  }

  function stats() {
    return {
      cache: cache.stats(),
      queue: semaphore.stats(),
      inflight: singleFlight.size(),
    };
  }

  function close() {
    clearInterval(pruneTimer);
  }

  return { resolve, stats, close };
}

module.exports = { createExtractor, descriptorTtl };
