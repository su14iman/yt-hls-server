// src/select.js
// Pure format-selection logic: takes a parsed yt-dlp JSON object, returns a
// descriptor of what to serve. Kept free of I/O so it can be tested against
// recorded fixtures.
//
// YouTube serves live streams as *demuxed* HLS: the renditions carry video
// only (acodec "none") and audio arrives as separate audio-only renditions.
// Returning a single video rendition therefore produces a silent stream, which
// is why selection has to describe a track pair rather than one URL.

"use strict";

const { HttpError } = require("./errors");

const hasVideo = (f) => Boolean(f.vcodec) && f.vcodec !== "none";
const hasAudio = (f) => Boolean(f.acodec) && f.acodec !== "none";

// yt-dlp does not always populate acodec on an audio-only rendition (YouTube
// live reports itags 233/234 with acodec absent), so several signals are used.
const isAudioOnly = (f) =>
  !hasVideo(f) &&
  (hasAudio(f) ||
    f.resolution === "audio only" ||
    (Boolean(f.audio_ext) && f.audio_ext !== "none"));

const isH264 = (f) => /avc1|h264/i.test(f.vcodec || "");

function collectFormats(node) {
  return Array.isArray(node && node.formats) ? node.formats : [];
}

// Walks the root object plus any playlist entries (a /live URL can resolve to
// a single video or to a tab that yt-dlp reports as a playlist).
function gatherFormats(info) {
  const out = [];
  if (!info) return out;
  out.push(...collectFormats(info));
  if (Array.isArray(info.entries)) {
    for (const entry of info.entries) out.push(...collectFormats(entry));
  }
  return out;
}

function isHls(format) {
  const url = String(format.url || "").toLowerCase();
  const ext = String(format.ext || "").toLowerCase();
  const protocol = String(format.protocol || "").toLowerCase();
  return ext === "m3u8" || protocol.includes("m3u8") || url.includes(".m3u8");
}

// The multivariant ("master") playlist that lists every rendition. yt-dlp
// exposes it per-format as manifest_url, and sometimes at the top level.
function findMasterUrl(info, formats) {
  if (info && info.hls_manifest_url) return info.hls_manifest_url;
  if (Array.isArray(info && info.entries)) {
    const entry = info.entries.find((e) => e && e.hls_manifest_url);
    if (entry) return entry.hls_manifest_url;
  }
  const withManifest = formats.find((f) => f.manifest_url);
  return withManifest ? withManifest.manifest_url : null;
}

// Ranks by codec first, then resolution, then bitrate. Using separate
// comparison stages rather than a weighted sum means an H.264 preference can
// never promote a 360p rendition over a 1080p one.
function byQuality(a, b) {
  const aH264 = isH264(a);
  const bH264 = isH264(b);
  if (aH264 !== bH264) return aH264 ? -1 : 1;
  return (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0);
}

// Picks a video rendition honouring `min` as a floor and `h` as a ceiling.
function pickVideo(candidates, { minHeight = 0, targetHeight = null }) {
  const floor = Math.max(0, minHeight || 0);
  let pool = candidates.filter((f) => (f.height || 0) >= floor);

  // Nothing meets the floor: fall back to the whole set rather than 404, so a
  // low-resolution stream still plays instead of the channel going dark.
  if (!pool.length) pool = candidates.slice();

  if (targetHeight) {
    const atOrBelow = pool.filter((f) => (f.height || 0) <= targetHeight);
    if (atOrBelow.length) return atOrBelow.sort(byQuality)[0];

    // Every candidate is above the target: take the smallest one above it,
    // which is closer to what was asked for than the overall best.
    return pool
      .slice()
      .sort((a, b) => (a.height || 0) - (b.height || 0) || byQuality(a, b))[0];
  }

  return pool.sort(byQuality)[0];
}

// Audio renditions often carry no bitrate at all (YouTube live reports neither
// abr nor tbr), so the position yt-dlp listed them in is the tiebreak: it sorts
// ascending by quality, making the last entry the best one.
function pickAudio(candidates) {
  return candidates
    .map((f, index) => ({ f, index }))
    .sort((a, b) => {
      const aRate = a.f.abr || a.f.tbr || 0;
      const bRate = b.f.abr || b.f.tbr || 0;
      if (aRate !== bRate) return bRate - aRate;
      return b.index - a.index;
    })[0].f;
}

/**
 * @param {object} info  parsed `yt-dlp --dump-single-json` output
 * @param {{minHeight?: number, targetHeight?: number|null}} opts
 * @returns {{kind: "direct", url: string, masterUrl: string|null}
 *          |{kind: "demuxed", video: object, audio: object, masterUrl: string|null}}
 */
function selectStream(info, { minHeight = 0, targetHeight = null } = {}) {
  const all = gatherFormats(info);
  const hls = all.filter(isHls);
  const masterUrl = findMasterUrl(info, all);

  if (!hls.length) {
    // No enumerated renditions, but a multivariant playlist still plays and
    // carries its own audio.
    if (masterUrl) return { kind: "direct", url: masterUrl, masterUrl };
    throw new HttpError(404, "no HLS stream found for this url");
  }

  const muxed = hls.filter((f) => hasVideo(f) && hasAudio(f));
  if (muxed.length) {
    // A self-contained rendition: nothing to combine.
    const video = pickVideo(muxed, { minHeight, targetHeight });
    return { kind: "direct", url: video.url, masterUrl, video };
  }

  const videoOnly = hls.filter((f) => hasVideo(f));
  const audioOnly = hls.filter(isAudioOnly);

  if (videoOnly.length && audioOnly.length) {
    return {
      kind: "demuxed",
      video: pickVideo(videoOnly, { minHeight, targetHeight }),
      audio: pickAudio(audioOnly),
      masterUrl,
    };
  }

  // Video with no audio track anywhere: the multivariant playlist is the only
  // thing that might still carry audio, so prefer it when present.
  if (videoOnly.length) {
    if (masterUrl) return { kind: "direct", url: masterUrl, masterUrl };
    const video = pickVideo(videoOnly, { minHeight, targetHeight });
    return { kind: "direct", url: video.url, masterUrl, video };
  }

  // Audio only (a live radio stream, for instance).
  if (audioOnly.length) {
    const audio = pickAudio(audioOnly);
    return { kind: "direct", url: audio.url, masterUrl, audio };
  }

  if (masterUrl) return { kind: "direct", url: masterUrl, masterUrl };
  throw new HttpError(404, "no HLS stream found for this url");
}

module.exports = {
  selectStream,
  pickVideo,
  pickAudio,
  byQuality,
  isHls,
  isAudioOnly,
  hasVideo,
  hasAudio,
  gatherFormats,
  findMasterUrl,
};
