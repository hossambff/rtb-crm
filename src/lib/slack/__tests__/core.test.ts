import { describe, expect, it } from "vitest";
import {
  ReplayGuard,
  appLink,
  approvalIdFromHref,
  escapeMrkdwn,
  isSlackResponseUrl,
  normalizeChannel,
  parseRtbCommand,
  signSlackBody,
  validateBotToken,
  validateSigningSecret,
  verifySlackSignature,
} from "../core";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5".replace(/[yz]/g, "0");
const BODY = "token=x&team_id=T0001&command=%2Frtb&text=deal+arena";
const NOW = 1_790_000_000;

describe("verifySlackSignature", () => {
  const ts = String(NOW);
  const sig = signSlackBody(SECRET, ts, BODY);

  it("accepts a correctly signed, fresh request", () => {
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sig, rawBody: BODY, nowSec: NOW })).toEqual({ ok: true });
  });
  it("accepts within the 5-minute window either way", () => {
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sig, rawBody: BODY, nowSec: NOW + 300 }).ok).toBe(true);
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sig, rawBody: BODY, nowSec: NOW - 300 }).ok).toBe(true);
  });
  it("rejects stale or future timestamps (replay window)", () => {
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sig, rawBody: BODY, nowSec: NOW + 301 })).toEqual({ ok: false, reason: "stale" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sig, rawBody: BODY, nowSec: NOW - 301 })).toEqual({ ok: false, reason: "stale" });
  });
  it("rejects a tampered body, a different timestamp, or the wrong secret", () => {
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sig, rawBody: BODY + "&x=1", nowSec: NOW })).toEqual({ ok: false, reason: "mismatch" });
    const ts2 = String(NOW + 1);
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts2, signature: sig, rawBody: BODY, nowSec: NOW })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySlackSignature({ signingSecret: SECRET.replace("8", "9"), timestamp: ts, signature: sig, rawBody: BODY, nowSec: NOW })).toEqual({ ok: false, reason: "mismatch" });
  });
  it("rejects missing or malformed inputs without throwing", () => {
    expect(verifySlackSignature({ signingSecret: "", timestamp: ts, signature: sig, rawBody: BODY, nowSec: NOW })).toEqual({ ok: false, reason: "missing" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: null, signature: sig, rawBody: BODY, nowSec: NOW })).toEqual({ ok: false, reason: "missing" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: undefined, rawBody: BODY, nowSec: NOW })).toEqual({ ok: false, reason: "missing" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: "12abc", signature: sig, rawBody: BODY, nowSec: NOW })).toEqual({ ok: false, reason: "malformed" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: "v1=" + sig.slice(3), rawBody: BODY, nowSec: NOW })).toEqual({ ok: false, reason: "malformed" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sig.slice(0, -1), rawBody: BODY, nowSec: NOW })).toEqual({ ok: false, reason: "malformed" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sig.toUpperCase().replace("V0=", "v0="), rawBody: BODY, nowSec: NOW }).ok).toBe(false);
  });
  it("matches Slack's documented example", () => {
    // https://api.slack.com/authentication/verifying-requests-from-slack
    const body =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    const r = verifySlackSignature({
      signingSecret: "8f742231b10e8888abcd99yyyzzz85a5",
      timestamp: "1531420618",
      signature: "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
      rawBody: body,
      nowSec: 1531420618,
    });
    expect(r).toEqual({ ok: true });
  });
});

describe("ReplayGuard", () => {
  it("accepts a key once inside the TTL, again after it expires", () => {
    const g = new ReplayGuard(1000, 10);
    expect(g.firstSeen("a", 0)).toBe(true);
    expect(g.firstSeen("a", 500)).toBe(false);
    expect(g.firstSeen("a", 1501)).toBe(true);
  });
  it("stays bounded", () => {
    const g = new ReplayGuard(10_000, 3);
    for (let i = 0; i < 10; i++) g.firstSeen(`k${i}`, i);
    expect(g.firstSeen("k9", 20)).toBe(false);
    expect(g.firstSeen("k0", 21)).toBe(true); // evicted
  });
});

describe("credential validation", () => {
  it("bot tokens", () => {
    // assembled at runtime so secret scanners don't mistake the fixture for a real credential
    const fakeBot = ["xoxb", "1".repeat(12), "2".repeat(12), "x".repeat(24)].join("-");
    expect(validateBotToken(fakeBot)).toBeNull();
    expect(validateBotToken("")).toMatch(/Paste/);
    expect(validateBotToken("xoxp-1234")).toMatch(/user token/);
    expect(validateBotToken("xapp-1-A0")).toMatch(/app-level/);
    expect(validateBotToken("hello")).toMatch(/xoxb-/);
  });
  it("signing secrets", () => {
    expect(validateSigningSecret("0123456789abcdef0123456789abcdef")).toBeNull();
    expect(validateSigningSecret("0123")).toMatch(/32/);
    expect(validateSigningSecret("")).toMatch(/Paste/);
  });
});

describe("normalizeChannel", () => {
  it("accepts IDs and names", () => {
    expect(normalizeChannel("C0123ABCD")).toEqual({ value: "C0123ABCD" });
    expect(normalizeChannel("#Sales-Wins")).toEqual({ value: "#sales-wins" });
    expect(normalizeChannel("wins")).toEqual({ value: "#wins" });
    expect(normalizeChannel("  ")).toEqual({ value: null });
  });
  it("rejects junk", () => {
    expect("error" in normalizeChannel("#bad channel")).toBe(true);
    expect("error" in normalizeChannel("<!channel>")).toBe(true);
  });
});

describe("isSlackResponseUrl", () => {
  it("only allows https://hooks.slack.com", () => {
    expect(isSlackResponseUrl("https://hooks.slack.com/actions/T1/2/abc")).toBe(true);
    expect(isSlackResponseUrl("http://hooks.slack.com/actions/T1/2/abc")).toBe(false);
    expect(isSlackResponseUrl("https://hooks.slack.com.evil.com/x")).toBe(false);
    expect(isSlackResponseUrl("https://evil.com/?hooks.slack.com")).toBe(false);
    expect(isSlackResponseUrl("https://user@hooks.slack.com/x")).toBe(false);
    expect(isSlackResponseUrl("https://hooks.slack.com:8443/x")).toBe(false);
    expect(isSlackResponseUrl(42)).toBe(false);
  });
});

describe("parseRtbCommand", () => {
  it("parses deal lookups", () => {
    expect(parseRtbCommand("deal  Arena   Group")).toEqual({ kind: "deal", query: "Arena Group" });
    expect(parseRtbCommand("DEAL thestreet")).toEqual({ kind: "deal", query: "thestreet" });
    expect(parseRtbCommand("d ny post")).toEqual({ kind: "deal", query: "ny post" });
  });
  it("help, approvals, unknown", () => {
    expect(parseRtbCommand("")).toEqual({ kind: "help" });
    expect(parseRtbCommand("help")).toEqual({ kind: "help" });
    expect(parseRtbCommand("deal")).toEqual({ kind: "help" });
    expect(parseRtbCommand("deal x")).toEqual({ kind: "help" });
    expect(parseRtbCommand("approvals")).toEqual({ kind: "approvals" });
    expect(parseRtbCommand("dance")).toEqual({ kind: "unknown", text: "dance" });
  });
  it("caps the query length", () => {
    const r = parseRtbCommand(`deal ${"a".repeat(500)}`);
    expect(r.kind === "deal" && r.query.length).toBe(80);
  });
});

describe("mrkdwn + links", () => {
  it("escapes control characters (no <!channel> pings, no fake links)", () => {
    expect(escapeMrkdwn("<!channel> & <https://x|y>")).toBe("&lt;!channel&gt; &amp; &lt;https://x|y&gt;");
  });
  it("appLink only builds same-origin links from relative paths", () => {
    expect(appLink("https://app.example.com", "/deals/1")).toBe("https://app.example.com/deals/1");
    expect(appLink("https://app.example.com", "//evil.com/x")).toBeNull();
    expect(appLink("https://app.example.com", "https://evil.com")).toBeNull();
    expect(appLink("https://app.example.com", null)).toBeNull();
  });
  it("extracts approval ids from notification hrefs", () => {
    const id = "0b5c8a7e-2f1d-4c3b-9a8e-1234567890ab";
    expect(approvalIdFromHref(`/tasks?tab=approvals&approval=${id}`)).toBe(id);
    expect(approvalIdFromHref("/tasks?tab=approvals")).toBeNull();
    expect(approvalIdFromHref(`/deals/x?approval=${id}`)).toBeNull();
    expect(approvalIdFromHref("/tasks?approval=not-a-uuid")).toBeNull();
  });
});
