import { describe, expect, it } from "vitest";
import {
  ACTION_APPROVE,
  ACTION_REJECT,
  REJECT_BLOCK,
  approvalDecidedMessage,
  approvalMessage,
  channelDigestMessage,
  commentMessage,
  dealSummaryMessage,
  noticeMessage,
  rejectModal,
  teamPostMessage,
} from "../blocks";

const APP = "https://rso.example.com";
const ID = "0b5c8a7e-2f1d-4c3b-9a8e-1234567890ab";
const SECRET_NAME = "Paradium Secret Merger";
const json = (x: unknown) => JSON.stringify(x);

const card = {
  id: ID,
  kindLabel: "Probability override",
  label: `${SECRET_NAME} · NET`,
  requesterName: "Will",
  detail: "Requested 90% · from 50%",
  note: "Board said yes",
  waiting: "waiting 3h",
  dueLabel: "due in 21h",
  restricted: false,
  href: `/tasks?tab=approvals&approval=${ID}`,
};

describe("approvalMessage", () => {
  it("has Approve / Reject buttons carrying the approval id", () => {
    const m = approvalMessage(card, APP);
    const actions = m.blocks.find((b) => b.type === "actions") as { elements: { action_id: string; value?: string; url?: string }[] };
    expect(actions.elements.map((e) => e.action_id)).toEqual([ACTION_APPROVE, ACTION_REJECT, "open_app"]);
    expect(actions.elements[0]!.value).toBe(ID);
    expect(actions.elements[2]!.url).toBe(`${APP}/tasks?tab=approvals&approval=${ID}`);
    expect(m.text).toContain("Probability override");
  });
  it("restricted approvals carry no subject, note, detail or buttons", () => {
    const m = approvalMessage({ ...card, restricted: true }, APP);
    const s = json(m);
    expect(s).not.toContain(SECRET_NAME);
    expect(s).not.toContain("Board said yes");
    expect(s).not.toContain("90%");
    expect(s).not.toContain(ACTION_APPROVE);
    expect(s).toContain("restricted");
  });
  it("labels escalations and escapes user text", () => {
    const m = approvalMessage({ ...card, escalated: true, note: "<!channel> look" }, APP);
    expect(m.text).toMatch(/^Escalated approval/);
    expect(json(m)).not.toContain("<!channel>");
  });
});

describe("approvalDecidedMessage / rejectModal", () => {
  it("replaces buttons with the outcome", () => {
    const m = approvalDecidedMessage({ kindLabel: "Proposal", label: "Proposal v2 · Arena", status: "approved", deciderName: "Aly", restricted: false, href: "/tasks" }, APP);
    expect(json(m)).not.toContain(ACTION_APPROVE);
    expect(m.text).toBe("Approved by Aly: Proposal");
  });
  it("restricted outcome hides the subject", () => {
    expect(json(approvalDecidedMessage({ kindLabel: "Proposal", label: SECRET_NAME, status: "rejected", deciderName: "Aly", restricted: true, href: "/tasks", note: "too low" }, APP))).not.toContain(SECRET_NAME);
  });
  it("modal requires a reason and echoes metadata", () => {
    const v = rejectModal({ kindLabel: "Stage gate", label: "Deal → Won", restricted: false, metadata: '{"a":"x"}' }) as { private_metadata: string; blocks: { block_id?: string; element?: { min_length?: number } }[] };
    expect(v.private_metadata).toBe('{"a":"x"}');
    expect(v.blocks.find((b) => b.block_id === REJECT_BLOCK)?.element?.min_length).toBe(1);
  });
});

describe("channel posts", () => {
  it("never builds a post for restricted comments or team posts", () => {
    expect(commentMessage({ authorName: "A", dealName: SECRET_NAME, body: "x", href: "/deals/1", restricted: true }, APP)).toBeNull();
    expect(teamPostMessage({ kind: "win", title: SECRET_NAME, body: null, authorName: "A", href: "/team", restricted: true }, APP)).toBeNull();
  });
  it("never posts playbook clips (customer quotes)", () => {
    expect(teamPostMessage({ kind: "clip", title: "Quote", body: "…", authorName: "A", href: "/team", restricted: false }, APP)).toBeNull();
  });
  it("renders each post kind (review recaps are announcements tagged review)", () => {
    const base = { title: "T", body: "B", authorName: "Chris", href: "/team", restricted: false };
    expect(teamPostMessage({ ...base, kind: "loss" }, APP)?.text).toBe("Loss: T");
    expect(teamPostMessage({ ...base, kind: "announcement" }, APP)?.text).toBe("Announcement: T");
    expect(teamPostMessage({ ...base, kind: "announcement", tags: ["review", "review:x"] }, APP)?.text).toBe("Pipeline review recap: T");
    expect(teamPostMessage({ ...base, kind: "announcement", tags: ["review"], restricted: true }, APP)).toBeNull();
  });
  it("builds win posts and comment mirrors", () => {
    expect(teamPostMessage({ kind: "win", title: "TheStreet signed", body: "Story", authorName: "Chris", href: "/team", restricted: false }, APP)?.text).toBe("Win: TheStreet signed");
    const c = commentMessage({ authorName: "Chris", dealName: "TheStreet", body: "Sent the contract", href: "/deals/1", restricted: false }, APP);
    expect(json(c)).toContain("Sent the contract");
    expect(json(c)).toContain(`${APP}/deals/1`);
  });
  it("digest lists only what it is given", () => {
    const d = channelDigestMessage({ dateLabel: "Thu, 1 Oct", approvalsPending: 4, approvalsOverdue: 1, wins: [{ name: "TheStreet", href: "/deals/1" }], newDeals: 3 }, APP);
    const s = json(d);
    expect(s).toContain("TheStreet");
    expect(s).toContain("1 overdue");
  });
});

describe("dealSummaryMessage / noticeMessage", () => {
  it("omits fields that were filtered out (field security)", () => {
    const m = dealSummaryMessage(
      {
        name: "TheStreet",
        accountName: "TheStreet Inc",
        pipelineKey: "NET",
        stageName: "Proposal",
        status: "open",
        ownerName: null,
        value: null,
        expectedClose: null,
        nextStep: "Send contract",
        nextStepDue: "Oct 3",
        nextStepOverdue: false,
        health: null,
        href: "/deals/1",
      },
      APP,
      [{ name: "TheStreet Pro", href: "/deals/2" }],
    );
    const s = json(m);
    expect(s).not.toContain("*Value*");
    expect(s).not.toContain("*Health*");
    expect(s).toContain("Send contract");
    expect(s).toContain("TheStreet Pro");
  });
  it("notice links only into the app", () => {
    expect(json(noticeMessage({ kind: "alert", title: "Hi", href: "https://evil.com" }, APP))).not.toContain("evil.com");
    expect(noticeMessage({ kind: "alert", title: "Stalled", severity: "critical", href: "/deals/1" }, APP).text).toBe("Critical · Stalled");
  });
});
