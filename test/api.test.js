import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import pino from "pino";

import appModule from "../src/app.js";
import configModule from "../src/config.js";
import extractorModule from "../src/extractor.js";
import fixtures from "./fixtures.js";

const { createApp } = appModule;
const { createExtractor } = extractorModule;
const { liveDemuxed, liveMuxed } = fixtures;

const silentLogger = pino({ level: "silent" });

// Stands in for src/ytdlp.js: no process is spawned anywhere in these tests.
function fakeYtdlp({ result = liveDemuxed, error = null, delayMs = 0 } = {}) {
  const calls = [];
  return {
    binary: "/usr/local/bin/yt-dlp",
    calls,
    dumpJson: vi.fn(async (url) => {
      calls.push(url);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (error) throw error;
      return result;
    }),
    version: async () => "2026.10.26",
    selfUpdate: async () => true,
  };
}

function build({ env = {}, ytdlp = fakeYtdlp() } = {}) {
  const config = configModule.load({ RATE_LIMIT_MAX: "0", ...env });
  const extractor = createExtractor({ config, logger: silentLogger, ytdlp });
  const app = createApp({
    config,
    logger: silentLogger,
    extractor,
    ytdlp,
    state: { ytdlpVersion: "2026.10.26" },
  });
  return { app, config, extractor, ytdlp };
}

const LIVE = "https://www.youtube.com/@AlekhbariahSY/live";

// superagent only fills res.text for types it considers textual; a playlist
// arrives as a Buffer in res.body.
const bodyText = (res) =>
  res.text !== undefined ? res.text : Buffer.from(res.body).toString("utf8");

let ctx;
beforeEach(() => {
  ctx = build();
});

describe("health endpoints", () => {
  it("answers liveness without touching yt-dlp", async () => {
    const res = await request(ctx.app).get("/");
    expect(res.status).toBe(200);
    expect(res.text.trim()).toBe("OK");
    expect(ctx.ytdlp.dumpJson).not.toHaveBeenCalled();
  });

  it("reports the yt-dlp version and queue state on /healthz", async () => {
    const res = await request(ctx.app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      ytdlp: { version: "2026.10.26", path: "/usr/local/bin/yt-dlp" },
    });
    expect(res.body.cache).toBeDefined();
    expect(res.body.queue).toBeDefined();
  });
});

// A YouTube live stream is demuxed, so no single upstream URL carries both
// tracks. Endpoints that must return a URL point back at /master.m3u8.
describe("demuxed stream: /hls_url", () => {
  it("returns a url pointing at this server's generated playlist", async () => {
    const res = await request(ctx.app).get("/hls_url").query({ url: LIVE, h: 720 });
    expect(res.status).toBe(200);
    expect(res.text.trim()).toContain("/master.m3u8?");
    expect(res.text).toContain("h=720");
  });

  it("never hands out a silent video-only rendition", async () => {
    const res = await request(ctx.app).get("/hls_url").query({ url: LIVE, h: 720 });
    const videoOnly = liveDemuxed.formats.find((f) => f.height === 720).url;
    expect(res.text.trim()).not.toBe(videoOnly);
  });

  it("returns the upstream multivariant playlist with ?upstream=1", async () => {
    const res = await request(ctx.app)
      .get("/hls_url")
      .query({ url: LIVE, h: 720, upstream: 1 });
    expect(res.text.trim()).toContain("hls_variant");
  });
});

describe("demuxed stream: /master.m3u8", () => {
  it("serves a playlist carrying both an audio group and a video rendition", async () => {
    const res = await request(ctx.app).get("/master.m3u8").query({ url: LIVE, h: 720 });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.apple.mpegurl");

    const text = bodyText(res);
    expect(text).toContain("#EXTM3U");
    expect(text).toContain("#EXT-X-MEDIA:TYPE=AUDIO");
    expect(text).toContain('AUDIO="audio"');
    expect(text).toContain("RESOLUTION=1280x720");
  });

  it("references the audio rendition url, not just the video one", async () => {
    const res = await request(ctx.app).get("/master.m3u8").query({ url: LIVE, h: 720 });
    const audio = liveDemuxed.formats.find((f) => f.format_id === "234").url;
    const video = liveDemuxed.formats.find((f) => f.height === 720).url;
    expect(bodyText(res)).toContain(audio);
    expect(bodyText(res)).toContain(video);
  });

  it("pins the requested quality instead of the full ladder", async () => {
    const res = await request(ctx.app).get("/master.m3u8").query({ url: LIVE, h: 480 });
    const text = bodyText(res);
    expect(text).toContain("RESOLUTION=853x480");
    expect(text.split("\n").filter((l) => l.startsWith("#EXT-X-STREAM-INF:"))).toHaveLength(1);
  });

  it("must not be cached by an intermediary", async () => {
    const res = await request(ctx.app).get("/master.m3u8").query({ url: LIVE });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("demuxed stream: /redirect.m3u8", () => {
  // Existing IPTV playlists point here, so it keeps working unchanged - it
  // serves the playlist inline rather than redirecting to a silent rendition.
  it("serves the generated playlist inline instead of redirecting", async () => {
    const res = await request(ctx.app).get("/redirect.m3u8").query({ url: LIVE, h: 720 });
    expect(res.status).toBe(200);
    const text = bodyText(res);
    expect(text).toContain("#EXT-X-MEDIA:TYPE=AUDIO");
    expect(text).toContain("RESOLUTION=1280x720");
  });
});

describe("demuxed stream: /hls.json", () => {
  it("reports that the stream is demuxed and what was selected", async () => {
    const res = await request(ctx.app).get("/hls.json").query({ url: LIVE, h: 720 });
    expect(res.body).toMatchObject({
      demuxed: true,
      video: { formatId: "v720", height: 720, vcodec: "avc1.4D401F" },
      audio: { formatId: "234" },
    });
    expect(res.body.upstreamMaster).toContain("hls_variant");
    expect(res.body.url).toContain("/master.m3u8?");
  });
});

describe("demuxed stream: /playlist.m3u", () => {
  it("points the channel entry at a url that plays with audio", async () => {
    const res = await request(ctx.app)
      .get("/playlist.m3u")
      .query({ url: LIVE, name: "Al Ekhbariah", h: 720 });
    const l = bodyText(res).trim().split("\n");
    expect(l[0]).toBe("#EXTM3U");
    expect(l[2]).toContain("/master.m3u8?");
  });
});

// A muxed rendition needs no assembly, so the original direct-URL behaviour is
// preserved for VODs and non-demuxed live streams.
describe("muxed stream", () => {
  let muxed;
  beforeEach(() => {
    muxed = build({ ytdlp: fakeYtdlp({ result: liveMuxed }) });
  });

  it("returns the rendition url directly", async () => {
    const res = await request(muxed.app).get("/hls_url").query({ url: LIVE, h: 720 });
    expect(res.text.trim()).toContain("/itag/720/");
    expect(res.text.trim()).not.toContain("/master.m3u8");
  });

  it("302-redirects from /redirect.m3u8", async () => {
    const res = await request(muxed.app).get("/redirect.m3u8").query({ url: LIVE });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(".m3u8");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("reports demuxed: false", async () => {
    const res = await request(muxed.app).get("/hls.json").query({ url: LIVE });
    expect(res.body.demuxed).toBe(false);
  });
});

describe("input validation", () => {
  it("rejects a missing url with 400", async () => {
    const res = await request(ctx.app).get("/hls_url");
    expect(res.status).toBe(400);
    expect(res.text).toContain("missing ?url");
  });

  it("rejects a host outside the allowlist with 403", async () => {
    const res = await request(ctx.app)
      .get("/hls_url")
      .query({ url: "http://169.254.169.254/latest/meta-data/" });
    expect(res.status).toBe(403);
    expect(ctx.ytdlp.dumpJson).not.toHaveBeenCalled();
  });

  it("rejects a flag-shaped url before spawning anything", async () => {
    const res = await request(ctx.app)
      .get("/hls_url")
      .query({ url: "--config-location=/tmp/evil.conf" });
    expect(res.status).toBe(400);
    expect(ctx.ytdlp.dumpJson).not.toHaveBeenCalled();
  });
});

describe("caching", () => {
  it("serves a repeat request from cache", async () => {
    const first = await request(ctx.app).get("/hls_url").query({ url: LIVE });
    const second = await request(ctx.app).get("/hls_url").query({ url: LIVE });
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(ctx.ytdlp.dumpJson).toHaveBeenCalledTimes(1);
  });

  it("caches both tracks, so a cached playlist still has audio", async () => {
    await request(ctx.app).get("/master.m3u8").query({ url: LIVE, h: 720 });
    const res = await request(ctx.app).get("/master.m3u8").query({ url: LIVE, h: 720 });
    expect(res.headers["x-cache"]).toBe("HIT");
    expect(bodyText(res)).toContain("#EXT-X-MEDIA:TYPE=AUDIO");
    expect(ctx.ytdlp.dumpJson).toHaveBeenCalledTimes(1);
  });

  it("does not share a cache entry across different qualities", async () => {
    await request(ctx.app).get("/hls_url").query({ url: LIVE, h: 720 });
    await request(ctx.app).get("/hls_url").query({ url: LIVE, h: 480 });
    expect(ctx.ytdlp.dumpJson).toHaveBeenCalledTimes(2);
  });

  it("collapses identical concurrent requests into one yt-dlp call", async () => {
    const slow = build({ ytdlp: fakeYtdlp({ delayMs: 40 }) });
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => request(slow.app).get("/hls_url").query({ url: LIVE })),
    );
    for (const res of responses) expect(res.status).toBe(200);
    expect(slow.ytdlp.dumpJson).toHaveBeenCalledTimes(1);
  });
});

describe("m3u escaping", () => {
  it("cannot be tricked into emitting a forged entry", async () => {
    const res = await request(ctx.app)
      .get("/playlist.m3u")
      .query({
        url: LIVE,
        name: "Good\n#EXTINF:-1,Evil\nhttp://evil.test/x.m3u8",
        group: 'News" tvg-logo="http://evil.test/l.png',
      });
    expect(res.status).toBe(200);
    const lines = bodyText(res).trim().split("\n");

    // The hostile text survives as inert characters inside the quoted
    // attribute value; what matters is that it cannot become structure.
    expect(lines).toHaveLength(3);
    expect(lines.filter((l) => l.startsWith("#EXTINF"))).toHaveLength(1);
    expect(lines[1]).not.toMatch(/tvg-logo="/);
    expect(lines[2]).not.toContain("evil.test");
  });
});

describe("error handling", () => {
  const execFailure = (stderr) =>
    Object.assign(new Error("Command failed with exit code 1"), { stderr });

  it("reports an offline channel as 404", async () => {
    const offline = build({
      ytdlp: fakeYtdlp({ error: execFailure("ERROR: The channel is not currently live") }),
    });
    expect((await request(offline.app).get("/hls_url").query({ url: LIVE })).status).toBe(404);
  });

  it("reports an unknown yt-dlp failure as 502, not 404", async () => {
    const broken = build({
      ytdlp: fakeYtdlp({ error: execFailure("ERROR: something new and strange") }),
    });
    expect((await request(broken.app).get("/hls_url").query({ url: LIVE })).status).toBe(502);
  });

  it("reports bot detection as 429 with an actionable message", async () => {
    const blocked = build({
      ytdlp: fakeYtdlp({ error: execFailure("ERROR: Sign in to confirm you're not a bot") }),
    });
    const res = await request(blocked.app).get("/hls_url").query({ url: LIVE });
    expect(res.status).toBe(429);
    expect(res.text).toMatch(/cookies or a proxy/);
  });

  it("never leaks the command line to the client", async () => {
    const leaky = build({
      ytdlp: fakeYtdlp({
        error: execFailure(
          "Command failed: /usr/local/bin/yt-dlp https://x --dump-single-json " +
            "--cookies /run/secrets/cookies.txt",
        ),
      }),
    });
    const res = await request(leaky.app).get("/hls_url").query({ url: LIVE });
    expect(res.text).not.toContain("--dump-single-json");
    expect(res.text).not.toContain("cookies.txt");
    expect(res.text).not.toContain("/usr/local/bin");
  });

  it("returns 404 for an unknown path", async () => {
    expect((await request(ctx.app).get("/nope")).status).toBe(404);
  });
});

describe("cors", () => {
  it("answers a preflight request", async () => {
    const res = await request(ctx.app).options("/hls_url");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
    expect(res.headers["access-control-allow-headers"]).toContain("Authorization");
  });
});

describe("optional auth", () => {
  it("is open when no token is configured", async () => {
    expect((await request(ctx.app).get("/hls_url").query({ url: LIVE })).status).toBe(200);
  });

  it("rejects an unauthenticated request when a token is set", async () => {
    const guarded = build({ env: { API_TOKEN: "s3cret" } });
    expect((await request(guarded.app).get("/hls_url").query({ url: LIVE })).status).toBe(401);
  });

  it("accepts a bearer header and a query token", async () => {
    const guarded = build({ env: { API_TOKEN: "s3cret" } });
    const viaHeader = await request(guarded.app)
      .get("/hls_url")
      .query({ url: LIVE })
      .set("Authorization", "Bearer s3cret");
    expect(viaHeader.status).toBe(200);
    const viaQuery = await request(guarded.app)
      .get("/hls_url")
      .query({ url: LIVE, token: "s3cret" });
    expect(viaQuery.status).toBe(200);
  });

  // The generated URL has to stay fetchable by the player that receives it.
  it("carries a query token into the generated master url", async () => {
    const guarded = build({ env: { API_TOKEN: "s3cret" } });
    const res = await request(guarded.app)
      .get("/hls_url")
      .query({ url: LIVE, h: 720, token: "s3cret" });
    expect(res.text).toContain("token=s3cret");
  });

  // A header-supplied secret must not be copied into a URL that ends up in a
  // playlist file.
  it("does not leak a header token into the generated master url", async () => {
    const guarded = build({ env: { API_TOKEN: "s3cret" } });
    const res = await request(guarded.app)
      .get("/hls_url")
      .query({ url: LIVE, h: 720 })
      .set("Authorization", "Bearer s3cret");
    expect(res.text).not.toContain("s3cret");
  });

  it("leaves the health endpoints unguarded for probes", async () => {
    const guarded = build({ env: { API_TOKEN: "s3cret" } });
    expect((await request(guarded.app).get("/")).status).toBe(200);
    expect((await request(guarded.app).get("/healthz")).status).toBe(200);
  });
});

describe("public base url", () => {
  it("uses PUBLIC_BASE_URL for generated links when configured", async () => {
    const proxied = build({ env: { PUBLIC_BASE_URL: "https://tv.example.com/" } });
    const res = await request(proxied.app).get("/hls_url").query({ url: LIVE, h: 720 });
    expect(res.text.trim()).toMatch(/^https:\/\/tv\.example\.com\/master\.m3u8\?/);
  });
});

describe("rate limiting", () => {
  it("returns 429 once the window is exhausted", async () => {
    const limited = build({ env: { RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_MS: "60000" } });
    const codes = [];
    for (let i = 0; i < 4; i += 1) {
      codes.push((await request(limited.app).get("/hls_url").query({ url: LIVE })).status);
    }
    expect(codes.slice(0, 2)).toEqual([200, 200]);
    expect(codes.slice(2)).toEqual([429, 429]);
  });
});

describe("concurrency limit", () => {
  it("rejects with 503 once the queue is full", async () => {
    const busy = build({
      env: { YTDLP_CONCURRENCY: "1", YTDLP_QUEUE_LIMIT: "1" },
      ytdlp: fakeYtdlp({ delayMs: 60 }),
    });
    // Distinct URLs so single-flight does not merge them.
    const urls = [1, 2, 3, 4, 5].map((n) => `https://www.youtube.com/@ch${n}/live`);
    const results = await Promise.all(
      urls.map((url) => request(busy.app).get("/hls_url").query({ url })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses).toContain(503);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
  });
});
