import { describe, expect, it } from "vitest";
import playlistModule from "../src/playlist.js";
import selectModule from "../src/select.js";
import fixtures from "./fixtures.js";

const { buildMasterPlaylist, audioCodec, bandwidth } = playlistModule;
const { selectStream } = selectModule;
const { liveDemuxed, videoOnlyFormat, audioOnlyFormat } = fixtures;

const lines = (text) => text.trim().split("\n");
const find = (text, prefix) => lines(text).find((l) => l.startsWith(prefix));

describe("buildMasterPlaylist", () => {
  const stream = selectStream(liveDemuxed, { targetHeight: 720 });
  const playlist = buildMasterPlaylist(stream);

  it("emits a valid multivariant playlist header", () => {
    const l = lines(playlist);
    expect(l[0]).toBe("#EXTM3U");
    // EXT-X-MEDIA requires protocol version 4.
    expect(playlist).toContain("#EXT-X-VERSION:4");
  });

  // Without this tag a player has no way to find the audio track, which is
  // exactly why a video-only rendition plays silently.
  it("declares the audio rendition as a default, auto-selected group", () => {
    const media = find(playlist, "#EXT-X-MEDIA:");
    expect(media).toContain("TYPE=AUDIO");
    expect(media).toContain('GROUP-ID="audio"');
    expect(media).toContain("DEFAULT=YES");
    expect(media).toContain("AUTOSELECT=YES");
    expect(media).toContain(`URI="${stream.audio.url}"`);
  });

  it("links the video rendition to that audio group", () => {
    const inf = find(playlist, "#EXT-X-STREAM-INF:");
    expect(inf).toContain('AUDIO="audio"');
    expect(lines(playlist).at(-1)).toBe(stream.video.url);
  });

  it("declares the pinned resolution, not the whole ladder", () => {
    expect(find(playlist, "#EXT-X-STREAM-INF:")).toContain("RESOLUTION=1280x720");
    expect(playlist).not.toContain("/itag/v1080/");
    expect(lines(playlist).filter((l) => l.startsWith("#EXT-X-STREAM-INF:"))).toHaveLength(1);
  });

  it("includes BANDWIDTH, which is a required attribute", () => {
    expect(find(playlist, "#EXT-X-STREAM-INF:")).toMatch(/BANDWIDTH=\d+/);
  });

  it("names both codecs so a player allocates an audio decoder", () => {
    expect(find(playlist, "#EXT-X-STREAM-INF:")).toContain('CODECS="avc1.4D401F,mp4a.40.2"');
  });

  it("reports the frame rate when known", () => {
    expect(find(playlist, "#EXT-X-STREAM-INF:")).toContain("FRAME-RATE=30.000");
  });

  it("pins the requested height rather than the best one", () => {
    const at480 = buildMasterPlaylist(selectStream(liveDemuxed, { targetHeight: 480 }));
    expect(find(at480, "#EXT-X-STREAM-INF:")).toContain("RESOLUTION=853x480");
  });

  it("omits CODECS when the audio codec cannot be determined", () => {
    const unknown = {
      video: videoOnlyFormat(720),
      audio: { ...audioOnlyFormat("233", "low"), audio_ext: "flv", ext: "flv" },
    };
    const text = buildMasterPlaylist(unknown);
    expect(text).not.toContain("CODECS=");
    // The audio group is still declared, so playback keeps its sound.
    expect(text).toContain("TYPE=AUDIO");
  });

  // The hostile text survives as inert characters inside the quoted NAME
  // value. What matters is that it cannot close the quote and become an
  // attribute of its own.
  it("strips quotes that would terminate an attribute early", () => {
    const hostile = {
      video: videoOnlyFormat(720),
      audio: { ...audioOnlyFormat("233", 'x" DEFAULT=NO'), audio_ext: "mp4" },
    };
    const media = find(buildMasterPlaylist(hostile), "#EXT-X-MEDIA:");

    // Quotes stay balanced, so every value is still delimited as intended.
    expect(media.match(/"/g).length % 2).toBe(0);

    // With the quoted values removed, the attribute skeleton is untouched.
    const skeleton = media.replace(/"[^"]*"/g, '""');
    expect(skeleton).toContain("DEFAULT=YES");
    expect(skeleton).not.toContain("DEFAULT=NO");
  });

  it("builds a video-only playlist when no audio track is supplied", () => {
    const text = buildMasterPlaylist({ video: videoOnlyFormat(720) });
    expect(text).not.toContain("TYPE=AUDIO");
    expect(text).not.toContain("AUDIO=");
    expect(lines(text).at(-1)).toContain("/itag/720/");
  });

  it("refuses to build without a video rendition", () => {
    expect(() => buildMasterPlaylist({})).toThrow(TypeError);
    expect(() => buildMasterPlaylist({ video: {} })).toThrow(TypeError);
  });
});

describe("audioCodec", () => {
  it("uses a reported codec verbatim", () => {
    expect(audioCodec({ acodec: "mp4a.40.5" })).toBe("mp4a.40.5");
  });

  // yt-dlp leaves acodec unset on YouTube live audio itags.
  it("infers AAC for an fMP4 container", () => {
    expect(audioCodec({ audio_ext: "mp4" })).toBe("mp4a.40.2");
    expect(audioCodec({ ext: "m4a" })).toBe("mp4a.40.2");
  });

  it("infers Opus for WebM", () => {
    expect(audioCodec({ audio_ext: "webm" })).toBe("opus");
  });

  it("returns null when it cannot tell", () => {
    expect(audioCodec({})).toBeNull();
    expect(audioCodec({ acodec: "none", audio_ext: "none" })).toBeNull();
  });
});

describe("bandwidth", () => {
  it("adds an allowance for unreported audio bitrate", () => {
    expect(bandwidth({ tbr: 2447.97 }, { format_id: "234" })).toBe(2575970);
  });

  it("uses a reported audio bitrate when present", () => {
    expect(bandwidth({ tbr: 1000 }, { abr: 64 })).toBe(1064000);
  });

  it("returns null when nothing is known", () => {
    expect(bandwidth({}, null)).toBeNull();
  });
});
