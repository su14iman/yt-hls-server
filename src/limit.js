// src/limit.js
// Two independent guards around the extractor:
//   - singleFlight collapses identical concurrent work onto one promise
//   - Semaphore caps how many yt-dlp processes may run at once

"use strict";

const { HttpError } = require("./errors");

function createSingleFlight() {
  const inflight = new Map();

  function run(key, fn) {
    const existing = inflight.get(key);
    if (existing) return existing;

    // fn() may throw synchronously; Promise.resolve().then keeps that on the
    // promise path so the map entry is always cleaned up.
    const promise = Promise.resolve()
      .then(fn)
      .finally(() => inflight.delete(key));

    inflight.set(key, promise);
    return promise;
  }

  run.size = () => inflight.size;
  return run;
}

class Semaphore {
  constructor({ concurrency = 3, queueLimit = 50 } = {}) {
    this.concurrency = concurrency;
    this.queueLimit = queueLimit;
    this.active = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.active >= this.concurrency) {
      if (this.queue.length >= this.queueLimit) {
        throw new HttpError(503, "server busy, try again shortly");
      }
      await new Promise((resolve) => this.queue.push(resolve));
    }

    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  stats() {
    return { active: this.active, queued: this.queue.length };
  }
}

module.exports = { createSingleFlight, Semaphore };
