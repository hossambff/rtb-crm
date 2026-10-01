"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Plus, Search, UserCheck, UserX, Eye, LogOut, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { Avatar, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtDate, fmtRelative } from "@/lib/format";
import { ROLE_LABELS, type Role } from "@/lib/rbac/model";
import { ASSIGNABLE_ROLES, EMPLOYMENT_TYPES, PRIVILEGED_ROLES } from "@/lib/admin/users-schemas";
import {
  changeRole,
  claimPlaceholder,
  deactivateUser,
  impersonateUser,
  loadOwnedCounts,
  preProvisionUser,
  reactivateUser,
  revokeSessions,
  updateUserOrg,
} from "@/lib/admin/users-actions";
import { AdminSection, AdminTable, Field, Td, Th, useAction } from "./form";

export type UserRow = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
  title: string | null;
  teamId: string | null;
  teamName: string | null;
  managerId: string | null;
  managerName: string | null;
  employmentType: string | null;
  banned: boolean;
  banReason: string | null;
  accessExpiresAt: Date | null;
  lastActiveAt: Date | null;
  createdAt: Date;
  hasLogin: boolean;
  activeSessions: number;
  placeholder: boolean;
};
type Opt = { id: string; name: string };

const roleLabel = (r: string) => ROLE_LABELS[r as Role] ?? r;
const EMPLOYMENT_LABELS: Record<string, string> = { staff: "Staff", retainer: "Retainer", hourly: "Hourly", commission: "Commission-only", contractor: "Contractor" };
const dateInput = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

function statusOf(u: UserRow): { status: "good" | "warning" | "serious" | "critical"; label: string } {
  if (u.banned) return { status: "critical", label: "Deactivated" };
  if (u.accessExpiresAt && new Date(u.accessExpiresAt).getTime() < Date.now()) return { status: "serious", label: "Expired" };
  if (u.role === "pending") return { status: "warning", label: "Pending role" };
  if (!u.hasLogin && !u.lastActiveAt) return { status: "warning", label: "Invited" };
  return { status: "good", label: "Active" };
}

export function UsersAdmin({
  users,
  teams,
  isSuperAdmin,
  currentUserId,
  allowedDomains,
}: {
  users: UserRow[];
  teams: Opt[];
  isSuperAdmin: boolean;
  currentUserId: string;
  allowedDomains: string[];
}) {
  const [q, setQ] = React.useState("");
  const [roleFilter, setRoleFilter] = React.useState("");
  const [show, setShow] = React.useState<"active" | "all">("active");
  const [editing, setEditing] = React.useState<UserRow | null>(null);
  const [deactivating, setDeactivating] = React.useState<UserRow | null>(null);
  const [provisioning, setProvisioning] = React.useState(false);
  const people = users.filter((u) => !u.placeholder);
  const activePeople = people.filter((u) => !u.banned);
  const filtered = people.filter((u) => {
    if (show === "active" && u.banned) return false;
    if (roleFilter && u.role !== roleFilter) return false;
    const needle = q.trim().toLowerCase();
    return !needle || u.name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle) || (u.teamName ?? "").toLowerCase().includes(needle);
  });

  return (
    <AdminSection
      title="Users"
      description={`${activePeople.length} active · sign-in restricted to ${allowedDomains.join(", ")} (Google Workspace).`}
      actions={
        <Button variant="primary" size="sm" onClick={() => setProvisioning(true)}>
          <Plus /> Pre-provision user
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden />
          <Input aria-label="Search users" placeholder="Search name, email, team" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8 text-xs" />
        </div>
        <NativeSelect aria-label="Filter by role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="h-8 w-44 text-xs">
          <option value="">All roles</option>
          {[...ASSIGNABLE_ROLES, "pending"].map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as "active" | "all")} className="h-8 w-36 text-xs">
          <option value="active">Active only</option>
          <option value="all">Include deactivated</option>
        </NativeSelect>
      </div>
      {filtered.length === 0 ? (
        <EmptyState title="No users match" description="Adjust the search or filters." />
      ) : (
        <AdminTable cards className="-mx-4">
          <thead>
            <tr>
              <Th className="pl-4">User</Th>
              <Th>Role</Th>
              <Th>Team · manager</Th>
              <Th>Employment</Th>
              <Th>Status</Th>
              <Th>Last active</Th>
              <Th>Access expiry</Th>
              <Th className="w-10 pr-4">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <UserRowView
                key={u.id}
                u={u}
                isSuperAdmin={isSuperAdmin}
                isSelf={u.id === currentUserId}
                onEdit={() => setEditing(u)}
                onDeactivate={() => setDeactivating(u)}
              />
            ))}
          </tbody>
        </AdminTable>
      )}
      {provisioning ? <ProvisionDialog open onClose={() => setProvisioning(false)} teams={teams} users={activePeople} isSuperAdmin={isSuperAdmin} allowedDomains={allowedDomains} /> : null}
      {editing ? <EditUserDialog user={editing} onClose={() => setEditing(null)} teams={teams} users={activePeople} /> : null}
      {deactivating ? <DeactivateDialog user={deactivating} onClose={() => setDeactivating(null)} users={activePeople} /> : null}
    </AdminSection>
  );
}

function UserRowView({ u, isSuperAdmin, isSelf, onEdit, onDeactivate }: { u: UserRow; isSuperAdmin: boolean; isSelf: boolean; onEdit: () => void; onDeactivate: () => void }) {
  const router = useRouter();
  const st = statusOf(u);
  const privileged = (PRIVILEGED_ROLES as readonly string[]).includes(u.role);
  const canManage = !isSelf && (isSuperAdmin || !privileged);
  const role = useAction(changeRole, { success: "Role updated" });
  const reactivate = useAction(reactivateUser, { success: "User reactivated" });
  const revoke = useAction(revokeSessions, { success: "Sessions revoked" });
  const impersonate = useAction(impersonateUser, {
    refresh: false,
    onSuccess: () => {
      router.push("/home");
      router.refresh();
    },
  });
  const roleOptions = ASSIGNABLE_ROLES.filter((r) => isSuperAdmin || !(PRIVILEGED_ROLES as readonly string[]).includes(r));
  return (
    <tr className={u.banned ? "opacity-60" : undefined}>
      <Td label="User" primary className="pl-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={u.name} src={u.image} size={28} />
          <div className="min-w-0">
            <p className="truncate font-medium text-fg">
              {u.name}
              {isSelf ? <span className="ml-1.5 text-xs font-normal text-muted">(you)</span> : null}
            </p>
            <p className="truncate text-xs text-muted">
              {u.email}
              {u.title ? ` · ${u.title}` : ""}
            </p>
          </div>
        </div>
      </Td>
      <Td label="Role">
        {canManage && !u.banned ? (
          <NativeSelect
            aria-label={`Role for ${u.name}`}
            value={u.role}
            disabled={role.pending}
            onChange={(e) => role.run({ userId: u.id, role: e.target.value })}
            className="h-8 w-44 min-w-0 max-w-full text-xs"
          >
            {u.role === "pending" ? <option value="pending">Pending approval</option> : null}
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <Badge>{roleLabel(u.role)}</Badge>
        )}
      </Td>
      <Td label="Team · manager" className="text-xs text-secondary">
        {u.teamName ?? "—"}
        <span className="block text-muted">{u.managerName ? `→ ${u.managerName}` : ""}</span>
      </Td>
      <Td label="Employment" className="text-xs text-secondary">{EMPLOYMENT_LABELS[u.employmentType ?? ""] ?? "—"}</Td>
      <Td label="Status">
        <StatusBadge status={st.status} label={st.label} />
      </Td>
      <Td label="Last active" className="whitespace-nowrap text-xs text-secondary">
        {u.lastActiveAt ? fmtRelative(u.lastActiveAt) : "Never"}
        {u.activeSessions ? <span className="block text-muted">{u.activeSessions} session{u.activeSessions === 1 ? "" : "s"}</span> : null}
      </Td>
      <Td label="Access expiry" className="whitespace-nowrap text-xs text-secondary tabular">{u.accessExpiresAt ? fmtDate(u.accessExpiresAt) : "—"}</Td>
      <Td actions className="pr-4">
        {canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil /> Edit team, manager, expiry
              </DropdownMenuItem>
              {!u.banned ? (
                <DropdownMenuItem onSelect={() => revoke.run({ userId: u.id })}>
                  <LogOut /> Sign out all sessions
                </DropdownMenuItem>
              ) : null}
              {isSuperAdmin && !u.banned && u.role !== "super_admin" ? (
                <DropdownMenuItem onSelect={() => impersonate.run({ userId: u.id })}>
                  <Eye /> View as {u.name.split(" ")[0]}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              {u.banned ? (
                <DropdownMenuItem onSelect={() => reactivate.run({ userId: u.id })}>
                  <UserCheck /> Reactivate
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={onDeactivate}>
                  <UserX className="text-critical" /> Deactivate…
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </Td>
    </tr>
  );
}

function ProvisionDialog({
  open,
  onClose,
  teams,
  users,
  isSuperAdmin,
  allowedDomains,
}: {
  open: boolean;
  onClose: () => void;
  teams: Opt[];
  users: Opt[];
  isSuperAdmin: boolean;
  allowedDomains: string[];
}) {
  const [f, setF] = React.useState({ email: "", name: "", title: "", role: "sdr", teamId: "", managerId: "", employmentType: "staff", accessExpiresAt: "" });
  const { run, pending, errors } = useAction(preProvisionUser, { success: "User pre-provisioned — they can sign in with Google", onSuccess: onClose });
  // QA-21: the email field shows its own error (domain allowlist checked inline; server message mapped back to the field).
  const [emailErr, setEmailErr] = React.useState<string | null>(null);
  const domainError = (email: string) => {
    const domain = email.trim().toLowerCase().split("@")[1];
    if (!domain) return null;
    return allowedDomains.map((d) => d.toLowerCase()).includes(domain) ? null : `Use a ${allowedDomains.map((d) => `@${d}`).join(" or ")} address — other domains can't sign in.`;
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (k === "email") setEmailErr(null);
    setF((p) => ({ ...p, [k]: e.target.value }));
  };
  const roles = ASSIGNABLE_ROLES.filter((r) => isSuperAdmin || !(PRIVILEGED_ROLES as readonly string[]).includes(r));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const inline = domainError(f.email);
            if (inline) return setEmailErr(inline);
            const res = await run({ ...f, title: f.title || null, teamId: f.teamId || null, managerId: f.managerId || null, accessExpiresAt: f.accessExpiresAt || null, employmentType: f.employmentType as never });
            if (!res.ok && !res.fieldErrors?.email && /email|domain|already/i.test(res.error)) setEmailErr(res.error);
          }}
        >
          <DialogHeader>
            <DialogTitle>Pre-provision a user</DialogTitle>
            <DialogDescription>
              They sign in with their Google Workspace account ({allowedDomains.join(" or ")}); the role applies on first sign-in. No password is created.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Work email" htmlFor="pp-email" error={emailErr ?? errors.email} className="sm:col-span-2">
              <Input
                id="pp-email"
                type="email"
                autoComplete="off"
                value={f.email}
                onChange={set("email")}
                onBlur={() => setEmailErr(domainError(f.email))}
                aria-invalid={Boolean(emailErr ?? errors.email) || undefined}
                aria-describedby={emailErr ?? errors.email ? "pp-email-error" : undefined}
                placeholder={`name@${allowedDomains[0] ?? "roundtable.io"}`}
                required
              />
            </Field>
            <Field label="Full name" htmlFor="pp-name" error={errors.name}>
              <Input id="pp-name" value={f.name} onChange={set("name")} required />
            </Field>
            <Field label="Title" htmlFor="pp-title" error={errors.title}>
              <Input id="pp-title" value={f.title} onChange={set("title")} />
            </Field>
            <Field label="Role" htmlFor="pp-role" error={errors.role}>
              <NativeSelect id="pp-role" value={f.role} onChange={set("role")}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Employment type" htmlFor="pp-emp" error={errors.employmentType}>
              <NativeSelect id="pp-emp" value={f.employmentType} onChange={set("employmentType")}>
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EMPLOYMENT_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <OrgFields f={f} set={set} teams={teams} users={users} errors={errors} idPrefix="pp" />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Creating…" : "Pre-provision"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OrgFields({
  f,
  set,
  teams,
  users,
  errors,
  idPrefix,
  selfId,
}: {
  f: { teamId: string; managerId: string; accessExpiresAt: string };
  set: (k: "teamId" | "managerId" | "accessExpiresAt") => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  teams: Opt[];
  users: Opt[];
  errors: Record<string, string[]>;
  idPrefix: string;
  selfId?: string;
}) {
  return (
    <>
      <Field label="Team" htmlFor={`${idPrefix}-team`} error={errors.teamId}>
        <NativeSelect id={`${idPrefix}-team`} value={f.teamId} onChange={set("teamId")}>
          <option value="">No team</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Manager" htmlFor={`${idPrefix}-mgr`} error={errors.managerId}>
        <NativeSelect id={`${idPrefix}-mgr`} value={f.managerId} onChange={set("managerId")}>
          <option value="">No manager</option>
          {users
            .filter((u) => u.id !== selfId)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
        </NativeSelect>
      </Field>
      <Field label="Access expires" htmlFor={`${idPrefix}-exp`} error={errors.accessExpiresAt} hint="For interns and contractors; sign-in is blocked after this date.">
        <Input id={`${idPrefix}-exp`} type="date" value={f.accessExpiresAt} onChange={set("accessExpiresAt")} />
      </Field>
    </>
  );
}

function EditUserDialog({ user, onClose, teams, users }: { user: UserRow; onClose: () => void; teams: Opt[]; users: Opt[] }) {
  const [f, setF] = React.useState({
    name: user.name,
    title: user.title ?? "",
    teamId: user.teamId ?? "",
    managerId: user.managerId ?? "",
    employmentType: user.employmentType ?? "staff",
    accessExpiresAt: dateInput(user.accessExpiresAt),
  });
  const { run, pending, errors } = useAction(updateUserOrg, { success: "User updated", onSuccess: onClose });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run({ userId: user.id, ...f, title: f.title || null, teamId: f.teamId || null, managerId: f.managerId || null, accessExpiresAt: f.accessExpiresAt || null, employmentType: f.employmentType as never });
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit {user.name}</DialogTitle>
            <DialogDescription>{user.email} · role changes are made in the table.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" htmlFor="eu-name" error={errors.name}>
              <Input id="eu-name" value={f.name} onChange={set("name")} required />
            </Field>
            <Field label="Title" htmlFor="eu-title" error={errors.title}>
              <Input id="eu-title" value={f.title} onChange={set("title")} />
            </Field>
            <Field label="Employment type" htmlFor="eu-emp" error={errors.employmentType}>
              <NativeSelect id="eu-emp" value={f.employmentType} onChange={set("employmentType")}>
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EMPLOYMENT_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <OrgFields f={f} set={set} teams={teams} users={users} errors={errors} idPrefix="eu" selfId={user.id} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Counts = { deals: number; tasks: number; accounts: number; contacts: number };

/** Deactivation + reassignment wizard (AUTH-6): pick what moves, to whom, then ban + revoke sessions. */
function DeactivateDialog({ user, onClose, users }: { user: UserRow; onClose: () => void; users: Opt[] }) {
  const [counts, setCounts] = React.useState<Counts | null>(null);
  const [to, setTo] = React.useState(user.managerId ?? "");
  const [reason, setReason] = React.useState("");
  const [include, setInclude] = React.useState({ deals: true, tasks: true, accounts: true, contacts: true });
  const load = useAction(loadOwnedCounts, { refresh: false, onSuccess: (c) => setCounts(c) });
  const { run, pending, errors } = useAction(deactivateUser, {
    success: (m) => `Deactivated · moved ${m.deals} deals, ${m.tasks} tasks, ${m.accounts} accounts, ${m.contacts} contacts`,
    onSuccess: onClose,
  });
  const loadRun = load.run;
  React.useEffect(() => {
    void loadRun({ userId: user.id });
  }, [loadRun, user.id]);
  const anything = counts ? Object.values(counts).some((n) => n > 0) : false;
  const moving = Object.entries(include).some(([k, v]) => v && (counts?.[k as keyof Counts] ?? 0) > 0);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Deactivate {user.name}</DialogTitle>
          <DialogDescription>Signs them out everywhere, blocks sign-in, stops inbox sync and hands their open work to someone else.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <fieldset>
            <legend className="mb-2 text-xs font-medium text-secondary">1 · Open records to reassign</legend>
            {!counts ? (
              <p className="text-xs text-muted">Counting records…</p>
            ) : !anything ? (
              <p className="text-xs text-muted">{user.name} owns no open records.</p>
            ) : (
              <ul className="grid grid-cols-2 gap-2">
                {(Object.keys(include) as (keyof Counts)[]).map((k) => (
                  <li key={k}>
                    <label className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={include[k] && counts[k] > 0}
                        disabled={!counts[k]}
                        onChange={(e) => setInclude((p) => ({ ...p, [k]: e.target.checked }))}
                        className="accent-white"
                      />
                      <span className="capitalize text-body">{k === "deals" ? "Open deals" : k === "tasks" ? "Open tasks" : k}</span>
                      <span className="ml-auto text-xs text-muted tabular">{counts[k]}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          {anything ? (
            <Field label="2 · New owner" htmlFor="da-to" error={errors.reassignTo}>
              <NativeSelect id="da-to" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Choose a user…</option>
                {users
                  .filter((u) => u.id !== user.id)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          ) : null}
          <Field label={anything ? "3 · Reason (audit log)" : "Reason (audit log)"} htmlFor="da-reason" error={errors.reason}>
            <Input id="da-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Internship ended" />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending || !counts || (moving && !to)}
            onClick={() =>
              run({
                userId: user.id,
                reassignTo: moving ? to : null,
                reason: reason || null,
                include: {
                  deals: include.deals && (counts?.deals ?? 0) > 0,
                  tasks: include.tasks && (counts?.tasks ?? 0) > 0,
                  accounts: include.accounts && (counts?.accounts ?? 0) > 0,
                  contacts: include.contacts && (counts?.contacts ?? 0) > 0,
                },
              })
            }
          >
            {pending ? "Deactivating…" : "Deactivate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type PlaceholderRow = { id: string; name: string; email: string; banned: boolean; claimed: boolean; deals: number; accounts: number; tasks: number };

/** Import placeholders ("Chris", "Will"…) → claim into the real user once they have an account. */
export function PlaceholdersPanel({ placeholders, users }: { placeholders: PlaceholderRow[]; users: Opt[] }) {
  const [claiming, setClaiming] = React.useState<PlaceholderRow | null>(null);
  const [target, setTarget] = React.useState("");
  const { run, pending, errors } = useAction(claimPlaceholder, {
    success: (d) => `Claimed · moved ${d.summary}`,
    onSuccess: () => {
      setClaiming(null);
      setTarget("");
    },
  });
  const open = placeholders.filter((p) => !p.claimed);
  const claimed = placeholders.length - open.length;
  return (
    <AdminSection
      title="Import placeholders"
      description={`Owners found in the spreadsheets before they had accounts. Claiming moves every deal, split, task, account, contact, activity and commission record to the real user.${claimed ? ` ${claimed} already claimed.` : ""}`}
    >
      {open.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted">No unclaimed placeholders.</p>
      ) : (
        <AdminTable cards className="-mx-4">
          <thead>
            <tr>
              <Th className="pl-4">Placeholder</Th>
              <Th className="text-right">Deals</Th>
              <Th className="text-right">Accounts</Th>
              <Th className="text-right">Open tasks</Th>
              <Th className="pr-4 text-right">
                <span className="sr-only">Claim</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {open.map((p) => (
              <tr key={p.id}>
                <Td label="Placeholder" primary className="pl-4">
                  <div className="min-w-0">
                    <p className="font-medium text-fg">{p.name}</p>
                    <p className="break-all text-xs text-muted md:break-normal">{p.email}</p>
                  </div>
                </Td>
                <Td label="Deals" className="text-right tabular">{p.deals}</Td>
                <Td label="Accounts" className="text-right tabular">{p.accounts}</Td>
                <Td label="Open tasks" className="text-right tabular">{p.tasks}</Td>
                <Td actions className="pr-4 text-right">
                  <Button size="sm" onClick={() => setClaiming(p)}>
                    Claim…
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
      {claiming ? (
        <Dialog open onOpenChange={(o) => !o && setClaiming(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Claim “{claiming.name}”</DialogTitle>
              <DialogDescription>
                {claiming.deals} deals, {claiming.accounts} accounts and {claiming.tasks} open tasks move to the user you choose. The placeholder is then
                deactivated (kept for the audit trail). This can&apos;t be undone automatically.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <Field label="Real user" htmlFor="claim-target" error={errors.targetUserId}>
                <NativeSelect id="claim-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choose a user…</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setClaiming(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={pending || !target}
                onClick={() => {
                  if (!target) return toast.error("Choose the real user.");
                  run({ placeholderId: claiming.id, targetUserId: target });
                }}
              >
                {pending ? "Claiming…" : "Claim records"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </AdminSection>
  );
}
