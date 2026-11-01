import { describe, expect, it } from "vitest";
import selectModule from "../src/select.js";
import fixtures from "./fixtures.js";

const { selectStream, pickAudio, isAudioOnly } = selectModule;
const {
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
  muxedFormat,
  videoOnlyFormat,
} = fixtures;

// Renditions are keyed by the itag segment the fixture builder embeds.
const heightOf = (url) => Number(url.match(/\/itag\/v?(\d+)\//)[1]);

describe("selectStream on a muxed stream", () => {
  it("returns a single direct url", () => {
    const stream = selectStream(liveMuxed);
    expect(stream.kind).toBe("direct");
    expect(heightOf(stream.url)).toBe(1080);
  });

  it("never returns a non-HLS format", () => {
    // The fixture has a 2160p DASH rendition that outranks every HLS one.
    expect(selectStream(liveMuxed).url).toContain(".m3u8");
  });

  it("treats h as a ceiling", () => {
    expect(heightOf(selectStream(liveMuxed, { targetHeight: 720 }).url)).toBe(720);
    expect(heightOf(selectStream(liveMuxed, { targetHeight: 480 }).url)).toBe(480);
  });

  it("falls to the next rendition below a target that does not exist", () => {
    expect(heightOf(selectStream(liveMuxed, { targetHeight: 900 }).url)).toBe(720);
  });

  // Previously `h` was applied as a floor, so `min` became unreachable
  // whenever `h` was supplied.
  it("honours min as a floor while h stays a ceiling", () => {
    const stream = selectStream(liveMuxed, { targetHeight: 1080, minHeight: 720 });
    expect(heightOf(stream.url)).toBe(1080);
  });

  it("does not drop below min when the target is unavailable", () => {
    const info = { formats: [muxedFormat(360), muxedFormat(720)] };
    expect(heightOf(selectStream(info, { targetHeight: 1080, minHeight: 720 }).url)).toBe(720);
  });

  it("serves the best available rather than failing when nothing meets min", () => {
    expect(heightOf(selectStream(lowOnly, { minHeight: 1080 }).url)).toBe(240);
  });

  it("takes the closest rendition above the target when all exceed it", () => {
    expect(heightOf(selectStream(liveMuxed, { targetHeight: 100 }).url)).toBe(144);
  });

  // The old scoring added a flat +10000 for H.264, which outweighed ~1000
  // pixels of height and could promote 360p over 1080p.
  it("prefers H.264 without letting it beat a much higher resolution", () => {
    expect(heightOf(selectStream(mixedCodecs).url)).toBe(720);
    expect(heightOf(selectStream(mixedCodecs, { targetHeight: 360 }).url)).toBe(360);
  });

  it("reads formats out of playlist entries", () => {
    expect(heightOf(selectStream(playlistWrapper).url)).toBe(1080);
  });
});

// This is the regression behind "the video has no sound": YouTube live
// renditions are video-only, so returning one of them produces a silent
// stream. Selection has to pair it with an audio rendition.
describe("selectStream on a demuxed stream", () => {
  it("reports the stream as demuxed and pairs both tracks", () => {
    const stream = selectStream(liveDemuxed);
    expect(stream.kind).toBe("demuxed");
    expect(stream.video).toBeDefined();
    expect(stream.audio).toBeDefined();
  });

  it("never returns a video-only rendition on its own", () => {
    const stream = selectStream(liveDemuxed, { targetHeight: 720 });
    expect(stream.kind).not.toBe("direct");
    expect(stream.video.acodec).toBe("none");
    expect(stream.audio.vcodec).toBe("none");
  });

  it("still honours h and min on the video track", () => {
    expect(selectStream(liveDemuxed, { targetHeight: 720 }).video.height).toBe(720);
    expect(selectStream(liveDemuxed, { targetHeight: 480 }).video.height).toBe(480);
    expect(
      selectStream(liveDemuxed, { targetHeight: 1080, minHeight: 720 }).video.height,
    ).toBe(1080);
    expect(selectStream(liveDemuxed, { minHeight: 480 }).video.height).toBeGreaterThanOrEqual(
      480,
    );
  });

  it("picks the best video rendition when unconstrained", () => {
    expect(selectStream(liveDemuxed).video.height).toBe(1080);
  });

  it("exposes the upstream multivariant playlist from manifest_url", () => {
    // The top-level hls_manifest_url is null on a real live stream; the URL
    // only appears on the individual formats.
    expect(liveDemuxed.hls_manifest_url).toBeNull();
    expect(selectStream(liveDemuxed).masterUrl).toContain("hls_variant");
  });

  it("prefers the higher-quality audio rendition", () => {
    // Neither itag reports a bitrate, so yt-dlp's own ascending order decides.
    expect(selectStream(liveDemuxed).audio.format_id).toBe("234");
  });
});

describe("audio rendition detection and ranking", () => {
  it("recognises an audio-only format that reports no acodec", () => {
    const audio = liveDemuxed.formats.find((f) => f.format_id === "233");
    expect(audio.acodec).toBeUndefined();
    expect(isAudioOnly(audio)).toBe(true);
  });

  it("does not mistake a video-only format for audio", () => {
    expect(isAudioOnly(videoOnlyFormat(720))).toBe(false);
  });

  it("ranks by bitrate when one is reported", () => {
    const low = { format_id: "a1", url: "x", vcodec: "none", audio_ext: "mp4", abr: 48 };
    const high = { format_id: "a2", url: "y", vcodec: "none", audio_ext: "mp4", abr: 128 };
    expect(pickAudio([high, low]).format_id).toBe("a2");
    expect(pickAudio([low, high]).format_id).toBe("a2");
  });
});

describe("selectStream fallbacks", () => {
  it("falls back to the multivariant playlist when no audio exists at all", () => {
    const stream = selectStream(videoOnlyWithMaster, { targetHeight: 720 });
    expect(stream.kind).toBe("direct");
    expect(stream.url).toContain("hls_variant");
  });

  it("serves a video-only rendition only when there is nothing better", () => {
    const stream = selectStream(videoOnlyNoMaster, { targetHeight: 720 });
    expect(stream.kind).toBe("direct");
    expect(heightOf(stream.url)).toBe(720);
  });

  it("handles an audio-only stream", () => {
    const stream = selectStream(audioOnlyStream);
    expect(stream.kind).toBe("direct");
    expect(stream.audio.format_id).toBe("234");
  });

  it("falls back to hls_manifest_url when no formats are listed", () => {
    expect(selectStream(manifestOnly).url).toContain("hls_variant");
  });

  it("throws a 404 when there is no HLS stream at all", () => {
    expect(() => selectStream(noHls)).toThrowError(/no HLS stream/);
    try {
      selectStream(noHls);
    } catch (err) {
      expect(err.status).toBe(404);
    }
  });

  it("tolerates empty and malformed input", () => {
    expect(() => selectStream(null)).toThrowError(/no HLS stream/);
    expect(() => selectStream({})).toThrowError(/no HLS stream/);
    expect(() => selectStream({ formats: [] })).toThrowError(/no HLS stream/);
  });
});
