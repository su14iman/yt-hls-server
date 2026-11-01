// src/playlist.js
// Builds an HLS multivariant ("master") playlist that pairs one video
// rendition with one audio rendition.
//
// This is what restores sound on YouTube live streams: their HLS renditions
// are video-only, and a player needs an EXT-X-MEDIA group to know where the
// audio lives. Pinning a single video rendition here is also what keeps the
// `h` and `min` parameters meaningful - handing the player YouTube's own
// multivariant playlist would let it pick any resolution it liked.

"use strict";

// Infers the RFC 6381 codec string for an audio rendition. yt-dlp leaves
// acodec unset on YouTube live audio itags, but the container tells us enough:
// YouTube ships AAC-LC in fMP4 and Opus in WebM.
function audioCodec(audio) {
  if (audio.acodec && audio.acodec !== "none") return audio.acodec;
  const ext = String(audio.audio_ext || audio.ext || "").toLowerCase();
  if (ext === "webm" || ext === "opus") return "opus";
  if (ext === "mp4" || ext === "m4a") return "mp4a.40.2";
  return null;
}

// BANDWIDTH is a required attribute, and players use it to decide whether the
// stream fits the connection. Audio bitrate is usually unreported, so a
// conservative allowance is added rather than understating the total.
const ASSUMED_AUDIO_KBPS = 128;

function bandwidth(video, audio) {
  const videoKbps = video.tbr || video.vbr || 0;
  const audioKbps = audio ? audio.abr || audio.tbr || ASSUMED_AUDIO_KBPS : 0;
  const total = Math.round((videoKbps + audioKbps) * 1000);
  return total > 0 ? total : null;
}

// Attribute values are quoted strings; a stray quote would end the attribute
// early and corrupt the playlist.
const quoted = (value) => `"${String(value).replace(/"/g, "")}"`;

/**
 * @param {{video: object, audio: object}} tracks
 * @returns {string} a multivariant playlist
 */
function buildMasterPlaylist({ video, audio }) {
  if (!video || !video.url) {
    throw new TypeError("buildMasterPlaylist requires a video rendition");
  }

  const lines = [
    "#EXTM3U",
    // EXT-X-MEDIA requires protocol version 4.
    "#EXT-X-VERSION:4",
    // The two renditions are segmented on the same boundaries, which lets a
    // player start playback without buffering both tracks first.
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];

  const attributes = [];

  if (audio && audio.url) {
    lines.push(
      [
        "#EXT-X-MEDIA:TYPE=AUDIO",
        "GROUP-ID=" + quoted("audio"),
        "NAME=" + quoted(audio.format_note || "Audio"),
        audio.language ? "LANGUAGE=" + quoted(audio.language) : null,
        "DEFAULT=YES",
        "AUTOSELECT=YES",
        "URI=" + quoted(audio.url),
      ]
        .filter(Boolean)
        .join(","),
    );
  }

  const bw = bandwidth(video, audio);
  if (bw) attributes.push(`BANDWIDTH=${bw}`);

  if (video.width && video.height) {
    attributes.push(`RESOLUTION=${video.width}x${video.height}`);
  }

  if (video.fps) attributes.push(`FRAME-RATE=${Number(video.fps).toFixed(3)}`);

  const codecs = [
    video.vcodec && video.vcodec !== "none" ? video.vcodec : null,
    audio && audio.url ? audioCodec(audio) : null,
  ].filter(Boolean);
  // CODECS is optional, and a list that named video but omitted the audio
  // codec could stop a strict player from allocating an audio decoder, so it
  // is emitted only when every track is accounted for.
  const codecsComplete = audio && audio.url ? codecs.length === 2 : codecs.length === 1;
  if (codecs.length && codecsComplete) {
    attributes.push(`CODECS=${quoted(codecs.join(","))}`);
  }

  if (audio && audio.url) attributes.push(`AUDIO=${quoted("audio")}`);

  lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`);
  lines.push(video.url);

  return `${lines.join("\n")}\n`;
}

module.exports = { buildMasterPlaylist, audioCodec, bandwidth };
