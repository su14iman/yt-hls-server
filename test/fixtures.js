// test/fixtures.js
// Shapes mirror `yt-dlp --dump-single-json` output.
//
// Two cases matter. A muxed stream lists renditions that carry both tracks.
// A YouTube live stream is *demuxed*: every video rendition reports
// acodec "none", audio arrives as separate audio-only renditions, and only
// formats[].manifest_url points at the multivariant playlist. The demuxed
// shapes below were recorded from a real live channel.

"use strict";

const EXPIRE = 2000000000;

const signedUrl = (itag, expire = EXPIRE) =>
  `https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/${expire}/itag/${itag}/file/index.m3u8`;

const masterUrl = (expire = EXPIRE) =>
  `https://manifest.googlevideo.com/api/manifest/hls_variant/expire/${expire}/demuxed/1/maudio/1/file/index.m3u8`;

// A self-contained rendition: both codecs present.
function muxedFormat(height, { tbr = height * 3, vcodec = "avc1.64002a" } = {}) {
  return {
    format_id: `${height}p`,
    url: signedUrl(height),
    ext: "mp4",
    protocol: "m3u8_native",
    height,
    width: Math.round((height * 16) / 9),
    tbr,
    vcodec,
    acodec: "mp4a.40.2",
  };
}

// Video-only, as YouTube reports live renditions.
function videoOnlyFormat(height, { tbr = height * 3, vcodec = "avc1.4D401F", fps = 30 } = {}) {
  return {
    format_id: `v${height}`,
    url: signedUrl(height),
    manifest_url: masterUrl(),
    ext: "mp4",
    protocol: "m3u8_native",
    height,
    width: Math.round((height * 16) / 9),
    fps,
    tbr,
    vbr: tbr,
    vcodec,
    acodec: "none",
    audio_ext: "none",
    video_ext: "mp4",
    resolution: `${Math.round((height * 16) / 9)}x${height}`,
  };
}

// Audio-only. Note that yt-dlp leaves acodec, abr and tbr unset here, which is
// exactly what the real extractor does for itags 233/234.
function audioOnlyFormat(formatId, note) {
  return {
    format_id: formatId,
    format_note: note,
    url: signedUrl(formatId),
    manifest_url: masterUrl(),
    ext: "mp4",
    protocol: "m3u8_native",
    vcodec: "none",
    audio_ext: "mp4",
    video_ext: "none",
    resolution: "audio only",
    vbr: 0,
  };
}

// A DASH rendition that must never be selected.
const dashFormat = {
  format_id: "dash-137",
  url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=137",
  ext: "mp4",
  protocol: "https",
  height: 2160,
  tbr: 20000,
  vcodec: "avc1.640028",
  acodec: "none",
};

// ---- demuxed: what a real YouTube live stream looks like ----
const liveDemuxed = {
  id: "_uwrv0SdRI4",
  title: "Live news",
  is_live: true,
  hls_manifest_url: null,
  formats: [
    audioOnlyFormat("233", "Default, low"),
    audioOnlyFormat("234", "Default, high"),
    videoOnlyFormat(144, { tbr: 269.034, vcodec: "avc1.42C00B" }),
    videoOnlyFormat(240, { tbr: 507.418, vcodec: "avc1.4D4015" }),
    videoOnlyFormat(360, { tbr: 962.461, vcodec: "avc1.4D401E" }),
    videoOnlyFormat(480, { tbr: 1282.517 }),
    videoOnlyFormat(720, { tbr: 2447.97 }),
    videoOnlyFormat(1080, { tbr: 4561.186, vcodec: "avc1.640028" }),
  ],
};

// ---- muxed: a VOD, or a live stream that is not demuxed ----
const liveMuxed = {
  id: "abc123",
  is_live: true,
  hls_manifest_url: masterUrl(),
  formats: [
    dashFormat,
    muxedFormat(144, { tbr: 150 }),
    muxedFormat(360),
    muxedFormat(480),
    muxedFormat(720),
    muxedFormat(1080),
  ],
};

// Only low renditions available: exercises the minHeight fallback.
const lowOnly = {
  id: "low1",
  is_live: true,
  formats: [muxedFormat(144, { tbr: 150 }), muxedFormat(240, { tbr: 300 })],
};

// Mixed codecs: a high-resolution VP9 rendition alongside lower H.264 ones.
const mixedCodecs = {
  id: "mix1",
  is_live: true,
  formats: [
    muxedFormat(1080, { tbr: 4500, vcodec: "vp09.00.41.08" }),
    muxedFormat(720, { tbr: 2500 }),
    muxedFormat(360, { tbr: 800 }),
  ],
};

// Video renditions with no audio anywhere, but a multivariant playlist exists.
const videoOnlyWithMaster = {
  id: "vo1",
  is_live: true,
  formats: [videoOnlyFormat(720), videoOnlyFormat(1080)],
};

// Video renditions with no audio and no multivariant playlist either.
const videoOnlyNoMaster = {
  id: "vo2",
  is_live: true,
  formats: [
    { ...videoOnlyFormat(720), manifest_url: undefined },
    { ...videoOnlyFormat(1080), manifest_url: undefined },
  ],
};

// An audio-only live stream, e.g. a radio broadcast.
const audioOnlyStream = {
  id: "radio1",
  is_live: true,
  formats: [audioOnlyFormat("233", "Default, low"), audioOnlyFormat("234", "Default, high")],
};

// yt-dlp returns a playlist wrapper for some channel URLs.
const playlistWrapper = {
  _type: "playlist",
  id: "channel1",
  entries: [
    { id: "e1", formats: [] },
    { id: "e2", formats: [muxedFormat(720), muxedFormat(1080)] },
  ],
};

// No formats at all, but a usable manifest on an entry.
const manifestOnly = {
  _type: "playlist",
  id: "channel2",
  entries: [{ id: "e1", formats: [], hls_manifest_url: masterUrl() }],
};

const noHls = {
  id: "vod1",
  is_live: false,
  formats: [dashFormat],
};

module.exports = {
  EXPIRE,
  signedUrl,
  masterUrl,
  muxedFormat,
  videoOnlyFormat,
  audioOnlyFormat,
  dashFormat,
  liveDemuxed,
  liveMuxed,
  lowOnly,
  mixedCodecs,
  videoOnlyWithMaster,
  videoOnlyNoMaster,
  audioOnlyStream,
  playlistWrapper,
  manifestOnly,
  noHls,
};
