// src/errors.js
// Maps raw yt-dlp / spawn failures onto HTTP status codes.
// The raw text never reaches the client: it carries the full command line,
// internal paths and sometimes cookie values.

"use strict";

class HttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.expose = true;
    if (options.cause) this.cause = options.cause;
  }
}

// Ordered most specific first; the first match wins.
const PATTERNS = [
  {
    status: 429,
    test: /Sign in to confirm|confirm you.{0,3}re not a bot|too many requests|HTTP Error 429/i,
    message: "blocked by YouTube - cookies or a proxy are required",
  },
  {
    status: 404,
    test: /is not currently live|does not have a live stream|no longer live/i,
    message: "channel is not live right now",
  },
  {
    // Checked before the generic "unavailable" rule below, because YouTube
    // phrases a geo block as "Video unavailable. ... blocked it in your
    // country", which would otherwise be reported as a plain 404.
    status: 451,
    test: /available in your country|blocked it in your country|not available from your location|geo.?restrict/i,
    message: "stream is geo-blocked for this server",
  },
  {
    status: 404,
    test: /Private video|members-only|This video is unavailable|Video unavailable|has been removed/i,
    message: "stream is private or unavailable",
  },
  {
    status: 404,
    test: /Unable to download API page|HTTP Error 404|Not Found|Unable to recognize tab page|does not exist/i,
    message: "channel or video not found",
  },
  {
    status: 401,
    test: /requires authentication|login required|Use --cookies/i,
    message: "stream requires authentication",
  },
];

function toHttpError(err) {
  if (err instanceof HttpError) return err;

  // Timeout: execFile sets `killed` once it sends killSignal.
  if (err && (err.killed || err.signal === "SIGKILL" || err.code === "ETIMEDOUT")) {
    return new HttpError(504, "extraction timed out", { cause: err });
  }

  if (err && err.code === "ENOENT") {
    return new HttpError(500, "yt-dlp binary not found on this server", { cause: err });
  }

  const haystack = [err && err.stderr, err && err.stdout, err && err.message]
    .filter(Boolean)
    .join("\n");

  for (const { status, test, message } of PATTERNS) {
    if (test.test(haystack)) return new HttpError(status, message, { cause: err });
  }

  if (err instanceof SyntaxError) {
    return new HttpError(502, "yt-dlp returned malformed output", { cause: err });
  }

  return new HttpError(502, "extraction failed", { cause: err });
}

module.exports = { HttpError, toHttpError };
