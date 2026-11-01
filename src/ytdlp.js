// src/ytdlp.js
// Direct yt-dlp invocation, replacing the abandoned `yt-dlp-exec` wrapper.
//
// Two things matter here:
//   1. The URL is passed after a `--` separator, so it can never be parsed as
//      an option. `yt-dlp-exec` put the URL first, which allowed a request to
//      inject yt-dlp flags (e.g. --config-location).
//   2. execFile is used without a shell, so arguments are passed as an argv
//      array and never re-parsed by /bin/sh.

"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");

const execFileAsync = promisify(execFile);

const CANDIDATE_PATHS = ["/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp"];
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024; // live channel JSON can be large

function resolveBinary(configuredPath) {
  if (configuredPath) return configuredPath;
  for (const candidate of CANDIDATE_PATHS) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return "yt-dlp"; // fall back to PATH lookup
}

function buildArgs(url, config) {
  const args = [
    "--dump-single-json",
    "--no-warnings",
    "--no-playlist",
    "--no-progress",
    "--ignore-config", // never read a yt-dlp config file we do not control
    "--socket-timeout",
    String(config.ytdlpSocketTimeout),
    "--retries",
    String(config.ytdlpRetries),
  ];

  if (config.ytdlpCookies) args.push("--cookies", config.ytdlpCookies);
  if (config.ytdlpProxy) args.push("--proxy", config.ytdlpProxy);
  if (config.ytdlpExtractorArgs) args.push("--extractor-args", config.ytdlpExtractorArgs);

  // Everything after `--` is positional, whatever it looks like.
  args.push("--", url);
  return args;
}

function createYtdlp(config, logger) {
  const binary = resolveBinary(config.ytdlpPath);

  async function dumpJson(url) {
    const args = buildArgs(url, config);
    logger.debug({ binary, url }, "running yt-dlp");

    const { stdout } = await execFileAsync(binary, args, {
      timeout: config.ytdlpTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: { ...process.env, LC_ALL: "C" },
    });

    return JSON.parse(stdout);
  }

  async function version() {
    try {
      const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 10000 });
      return stdout.trim();
    } catch (err) {
      logger.warn({ err: err.message }, "could not read yt-dlp version");
      return null;
    }
  }

  // The self-contained release builds can replace themselves in place, which
  // keeps a long-lived container current between image rebuilds.
  async function selfUpdate() {
    try {
      const { stdout } = await execFileAsync(binary, ["--update-to", "stable"], {
        timeout: 120000,
      });
      logger.info({ output: stdout.trim() }, "yt-dlp self-update finished");
      return true;
    } catch (err) {
      // A failed update must never stop the server from starting.
      logger.warn({ err: err.message }, "yt-dlp self-update failed, continuing");
      return false;
    }
  }

  return { binary, dumpJson, version, selfUpdate };
}

module.exports = { createYtdlp, buildArgs, resolveBinary };
