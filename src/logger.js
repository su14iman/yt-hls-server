// src/logger.js
"use strict";

const pino = require("pino");

function createLogger({ logLevel }) {
  return pino({
    level: logLevel,
    base: undefined, // drop pid/hostname: noise in a single-process container
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie"],
      remove: true,
    },
  });
}

module.exports = { createLogger };
