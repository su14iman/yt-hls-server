// index.js
// Entry point: wires configuration, logging, the yt-dlp runner and the HTTP
// server together, then shuts all of it down cleanly on a signal.
//
// Endpoints:
//   GET /                 liveness probe
//   GET /healthz          readiness + yt-dlp version + cache/queue stats
//   GET /hls_url          resolved manifest URL as text/plain
//   GET /hls.json         resolved manifest URL as JSON
//   GET /playlist.m3u     single-entry M3U playlist
//   GET /redirect.m3u8    302 to the resolved manifest
//
// Example:
//   curl "http://localhost:8000/redirect.m3u8?url=https://www.youtube.com/@AlekhbariahSY/live&h=1080&min=720"

"use strict";

const { load } = require("./src/config");
const { createLogger } = require("./src/logger");
const { createYtdlp } = require("./src/ytdlp");
const { createExtractor } = require("./src/extractor");
const { createApp } = require("./src/app");

async function main() {
  const config = load();
  const logger = createLogger(config);
  const ytdlp = createYtdlp(config, logger);
  const state = { ytdlpVersion: null };

  if (config.ytdlpAutoUpdate) {
    logger.info("YTDLP_AUTO_UPDATE is set, checking for a newer yt-dlp");
    await ytdlp.selfUpdate();
  }

  state.ytdlpVersion = await ytdlp.version();
  if (!state.ytdlpVersion) {
    // Not fatal: the binary may appear later via a mounted volume, and the
    // per-request error mapping reports a missing binary as a 500.
    logger.error(
      { binary: ytdlp.binary },
      "yt-dlp is not runnable - extraction requests will fail",
    );
  } else {
    logger.info({ binary: ytdlp.binary, version: state.ytdlpVersion }, "yt-dlp ready");
  }

  const extractor = createExtractor({ config, logger, ytdlp });
  const app = createApp({ config, logger, extractor, ytdlp, state });

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, allowedHosts: config.allowedHosts },
      "server listening",
    );
  });

  // Stop accepting new sockets, let in-flight requests drain, then force-exit
  // if something refuses to let go.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const force = setTimeout(() => {
      logger.warn("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, config.shutdownTimeoutMs);
    force.unref();

    server.close((err) => {
      extractor.close();
      if (err) {
        logger.error({ err: err.message }, "error while closing server");
        process.exit(1);
      }
      logger.info("shutdown complete");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason: String(reason) }, "unhandled rejection");
  });
}

main().catch((err) => {
  // No logger guaranteed at this point.
  console.error("failed to start:", err && err.stack ? err.stack : err);
  process.exit(1);
});
