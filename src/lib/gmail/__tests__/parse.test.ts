import { describe, expect, it } from "vitest";
import { computeAwaiting, htmlToText, messageDirection, parseAddressList, parseGmailMessage, shouldSkipLabels, stripQuoted } from "../parse";
import { buildRawEmail, buildReferences, encodeHeaderValue, replySubject } from "../mime";
import { inboundMultipart, outboundHtmlOnly } from "./fixtures";

describe("parseGmailMessage", () => {
  it("parses headers, addresses and prefers text/plain", () => {
    const p = parseGmailMessage(inboundMultipart);
    expect(p.from).toBe("jane.doe@reach.co.uk");
    expect(p.fromName).toBe("Jane Doe");
    expect(p.to).toEqual(["me@roundtable.io", "bob@reach.co.uk"]);
    expect(p.cc).toEqual(["legal@reach.co.uk"]);
    expect(p.subject).toBe("Re: Platform partnership");
    expect(p.messageIdHeader).toBe("<CAF123@mail.gmail.com>");
    expect(p.sentAt?.toISOString()).toBe("2026-09-30T14:00:00.000Z");
    expect(p.bodyText).toContain("I'll send the signed NDA by Friday.");
    expect(p.bodyText).not.toContain("HTML version");
  });
  it("falls back to stripped HTML and ignores attachments", () => {
    const p = parseGmailMessage(outboundHtmlOnly);
    expect(p.bodyText).toContain("We'll send the proposal tomorrow.");
    expect(p.bodyText).toContain("• One");
    expect(p.bodyText).not.toContain("<div>");
    expect(p.bodyText).not.toContain(".x{}");
  });
});

describe("helpers", () => {
  it("parses quoted address lists", () => {
    expect(parseAddressList('"Doe, Jane" <j@x.com>, b@y.com, b@y.com')).toEqual(["j@x.com", "b@y.com"]);
    expect(parseAddressList(null)).toEqual([]);
  });
  it("html to text decodes entities", () => {
    expect(htmlToText("<p>A &amp; B&nbsp;&#39;C&#39;</p>")).toBe("A & B 'C'");
  });
  it("strips quoted history", () => {
    const body = parseGmailMessage(inboundMultipart).bodyText;
    const s = stripQuoted(body);
    expect(s).toContain("signed NDA");
    expect(s).not.toContain("pro forma");
    expect(stripQuoted("New text\n-----Original Message-----\nold")).toBe("New text");
    expect(stripQuoted("Hi\n\nFrom: A <a@x.com>\nSent: Monday\nTo: B")).toBe("Hi");
  });
  it("direction and labels", () => {
    expect(messageDirection({ from: "me@roundtable.io", labelIds: [] }, ["Me@Roundtable.io"])).toBe("outbound");
    expect(messageDirection({ from: "x@y.com", labelIds: ["SENT"] }, ["me@roundtable.io"])).toBe("outbound");
    expect(messageDirection({ from: "x@y.com", labelIds: ["INBOX"] }, ["me@roundtable.io"])).toBe("inbound");
    expect(shouldSkipLabels(["INBOX", "SPAM"])).toBe(true);
    expect(shouldSkipLabels(["INBOX"])).toBe(false);
  });
  it("awaiting reply from the last message", () => {
    const t = (s: string) => new Date(s);
    expect(computeAwaiting([{ direction: "outbound", sentAt: t("2026-09-01") }, { direction: "inbound", sentAt: t("2026-09-02") }])).toBe("us");
    expect(computeAwaiting([{ direction: "inbound", sentAt: t("2026-09-01") }, { direction: "outbound", sentAt: t("2026-09-02") }])).toBe("them");
    expect(computeAwaiting([{ direction: "inbound", sentAt: t("2026-09-02"), intent: "ooo" }])).toBe("none");
    expect(computeAwaiting([])).toBe("none");
  });
});

describe("mime", () => {
  it("builds a threaded reply", () => {
    const raw = buildRawEmail({
      from: "me@roundtable.io",
      fromName: "Me Rep",
      to: ["jane.doe@reach.co.uk"],
      cc: ["bob@reach.co.uk"],
      subject: replySubject("Platform partnership"),
      body: "Hi Jane,\nThanks!",
      inReplyTo: "<CAF123@mail.gmail.com>",
      references: buildReferences("<CAA1@mail.gmail.com>", "<CAF123@mail.gmail.com>"),
    });
    expect(raw).toContain('From: "Me Rep" <me@roundtable.io>\r\n');
    expect(raw).toContain("Cc: bob@reach.co.uk\r\n");
    expect(raw).toContain("Subject: Re: Platform partnership\r\n");
    expect(raw).toContain("In-Reply-To: <CAF123@mail.gmail.com>\r\n");
    expect(raw).toContain("References: <CAA1@mail.gmail.com> <CAF123@mail.gmail.com>\r\n");
    const body = raw.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Hi Jane,\r\nThanks!");
  });
  it("prevents header injection and encodes non-ASCII", () => {
    const raw = buildRawEmail({ from: "me@x.com", to: ["a@b.com\r\nBcc: evil@x.com"], subject: "Café\r\nBcc: evil@x.com", body: "x" });
    expect(raw).not.toMatch(/\r\nBcc:/);
    expect(encodeHeaderValue("Café")).toMatch(/^=\?UTF-8\?B\?/);
    expect(replySubject("RE: hi")).toBe("RE: hi");
  });
});
