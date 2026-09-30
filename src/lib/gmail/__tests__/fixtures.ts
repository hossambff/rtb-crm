import type { GmailMessage } from "../parse";

const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Inbound multipart/alternative message from a prospect with quoted history. */
export const inboundMultipart: GmailMessage = {
  id: "18f1a",
  threadId: "t-100",
  historyId: "9001",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "Thanks for the call. I&#39;ll send the signed NDA by Friday.",
  internalDate: String(Date.parse("2026-09-30T14:00:00Z")),
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: '"Jane Doe" <Jane.Doe@Reach.co.uk>' },
      { name: "To", value: "Me <me@roundtable.io>, \"Smith, Bob\" <bob@reach.co.uk>" },
      { name: "Cc", value: "legal@reach.co.uk" },
      { name: "Subject", value: "Re: Platform partnership" },
      { name: "Date", value: "Wed, 30 Sep 2026 14:00:00 +0000" },
      { name: "Message-ID", value: "<CAF123@mail.gmail.com>" },
      { name: "References", value: "<CAA1@mail.gmail.com>" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: {
          data: b64u(
            "Hi,\n\nThanks for the call. I'll send the signed NDA by Friday. Our legal team is reviewing the MSA.\nCould you send over the pricing deck?\n\nOn Tue, Sep 29, 2026 at 10:00 AM Me <me@roundtable.io> wrote:\n> We'll share the pro forma next week.\n",
          ),
        },
      },
      { mimeType: "text/html", body: { data: b64u("<p>Hi,</p><p>HTML version</p>") } },
    ],
  },
};

/** HTML-only outbound message with an attachment part. */
export const outboundHtmlOnly: GmailMessage = {
  id: "18f1b",
  threadId: "t-100",
  labelIds: ["SENT"],
  internalDate: String(Date.parse("2026-09-30T16:00:00Z")),
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "me@roundtable.io" },
      { name: "To", value: "jane.doe@reach.co.uk" },
      { name: "Subject", value: "Re: Platform partnership" },
    ],
    parts: [
      {
        mimeType: "text/html",
        body: { data: b64u("<div>Hi Jane,<br>We&#39;ll send the proposal tomorrow.</div><style>.x{}</style><ul><li>One</li></ul>") },
      },
      { mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: "att-1", size: 1000 } },
    ],
  },
};

export const oooMessage = {
  text: "I am currently out of the office with limited access to email and will return on October 6.",
  subject: "Automatic reply: Platform partnership",
};
