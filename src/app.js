// src/app.js
// Builds the Express app. Kept separate from index.js so tests can mount the
// app without binding a port or touching a real yt-dlp binary.

"use strict";

const express = require("express");
const pinoHttp = require("pino-http");

const {
  buildRouter,
  corsMiddleware,
  notFoundHandler,
  createErrorHandler,
} = require("./routes");

function createApp({ config, logger, extractor, ytdlp, state }) {
  const app = express();

  app.disable("x-powered-by");
  // Only honour X-Forwarded-For when explicitly told to: otherwise any client
  // could spoof its IP and bypass the rate limiter.
  if (config.trustProxy) app.set("trust proxy", true);

  app.use(
    pinoHttp({
      logger,
      // Health polling every few seconds would otherwise dominate the log.
      autoLogging: { ignore: (req) => req.url === "/" },
      // The default serializers dump every request and response header on
      // every line, which buries the useful fields.
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
    }),
  );

  app.use(corsMiddleware);
  app.use(buildRouter({ config, extractor, ytdlp, state }));
  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}

module.exports = { createApp };
