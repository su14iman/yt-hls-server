// src/routes.js
"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");

const { HttpError, toHttpError } = require("./errors");
const { validateUrl, parseHeight, m3uAttr, m3uText } = require("./validate");
const { buildMasterPlaylist } = require("./playlist");

// Apple's registered type for a multivariant playlist. The older
// audio/x-mpegurl is kept for the IPTV playlist endpoint, where players expect
// it as a downloadable channel list.
const HLS_TYPE = "application/vnd.apple.mpegurl; charset=utf-8";

function corsMiddleware(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Range");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
}

// Optional shared-secret gate. Accepts `Authorization: Bearer <token>` or
// `?token=` so IPTV players that cannot set headers still work.
function createAuthMiddleware(token) {
  if (!token) return (req, res, next) => next();
  return (req, res, next) => {
    const header = req.get("authorization") || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
    const supplied = bearer || req.query.token;
    if (supplied !== token) return next(new HttpError(401, "unauthorized"));
    return next();
  };
}

function readQuery(req, config) {
  return {
    url: validateUrl(req.query.url, config.allowedHosts),
    targetHeight: parseHeight(req.query.h),
    minHeight: parseHeight(req.query.min) || 0,
    // Only echoed back into a self-referential URL, never compared.
    queryToken: typeof req.query.token === "string" ? req.query.token : null,
    preferUpstream: /^(1|true|yes)$/i.test(String(req.query.upstream || "")),
  };
}

// A demuxed stream cannot be expressed as one upstream URL, so callers that
// want a URL get one pointing back here, at a playlist this server generates.
function selfMasterUrl(req, config, params) {
  const base =
    config.publicBaseUrl || `${req.protocol}://${req.get("host") || `localhost:${config.port}`}`;
  const search = new URLSearchParams({ url: params.url });
  if (params.targetHeight) search.set("h", String(params.targetHeight));
  if (params.minHeight) search.set("min", String(params.minHeight));
  // Carried over only when the caller already used a query token, so the
  // generated URL stays usable without leaking a header-supplied secret.
  if (params.queryToken) search.set("token", params.queryToken);
  return `${base}/master.m3u8?${search.toString()}`;
}

/**
 * The URL to advertise for a resolved stream.
 * - A self-contained rendition is handed out directly.
 * - A demuxed stream points at this server's generated playlist, unless the
 *   caller asked for the upstream multivariant playlist with ?upstream=1
 *   (which plays with audio, but lets the player choose the resolution).
 */
function advertisedUrl(req, config, stream, params) {
  if (stream.kind === "direct") return stream.url;
  if (params.preferUpstream && stream.masterUrl) return stream.masterUrl;
  return selfMasterUrl(req, config, params);
}

function buildRouter({ config, extractor, ytdlp, state }) {
  const router = express.Router();

  // Liveness: no I/O, safe to poll aggressively.
  router.get("/", (req, res) => {
    res.type("text/plain; charset=utf-8").send("OK\n");
  });

  // Readiness and diagnostics. The yt-dlp version lives here because it is the
  // first thing worth knowing when extraction starts failing.
  router.get("/healthz", (req, res) => {
    res.json({
      status: "ok",
      ytdlp: { path: ytdlp.binary, version: state.ytdlpVersion },
      uptimeSeconds: Math.round(process.uptime()),
      ...extractor.stats(),
    });
  });

  const limiter =
    config.rateLimitMax > 0
      ? rateLimit({
          windowMs: config.rateLimitWindowMs,
          limit: config.rateLimitMax,
          standardHeaders: "draft-7",
          legacyHeaders: false,
          message: "too many requests",
        })
      : (req, res, next) => next();

  const guard = [createAuthMiddleware(config.apiToken), limiter];

  const noStore = (res) => res.setHeader("Cache-Control", "no-store");

  router.get("/hls_url", ...guard, async (req, res, next) => {
    try {
      const params = readQuery(req, config);
      const { stream, cached } = await extractor.resolve(params.url, params);
      res.setHeader("X-Cache", cached ? "HIT" : "MISS");
      res
        .type("text/plain; charset=utf-8")
        .send(`${advertisedUrl(req, config, stream, params)}\n`);
    } catch (err) {
      next(err);
    }
  });

  router.get("/hls.json", ...guard, async (req, res, next) => {
    try {
      const params = readQuery(req, config);
      const { stream, cached } = await extractor.resolve(params.url, params);
      res.setHeader("X-Cache", cached ? "HIT" : "MISS");
      res.json({
        url: advertisedUrl(req, config, stream, params),
        source: params.url,
        targetHeight: params.targetHeight,
        minHeight: params.minHeight,
        cached,
        // Whether YouTube served audio and video as separate renditions, and
        // what was actually selected.
        demuxed: stream.kind === "demuxed",
        video: stream.video
          ? {
              formatId: stream.video.format_id,
              height: stream.video.height || null,
              fps: stream.video.fps || null,
              vcodec: stream.video.vcodec || null,
              tbr: stream.video.tbr || null,
            }
          : null,
        audio: stream.audio
          ? { formatId: stream.audio.format_id, note: stream.audio.format_note || null }
          : null,
        upstreamMaster: stream.masterUrl || null,
      });
    } catch (err) {
      next(err);
    }
  });

  // Serves the generated multivariant playlist that pairs the selected video
  // rendition with an audio rendition.
  router.get("/master.m3u8", ...guard, async (req, res, next) => {
    try {
      const params = readQuery(req, config);
      const { stream, cached } = await extractor.resolve(params.url, params);
      res.setHeader("X-Cache", cached ? "HIT" : "MISS");
      noStore(res);

      if (stream.kind === "direct") {
        // Already a playable playlist upstream; nothing to assemble.
        return res.redirect(302, stream.url);
      }
      return res.type(HLS_TYPE).send(buildMasterPlaylist(stream));
    } catch (err) {
      next(err);
    }
  });

  router.get("/playlist.m3u", ...guard, async (req, res, next) => {
    try {
      const params = readQuery(req, config);
      const name = m3uText(req.query.name || "YouTube Live") || "YouTube Live";
      const logo = m3uAttr(req.query.logo || "");
      const group = m3uAttr(req.query.group == null ? "YouTube" : req.query.group);
      const tvgId = m3uAttr(req.query.tvg_id || "");

      const { stream, cached } = await extractor.resolve(params.url, params);

      const attrs = [];
      if (tvgId) attrs.push(`tvg-id="${tvgId}"`);
      if (logo) attrs.push(`tvg-logo="${logo}"`);
      if (group) attrs.push(`group-title="${group}"`);
      const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";

      res.setHeader("X-Cache", cached ? "HIT" : "MISS");
      res
        .type("audio/x-mpegurl; charset=utf-8")
        .send(
          `#EXTM3U\n#EXTINF:-1${attrStr},${name}\n` +
            `${advertisedUrl(req, config, stream, params)}\n`,
        );
    } catch (err) {
      next(err);
    }
  });

  router.get("/redirect.m3u8", ...guard, async (req, res, next) => {
    try {
      const params = readQuery(req, config);
      const { stream, cached } = await extractor.resolve(params.url, params);
      res.setHeader("X-Cache", cached ? "HIT" : "MISS");
      // The signed target expires, so no intermediary may treat it as durable.
      noStore(res);

      if (stream.kind === "direct") {
        // 302, not 301, for the same reason.
        return res.redirect(302, stream.url);
      }
      // A demuxed stream has no single upstream URL to redirect to, so the
      // generated playlist is served inline. The endpoint already ends in
      // .m3u8, so players treat the response the same way either path is taken.
      return res.type(HLS_TYPE).send(buildMasterPlaylist(stream));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function notFoundHandler(req, res) {
  res.status(404).type("text/plain; charset=utf-8").send("not found\n");
}

function createErrorHandler(logger) {
  // Express identifies an error handler by its four-argument shape, so
  // `next` has to stay in the signature even though it is unused.
  return (err, req, res, next) => {
    const httpError = toHttpError(err);
    const level = httpError.status >= 500 ? "error" : "warn";
    logger[level](
      {
        status: httpError.status,
        path: req.originalUrl,
        err: err.message,
        cause: err.cause ? String(err.cause.message || err.cause) : undefined,
      },
      "request failed",
    );
    if (res.headersSent) return;
    res
      .status(httpError.status)
      .type("text/plain; charset=utf-8")
      .send(`${httpError.message}\n`);
  };
}

module.exports = {
  buildRouter,
  corsMiddleware,
  notFoundHandler,
  createErrorHandler,
  advertisedUrl,
  selfMasterUrl,
};
