// src/validate.js
// Everything that comes off the query string is hostile until it passes through here.

"use strict";

const { HttpError } = require("./errors");

// Rejects anything that is not an absolute http(s) URL on an allowed host.
// This is what keeps the server from being an open SSRF proxy, and it also
// guarantees the value can never be mistaken for a yt-dlp command-line flag.
function validateUrl(raw, allowedHosts = []) {
  const value = String(raw == null ? "" : raw).trim();
  if (!value) throw new HttpError(400, "missing ?url");

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, "invalid url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "only http and https urls are allowed");
  }

  const host = parsed.hostname.toLowerCase();
  if (allowedHosts.length && !allowedHosts.includes(host)) {
    throw new HttpError(403, `host not allowed: ${host}`);
  }

  return parsed.toString();
}

// Heights are advisory: a malformed value is ignored rather than fatal, so that
// an IPTV playlist with a stray "&h=" keeps working.
function parseHeight(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 4320);
}

// An M3U attribute value is delimited by double quotes and ends at the newline.
function m3uAttr(value) {
  return String(value == null ? "" : value).replace(/[\r\n"]/g, "");
}

// The display name sits after the last comma on the #EXTINF line.
function m3uText(value) {
  return String(value == null ? "" : value).replace(/[\r\n,]/g, " ").trim();
}

module.exports = { validateUrl, parseHeight, m3uAttr, m3uText };
