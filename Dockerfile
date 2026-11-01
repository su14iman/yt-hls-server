# syntax=docker/dockerfile:1

# Node 20+ on Debian 12. The previous base was node:18-bullseye: Node 18 is
# end-of-life and bullseye ships Python 3.9, which current yt-dlp no longer
# supports.
FROM node:26-bookworm-slim

# Pin the extractor so an image build is reproducible, and so a bump is a
# visible one-line change that Renovate/Dependabot can raise a PR for.
ARG YTDLP_VERSION=2026.10.26
ARG TARGETARCH

# The *_linux* release assets are self-contained builds with Python bundled in,
# so the image needs no python3, no pip and no system interpreter at all.
# The plain "yt-dlp" asset is a Python zipapp and would reintroduce that
# dependency - do not switch to it.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    case "${TARGETARCH}" in \
      amd64) asset=yt-dlp_linux ;; \
      arm64) asset=yt-dlp_linux_aarch64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 --retry-delay 2 \
      -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}"; \
    chmod 0755 /usr/local/bin/yt-dlp; \
    /usr/local/bin/yt-dlp --version

WORKDIR /app

# Dependencies are copied and installed first so a source-only change does not
# invalidate the npm layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./
COPY src ./src

# The self-contained yt-dlp build is a PyInstaller bundle: on every run it
# unpacks ~90MB of libraries into TMPDIR and then maps them executable. That
# needs a writable, exec-able directory, which a tmpfs mounted with Docker's
# default noexec cannot provide. Giving yt-dlp its own directory lets /tmp stay
# noexec - see the tmpfs entries in docker-compose.yml.
#
# The chown covers a plain `docker run` with no tmpfs mounted. When compose
# does mount a tmpfs here it replaces this directory wholesale, ownership
# included, which is why that mount has to carry uid/gid of its own.
RUN mkdir -p /var/tmp/ytdlp && chown node:node /var/tmp/ytdlp

ENV NODE_ENV=production \
    PORT=8000 \
    TMPDIR=/var/tmp/ytdlp

# node:* images ship an unprivileged "node" user (uid 1000).
USER node

EXPOSE 8000

# Declared here as well as in compose, so `docker run` gets it too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so the process is PID 1 and receives SIGTERM directly; index.js
# handles it and drains in-flight requests.
CMD ["node", "index.js"]
