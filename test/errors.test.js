import { describe, expect, it } from "vitest";
import errorsModule from "../src/errors.js";

const { HttpError, toHttpError } = errorsModule;

// Shaped like a rejected execFile promise.
const execFailure = (stderr, extra = {}) =>
  Object.assign(new Error("Command failed with exit code 1"), { stderr, ...extra });

describe("toHttpError", () => {
  it("passes an HttpError through untouched", () => {
    const original = new HttpError(403, "nope");
    expect(toHttpError(original)).toBe(original);
  });

  it("maps a killed process to 504", () => {
    const err = toHttpError(execFailure("", { killed: true }));
    expect(err.status).toBe(504);
    expect(err.message).toMatch(/timed out/);
  });

  it("maps a missing binary to 500", () => {
    const err = toHttpError(Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" }));
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/not found on this server/);
  });

  // This is the exact failure that started the whole exercise.
  it("maps the channel-tab 404 to 404", () => {
    const err = toHttpError(
      execFailure(
        "ERROR: [youtube:tab] @channel: Unable to download API page: HTTP Error 404: Not Found",
      ),
    );
    expect(err.status).toBe(404);
    expect(err.message).toBe("channel or video not found");
  });

  it("maps an offline channel to 404", () => {
    const err = toHttpError(execFailure("ERROR: The channel is not currently live"));
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/not live/);
  });

  it("maps bot-detection to 429 so the cause is actionable", () => {
    const err = toHttpError(
      execFailure("ERROR: Sign in to confirm you're not a bot. Use --cookies-from-browser"),
    );
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/cookies or a proxy/);
  });

  it("maps a geo block to 451", () => {
    const err = toHttpError(
      execFailure("ERROR: The uploader has not made this video available in your country"),
    );
    expect(err.status).toBe(451);
  });

  it("maps malformed json to 502", () => {
    expect(toHttpError(new SyntaxError("Unexpected end of JSON input")).status).toBe(502);
  });

  it("defaults to 502 rather than 404 for an unknown failure", () => {
    // The old code answered 404 for everything, which hid real outages.
    expect(toHttpError(execFailure("ERROR: something entirely new")).status).toBe(502);
  });

  // The raw text carries the full command line, binary paths and any
  // --cookies argument; none of it may reach the client.
  it("never leaks the command line or internal paths", () => {
    const raw =
      "Command failed with exit code 1: /app/node_modules/yt-dlp-exec/bin/yt-dlp " +
      "https://www.youtube.com/@channel/live --dump-single-json --cookies /run/secrets/cookies.txt";
    const err = toHttpError(execFailure(raw));
    expect(err.message).not.toContain("/app/");
    expect(err.message).not.toContain("--dump-single-json");
    expect(err.message).not.toContain("cookies.txt");
    expect(err.message).toBe("extraction failed");
  });
});
