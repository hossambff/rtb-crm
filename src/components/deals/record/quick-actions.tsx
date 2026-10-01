"use client";
import * as React from "react";
import { ListPlus, Loader2, Mail, PhoneCall } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createDealTask, logDealActivity } from "@/lib/deals/actions";
import { PRIORITY_LABELS, type ContactLite, type UserLite } from "@/lib/deals/types";
import { CopilotButton } from "@/components/copilot";
import { EmailComposer } from "@/components/inbox/email-composer";
import { EnrichButton } from "@/components/scout/enrich-button";
import { useRun } from "./use-run";
import { MoreActions } from "./more-actions";

function nowLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * CARD-1 quick actions (QA MAJ-10): the visible row is Log · Email · Task · Ask Copilot · More. Everything else — share,
 * hand off, request help (passed in as `more`) and find executives — sits in the "More" overflow.
 * Proposals live in the Docs tab and call uploads in the Activity tab's "Calls & transcripts" panel (no duplicates).
 */
export function QuickActions({
  dealId,
  dealName,
  email,
  enrich,
  contacts,
  users,
  ownerId,
  currentUserId,
  canLog,
  canTask,
  canUseAi,
  more,
}: {
  dealId: string;
  contacts: ContactLite[];
  users: UserLite[];
  ownerId: string | null;
  currentUserId: string;
  canLog: boolean;
  canTask: boolean;
  canUseAi: boolean;
  /** Server-rendered secondary actions (share / hand off / request help) shown in the overflow menu. */
  more?: React.ReactNode;
  dealName?: string;
  /** Gmail compose (EML-8): shown when the user has email access; `canSend` = gmail.send scope granted. */
  email?: { to: string[]; canSend: boolean } | null;
  /** Lead Scout enrichment for the deal's account (enrichment:create). */
  enrich?: { accountId: string; motion: string } | null;
}) {
  const [dialog, setDialog] = React.useState<null | "log" | "task" | "email">(null);
  return (
    <div className="flex flex-wrap gap-2">
      {canLog ? (
        <Button size="sm" variant="secondary" onClick={() => setDialog("log")}>
          <PhoneCall /> Log activity
        </Button>
      ) : null}
      {email ? (
        <Button size="sm" variant="secondary" onClick={() => setDialog("email")}>
          <Mail /> Email
        </Button>
      ) : null}
      {canTask ? (
        <Button size="sm" variant="secondary" onClick={() => setDialog("task")}>
          <ListPlus /> Add task
        </Button>
      ) : null}
      {canUseAi ? <CopilotButton context={{ dealId }} contextLabel={dealName} /> : null}
      <MoreActions>
        {more}
        {enrich ? <EnrichButton accountId={enrich.accountId} motion={enrich.motion} dealId={dealId} /> : null}
      </MoreActions>
      {dialog === "log" ? <LogActivityDialog dealId={dealId} contacts={contacts} onClose={() => setDialog(null)} /> : null}
      {dialog === "email" && email ? <EmailDialog dealId={dealId} to={email.to} canSend={email.canSend} onClose={() => setDialog(null)} /> : null}
      {dialog === "task" ? (
        <AddTaskDialog dealId={dealId} users={users} defaultAssignee={ownerId ?? currentUserId} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function EmailDialog({ dealId, to, canSend, onClose }: { dealId: string; to: string[]; canSend: boolean; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Email</DialogTitle>
          <DialogDescription>Sent from your Gmail and logged to this deal.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <EmailComposer dealId={dealId} defaultTo={to} canSend={canSend} onSent={onClose} onCancel={onClose} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function LogActivityDialog({ dealId, contacts, onClose, defaultType = "call" }: { dealId: string; contacts: ContactLite[]; onClose: () => void; defaultType?: "call" | "note" | "meeting" | "email" | "linkedin" }) {
  const [type, setType] = React.useState(defaultType);
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [when, setWhen] = React.useState(nowLocal);
  const [duration, setDuration] = React.useState("");
  const [contactId, setContactId] = React.useState("");
  const [direction, setDirection] = React.useState<"outbound" | "inbound">("outbound");
  const [run, pending] = useRun();
  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () =>
                logDealActivity({
                  dealId,
                  type,
                  subject: subject || undefined,
                  body: body || undefined,
                  occurredAt: when ? new Date(when).toISOString() : undefined,
                  durationMin: duration ? Number(duration) : undefined,
                  contactId: contactId || undefined,
                  direction: type === "note" ? undefined : direction,
                }),
              { success: "Activity logged", onOk: onClose },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Log activity</DialogTitle>
            <DialogDescription>Logged touches update the deal&apos;s last activity and health.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="la-type">Type</Label>
                <NativeSelect id="la-type" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                  <option value="call">Call</option>
                  <option value="meeting">Meeting</option>
                  <option value="email">Email</option>
                  <option value="linkedin">LinkedIn</option>
                  <option value="note">Note</option>
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="la-when">When</Label>
                <Input id="la-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="[color-scheme:dark]" />
              </div>
              {type === "call" || type === "meeting" ? (
                <div className="space-y-1">
                  <Label htmlFor="la-dur">Minutes</Label>
                  <Input id="la-dur" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
                </div>
              ) : type !== "note" ? (
                <div className="space-y-1">
                  <Label htmlFor="la-dir">Direction</Label>
                  <NativeSelect id="la-dir" value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>
                    <option value="outbound">Outbound</option>
                    <option value="inbound">Inbound</option>
                  </NativeSelect>
                </div>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="la-subject">Subject</Label>
              <Input id="la-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Pricing call with CRO" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="la-body">Notes</Label>
              <Textarea id="la-body" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            {contacts.length ? (
              <div className="space-y-1">
                <Label htmlFor="la-contact">Contact</Label>
                <NativeSelect id="la-contact" value={contactId} onChange={(e) => setContactId(e.target.value)}>
                  <option value="">—</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || (!subject.trim() && !body.trim())}>
              {pending ? <Loader2 className="animate-spin" /> : null} Log
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AddTaskDialog({ dealId, users, defaultAssignee, onClose }: { dealId: string; users: UserLite[]; defaultAssignee: string; onClose: () => void }) {
  const [title, setTitle] = React.useState("");
  const [due, setDue] = React.useState("");
  const [assigneeId, setAssigneeId] = React.useState(defaultAssignee);
  const [priority, setPriority] = React.useState("medium");
  const [owedBy, setOwedBy] = React.useState<"us" | "them">("us");
  const [description, setDescription] = React.useState("");
  const [run, pending] = useRun();
  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () =>
                createDealTask({
                  dealId,
                  title,
                  dueAt: due || undefined,
                  assigneeId,
                  priority: priority as "medium",
                  owedBy,
                  description: description || undefined,
                }),
              { success: "Task added", onOk: onClose },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Add task</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-1">
              <Label htmlFor="at-title">Task</Label>
              <Input id="at-title" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={2} autoFocus placeholder="e.g. Send pro forma v2" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="at-due">Due</Label>
                <Input id="at-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} className="[color-scheme:dark]" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="at-assignee">Assignee</Label>
                <NativeSelect id="at-assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="at-priority">Priority</Label>
                <NativeSelect id="at-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
                  {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="at-owed">Commitment</Label>
                <NativeSelect id="at-owed" value={owedBy} onChange={(e) => setOwedBy(e.target.value as "us" | "them")}>
                  <option value="us">We owe</option>
                  <option value="them">They owe</option>
                </NativeSelect>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="at-desc">Details</Label>
              <Textarea id="at-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || title.trim().length < 2}>
              {pending ? <Loader2 className="animate-spin" /> : null} Add task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
