import { describe, expect, it } from "vitest";
import validateModule from "../src/validate.js";
import configModule from "../src/config.js";

const { validateUrl, parseHeight, m3uAttr, m3uText } = validateModule;
const { DEFAULT_ALLOWED_HOSTS } = configModule;

const hosts = DEFAULT_ALLOWED_HOSTS;

const expectStatus = (fn, status) => {
  try {
    fn();
  } catch (err) {
    expect(err.status).toBe(status);
    return err;
  }
  throw new Error("expected the call to throw");
};

describe("validateUrl", () => {
  it("accepts the YouTube URL shapes the README documents", () => {
    for (const url of [
      "https://www.youtube.com/@AlekhbariahSY/live",
      "https://youtube.com/watch?v=abc123",
      "https://youtu.be/abc123",
      "https://m.youtube.com/@x/live",
      "https://music.youtube.com/watch?v=abc",
    ]) {
      expect(validateUrl(url, hosts)).toContain("http");
    }
  });

  it("rejects a missing or blank url with 400", () => {
    expectStatus(() => validateUrl(undefined, hosts), 400);
    expectStatus(() => validateUrl("   ", hosts), 400);
  });

  it("rejects anything that is not a parseable absolute url", () => {
    expectStatus(() => validateUrl("not a url", hosts), 400);
    expectStatus(() => validateUrl("/etc/passwd", hosts), 400);
    expectStatus(() => validateUrl("www.youtube.com/@x/live", hosts), 400);
  });

  // The value used to be handed to yt-dlp as its first argv entry, so a
  // leading dash was read as an option.
  it("rejects values that look like command-line flags", () => {
    expectStatus(() => validateUrl("--config-location=/tmp/evil.conf", hosts), 400);
    expectStatus(() => validateUrl("-o/tmp/out", hosts), 400);
    expectStatus(() => validateUrl("--exec=touch /tmp/pwn", hosts), 400);
  });

  it("rejects non-http schemes", () => {
    expectStatus(() => validateUrl("file:///etc/passwd", hosts), 400);
    expectStatus(() => validateUrl("ftp://example.com/x", hosts), 400);
    expectStatus(() => validateUrl("javascript:alert(1)", hosts), 400);
  });

  // Closing the open-proxy / SSRF hole.
  it("rejects hosts outside the allowlist with 403", () => {
    expectStatus(() => validateUrl("http://169.254.169.254/latest/meta-data/", hosts), 403);
    expectStatus(() => validateUrl("http://localhost:8000/", hosts), 403);
    expectStatus(() => validateUrl("http://10.0.0.5/admin", hosts), 403);
    expectStatus(() => validateUrl("https://evil.example.com/", hosts), 403);
  });

  it("is not fooled by a lookalike host", () => {
    expectStatus(() => validateUrl("https://youtube.com.evil.net/x", hosts), 403);
    expectStatus(() => validateUrl("https://notyoutube.com/x", hosts), 403);
  });

  it("matches hosts case-insensitively", () => {
    expect(validateUrl("https://WWW.YouTube.COM/@x/live", hosts)).toContain("youtube.com");
  });

  it("allows every host when the allowlist is empty", () => {
    expect(validateUrl("https://evil.example.com/x", [])).toContain("evil.example.com");
  });
});

describe("parseHeight", () => {
  it("parses sane values", () => {
    expect(parseHeight("720")).toBe(720);
    expect(parseHeight("1080")).toBe(1080);
  });

  it("ignores junk instead of failing the request", () => {
    for (const value of [undefined, "", "abc", "0", "-5", "NaN"]) {
      expect(parseHeight(value)).toBeNull();
    }
  });

  it("caps absurd values", () => {
    expect(parseHeight("999999")).toBe(4320);
  });
});

describe("m3u escaping", () => {
  it("strips quotes and newlines from attributes", () => {
    const injected = 'x" group-title="Hacked';
    expect(m3uAttr(injected)).not.toContain('"');
  });

  // An M3U directive is only honoured at the start of a line, so collapsing
  // newlines is what actually prevents a forged entry; an inert "#EXTINF"
  // substring left mid-line cannot become a directive.
  it("prevents a forged extra playlist entry", () => {
    const injected = "Channel\n#EXTINF:-1,Fake\nhttp://evil/stream.m3u8";
    const safe = m3uText(injected);
    expect(safe).not.toMatch(/[\r\n]/);
    expect(safe.split("\n")).toHaveLength(1);
    expect(safe.startsWith("#")).toBe(false);
  });

  it("strips commas from the display name", () => {
    expect(m3uText("News, Live")).toBe("News  Live");
  });

  it("handles null and undefined", () => {
    expect(m3uAttr(null)).toBe("");
    expect(m3uText(undefined)).toBe("");
  });
});
