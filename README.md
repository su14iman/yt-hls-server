# yt-hls-server — YouTube Live → HLS extractor

An Express server that resolves a YouTube Live URL to its best HLS (`m3u8`)
manifest using [yt-dlp](https://github.com/yt-dlp/yt-dlp). Built for IPTV
playlists, media players and streaming integrations.

## Features

- Extracts HLS manifests from YouTube Live channels and videos
- Quality selection by ceiling (`h`) and floor (`min`), with H.264 preferred for TV compatibility
- Pairs video with audio on demuxed streams, so YouTube live plays **with sound**
- Five output shapes: plain text, JSON, HLS playlist, M3U channel list, and a 302 redirect
- Caches resolved manifests until just before the signed URL expires
- Collapses duplicate concurrent lookups into a single `yt-dlp` process
- Caps concurrency, rate-limits callers, and times out stuck extractions
- Host allowlist, so the server cannot be used as an open proxy
- Meaningful HTTP status codes, and no internal detail in error responses
- Self-contained `yt-dlp` build in the image: no Python dependency
- Multi-arch Docker image (amd64, arm64) with health checks

## Quick start

### Docker (recommended)

```bash
docker pull su14iman/yt-hls-server:latest
docker run -p 8000:8000 -e TZ=Europe/Berlin su14iman/yt-hls-server:latest
```

Or with compose, which carries the hardened defaults:

```bash
git clone https://github.com/su14iman/yt-hls-server.git
cd yt-hls-server
docker compose up -d --build
```

### Local development

```bash
npm install

# yt-dlp must be on PATH. Prefer the self-contained build:
#   curl -fsSL -o /usr/local/bin/yt-dlp \
#     https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
#   chmod +x /usr/local/bin/yt-dlp
# On macOS: brew install yt-dlp

npm start          # or: npm run dev   (restarts on change)
npm test
npm run lint
```

The server listens on `http://localhost:8000`.

## API

All extraction endpoints accept:

| Parameter | Required | Meaning |
|---|---|---|
| `url` | yes | YouTube Live or video URL. Must be `http(s)` on an allowed host. |
| `h` | no | **Ceiling.** Best rendition at or below this height. |
| `min` | no | **Floor.** Renditions below this height are skipped. |
| `token` | no | Required only when `API_TOKEN` is set. |
| `upstream` | no | `1` returns YouTube's own multivariant playlist instead of a pinned one. |

Responses carry `X-Cache: HIT` or `MISS`.

### `GET /hls_url` — a playable URL as text

For a muxed rendition this is the upstream URL. For a demuxed stream it is a
URL on this server pointing at `/master.m3u8`, because no single
upstream URL carries both tracks.

```bash
curl "http://localhost:8000/hls_url?url=https://www.youtube.com/@AlekhbariahSY/live&h=720"
```

### `GET /hls.json` — manifest URL as JSON

```bash
curl "http://localhost:8000/hls.json?url=https://www.youtube.com/@AlekhbariahSY/live&h=720"
```

```json
{
  "url": "http://localhost:8000/master.m3u8?url=...&h=720",
  "source": "https://www.youtube.com/@AlekhbariahSY/live",
  "targetHeight": 720,
  "minHeight": 0,
  "cached": false,
  "demuxed": true,
  "video": { "formatId": "232", "height": 720, "fps": 30, "vcodec": "avc1.4D401F" },
  "audio": { "formatId": "234", "note": "Default, high" },
  "upstreamMaster": "https://manifest.googlevideo.com/api/manifest/hls_variant/..."
}
```

### `GET /master.m3u8` — HLS playlist with audio

Serves a multivariant playlist pairing the selected video rendition with an
audio rendition. Point a player straight at this.

```bash
curl "http://localhost:8000/master.m3u8?url=https://www.youtube.com/@AlekhbariahSY/live&h=720"
```

For a muxed stream there is nothing to assemble, so it 302-redirects to the
upstream playlist.

### `GET /playlist.m3u` — single-entry M3U channel list

Extra parameters: `name`, `logo`, `group`, `tvg_id`.

```bash
curl "http://localhost:8000/playlist.m3u?url=https://www.youtube.com/@AlekhbariahSY/live&name=Al%20Ekhbariah&group=News&tvg_id=ekh1&h=720"
```

### `GET /redirect.m3u8` — redirect, or an inline playlist

A muxed stream gets a 302 to the upstream manifest, as before. A demuxed
stream gets the generated playlist inline with a 200, since there is no single
upstream URL to point at. Either way the response is something a player can
open, so existing IPTV playlists keep working unchanged.

```bash
curl -L "http://localhost:8000/redirect.m3u8?url=https://www.youtube.com/@AlekhbariahSY/live&h=1080&min=720"
```

### `GET /` and `GET /healthz`

`/` is a dependency-free liveness probe that returns `OK`. `/healthz` reports
readiness and diagnostics, and is the first place to look when extraction
starts failing:

```json
{
  "status": "ok",
  "ytdlp": { "path": "/usr/local/bin/yt-dlp", "version": "2026.10.26" },
  "uptimeSeconds": 1042,
  "cache": { "size": 12, "hits": 480, "misses": 14 },
  "queue": { "active": 0, "queued": 0 },
  "inflight": 0
}
```

### Status codes

| Code | Meaning |
|---|---|
| `400` | `url` missing, malformed, or not `http(s)` |
| `401` | `API_TOKEN` is set and the request did not supply it |
| `403` | Host is not in `ALLOWED_HOSTS` |
| `404` | Channel not found, not live, private, or has no HLS stream |
| `429` | Caller hit the rate limit, **or** YouTube is demanding sign-in |
| `451` | Stream is geo-blocked for this server |
| `500` | `yt-dlp` is missing or not runnable |
| `502` | Extraction failed for another reason |
| `503` | Extraction queue is full |
| `504` | `yt-dlp` exceeded `YTDLP_TIMEOUT_MS` |

Error bodies are short, fixed strings. Full diagnostics — including the
`yt-dlp` command line and stderr — go to the server log only.

## Audio: why a playlist is generated

YouTube serves live streams as **demuxed** HLS. Every video rendition reports
`acodec: "none"`, and the audio arrives as separate audio-only renditions:

```
itag 234  audio only                      <- the sound lives here
itag 232  1280x720   avc1   acodec=none
itag 270  1920x1080  avc1   acodec=none
```

Handing a player one of those video renditions produces a **silent stream**.
There is also no top-level `hls_manifest_url` to fall back on: the
multivariant playlist appears only as `manifest_url` on the individual
formats.

So for a demuxed stream this server assembles its own multivariant playlist,
pinning the rendition that `h` and `min` selected and attaching the audio
track as an `EXT-X-MEDIA` group:

```m3u
#EXTM3U
#EXT-X-VERSION:4
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default, high",DEFAULT=YES,AUTOSELECT=YES,URI="https://...audio..."
#EXT-X-STREAM-INF:BANDWIDTH=2575970,RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="avc1.4D401F,mp4a.40.2",AUDIO="audio"
https://...video...
```

That keeps both properties: sound works, **and** the requested quality is
honoured. Pass `?upstream=1` to get YouTube's own multivariant playlist
instead - it also carries audio, but the player chooses the resolution, so
`h` and `min` no longer apply.

A **muxed** rendition (a VOD, or a live stream that is not demuxed) needs no
assembly and is handed out as a direct URL, exactly as before. `/hls.json`
reports which case you got, via its `demuxed` field.

## Quality selection

`h` is a **ceiling** and `min` is a **floor**; they compose rather than
conflict:

- `h=720` → best rendition at or below 720p
- `min=480` → never below 480p
- `h=1080&min=720` → 1080p when available, otherwise the best ≥ 720p

Within those bounds the ranking is: H.264 first (for TV and set-top
compatibility), then height, then bitrate. H.264 is a separate ranking stage,
so it can never promote a low-resolution rendition over a much higher one.

If nothing satisfies `min`, the best available rendition is served rather than
failing — a lower-quality stream beats a dark channel.

## Configuration

Every setting has a working default; see [`.env.example`](.env.example) for the
full annotated list.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Listen port |
| `LOG_LEVEL` | `info` | pino level |
| `ALLOWED_HOSTS` | YouTube hosts | Hostnames that may be extracted; empty disables the check |
| `API_TOKEN` | *(unset)* | Shared secret for extraction endpoints |
| `TRUST_PROXY` | `0` | Honour `X-Forwarded-For` (only behind your own proxy) |
| `PUBLIC_BASE_URL` | from request | Base URL for generated `/master.m3u8` links |
| `YTDLP_PATH` | auto-detect | Path to the binary |
| `YTDLP_TIMEOUT_MS` | `25000` | Hard kill for a stuck extraction |
| `YTDLP_CONCURRENCY` | `3` | Simultaneous `yt-dlp` processes |
| `YTDLP_QUEUE_LIMIT` | `50` | Queue depth before `503` |
| `YTDLP_AUTO_UPDATE` | `0` | Self-update `yt-dlp` on start |
| `YTDLP_COOKIES` | *(unset)* | Netscape cookie file |
| `YTDLP_PROXY` | *(unset)* | Proxy for `yt-dlp` |
| `YTDLP_EXTRACTOR_ARGS` | *(unset)* | Passed to `--extractor-args` |
| `CACHE_TTL_MS` | `240000` | Fallback TTL when a URL carries no expiry |
| `CACHE_MAX_TTL_MS` | `10800000` | Upper bound on any cache entry |
| `CACHE_EXPIRY_MARGIN_MS` | `60000` | Stop serving this long before expiry |
| `RATE_LIMIT_MAX` | `60` | Requests per window; `0` disables |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window |

### Caching

Resolved `googlevideo` URLs are signed and carry their own `expire` deadline.
The TTL is read from that value minus `CACHE_EXPIRY_MARGIN_MS`, so an entry is
retired before it can be handed out dead. A URL already inside the margin is
not cached at all. Without caching, every IPTV client poll spawned a fresh
`yt-dlp` process — the fastest route to being rate-limited by YouTube.

## Keeping yt-dlp current

**Most extraction failures are a stale `yt-dlp`.** YouTube changes its internals
every few weeks. Three independent mechanisms keep it fresh:

1. **Pinned at build.** `ARG YTDLP_VERSION` in the [Dockerfile](Dockerfile)
   makes a build reproducible. Dependabot raises a PR when a newer release
   appears.
2. **Scheduled rebuild.** The publish workflow runs weekly, so the published
   image never drifts far behind.
3. **Runtime self-update.** Set `YTDLP_AUTO_UPDATE=1` to check on every start.
   This writes to the binary, so it needs `read_only: false` in compose.

Check what is actually running with `curl localhost:8000/healthz`.

## When YouTube blocks the server

Datacenter and VPS IP ranges increasingly get `Sign in to confirm you're not a
bot`, which this server reports as **429**. In order of preference:

1. `YTDLP_PROXY` — route extraction through a residential proxy
2. `YTDLP_COOKIES` — mount a Netscape cookie file exported from a signed-in
   browser profile, read-only:
   ```yaml
   volumes:
     - ./cookies.txt:/run/secrets/cookies.txt:ro
   environment:
     YTDLP_COOKIES: /run/secrets/cookies.txt
   ```
3. `YTDLP_EXTRACTOR_ARGS` — try a different player client, e.g.
   `youtube:player_client=default,web_safari`

Raising `CACHE_TTL_MS` also helps, by making fewer requests in the first place.

## Security notes

- **Host allowlist.** `ALLOWED_HOSTS` is the control that stops this server
  being an SSRF proxy into your private network or a cloud metadata endpoint.
  Widen it deliberately; emptying it disables the check.
- **No shell, no flag injection.** `yt-dlp` is spawned via `execFile` with an
  argv array, and the URL is passed after a `--` separator, so it can never be
  read as an option. `--ignore-config` prevents any config file from being
  picked up.
- **No internal detail in responses.** Error bodies are fixed strings.
- **Unprivileged container.** Runs as uid 1000 with `cap_drop: ALL`,
  `no-new-privileges` and a read-only root filesystem.
- **Expose it carefully.** Set `API_TOKEN` if the server is reachable from the
  internet, and keep the rate limiter on.

## IPTV usage

Point your playlist at `/redirect.m3u8` so the player resolves a fresh manifest
on each tune-in:

```m3u
#EXTM3U
#EXTINF:-1 tvg-id="news1" tvg-logo="https://example.com/logo.png" group-title="News",News Channel
http://your-server:8000/redirect.m3u8?url=https://www.youtube.com/@newschannel/live&h=720
```

```bash
vlc "http://localhost:8000/redirect.m3u8?url=https://www.youtube.com/@channel/live"
ffmpeg -i "$(curl -s 'http://localhost:8000/hls_url?url=https://www.youtube.com/@channel/live')" -c copy out.mp4
```

## Project layout

```
index.js            bootstrap: config, logging, server, graceful shutdown
src/config.js       environment parsing
src/validate.js     URL allowlist, height parsing, M3U escaping
src/errors.js       HttpError plus yt-dlp failure -> status mapping
src/ytdlp.js        yt-dlp invocation, version check, self-update
src/select.js       format ranking and track-pair selection (pure)
src/playlist.js     builds the multivariant playlist that carries audio
src/cache.js        TTL cache and expiry derivation
src/limit.js        single-flight and concurrency semaphore
src/extractor.js    composes cache -> single-flight -> semaphore -> yt-dlp
src/routes.js       endpoints, auth, rate limiting, error mapping
src/app.js          Express app assembly
src/logger.js       pino setup
test/               vitest suites; no network or yt-dlp binary required
```

## Upgrading from 1.x

Behavioural changes worth knowing about:

- **`min` now works alongside `h`.** Previously `h` was applied as a *floor*,
  which made `min` unreachable whenever `h` was supplied and could silently
  return a rendition far below `min`. If you worked around that by omitting
  `min`, you can now use it as documented.
- **Errors are no longer all `404`.** A failed extraction returns `502`, a
  timeout `504`, a blocked host `403`, a bad `url` `400`. Clients that treated
  any non-200 as "offline" still work; clients that specifically checked for
  `404` should be updated.
- **Error bodies no longer contain `yt-dlp` output.** Read the server log, or
  `/healthz`, instead of parsing response text.
- **`ALLOWED_HOSTS` defaults to YouTube only.** Non-YouTube URLs that used to
  work now return `403` until you add the host.
- **A rate limit is on by default** (60 requests/minute). Set `RATE_LIMIT_MAX=0`
  to restore unlimited behaviour.
- **`yt-dlp-exec` is gone.** `yt-dlp` is now a real binary on `PATH`; set
  `YTDLP_PATH` if yours lives somewhere unusual.
- **Node 22+ required.** Node 18 and 20 are both end-of-life; the image runs
  Node 26 (LTS).
- **YouTube live now plays with audio.** A video-only rendition used to be
  returned, so streams were silent. `/hls_url`, `/hls.json` and
  `/playlist.m3u` now return a `/master.m3u8` URL on this server for
  demuxed streams, and `/redirect.m3u8` answers 200 with a playlist instead
  of a 302. If you stored a resolved googlevideo URL and replayed it, fetch a
  fresh one from `/hls_url` instead; add `?upstream=1` to get
  YouTube's own multivariant playlist URL (audio included, resolution chosen
  by the player).
- **Set `PUBLIC_BASE_URL`** when the server sits behind a proxy that rewrites
  the host, so generated playlist links stay reachable by your players.

## Requirements

- Node.js 22+ (26 recommended, and what the image runs)
- `yt-dlp` — bundled in the Docker image, no Python needed
- No `ffmpeg`: this server only resolves manifest URLs, it never transcodes

## License

MIT
