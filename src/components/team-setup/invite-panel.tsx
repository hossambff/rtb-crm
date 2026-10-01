"use client";
import { useMemo, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { AdminTable, Td, Th, useAction } from "@/components/admin/form";
import { ROLE_LABELS, type Role } from "@/lib/rbac/model";
import { EMPLOYMENT, parseInviteRows, type InviteContext } from "@/lib/team-setup/core";
import { inviteMembers } from "@/lib/team-setup/actions";

type Opt = { id: string; name: string; email?: string | null };

const EMPLOYMENT_LABELS: Record<string, string> = { staff: "Staff", retainer: "Retainer", hourly: "Hourly", commission: "Commission-only", contractor: "Contractor" };

/**
 * Invite in bulk: paste "email, name, role, team, manager, employment type" rows (from a sheet: tab-separated works)
 * or add people one by one — both feed the same list, previewed and validated before anything is created. The server
 * re-validates every row against the inviter's rights.
 */
export function InvitePanel({
  allowedRoles,
  teams,
  people,
  domains,
  forcedTeam,
  me,
  readOnly,
}: {
  allowedRoles: Role[];
  teams: Opt[];
  people: Opt[];
  domains: string[];
  /** Sales leaders: everyone joins this team (null = the leader has no team; people report to them directly). */
  forcedTeam: Opt | null | undefined;
  me: Opt;
  readOnly: boolean;
}) {
  const [text, setText] = useState("");
  const [one, setOne] = useState({ email: "", name: "", role: allowedRoles.includes("ae") ? "ae" : (allowedRoles[0] ?? "ae"), team: "", manager: "", employment: "staff" });
  const [results, setResults] = useState<{ email: string; ok: boolean; error?: string }[] | null>(null);
  const leader = forcedTeam !== undefined;
  const ctx: InviteContext = useMemo(
    () => ({
      teams,
      people,
      allowed: allowedRoles,
      existingEmails: new Set<string>(), // checked on the server (no directory of emails in the browser)
      domains,
      ...(leader ? { forcedTeamId: forcedTeam?.id ?? null, defaultManagerId: me.id } : {}),
    }),
    [teams, people, allowedRoles, domains, leader, forcedTeam, me.id],
  );
  const parsed = useMemo(() => parseInviteRows(text, ctx), [text, ctx]);
  const valid = parsed.rows.filter((r) => !r.errors.length);
  const { run, pending } = useAction(inviteMembers, {
    success: (d) => (d.invited ? `Invited ${d.invited} ${d.invited === 1 ? "person" : "people"}. They sign in with Google.` : ""),
    onSuccess: (d) => {
      setResults(d.results);
      const failed = new Set(d.results.filter((r) => !r.ok).map((r) => r.email));
      // keep only the rows that still need attention
      setText(
        text
          .split(/\r?\n/)
          .filter((l) => failed.has((l.split(/[,\t;]/)[0] ?? "").trim().toLowerCase()))
          .join("\n"),
      );
    },
  });
  const addOne = () => {
    const cells = [one.email, one.name, one.role, leader ? "" : teams.find((t) => t.id === one.team)?.name ?? "", people.find((p) => p.id === one.manager)?.email ?? "", one.employment];
    setText((t) => `${t.trim() ? `${t.trimEnd()}\n` : ""}${cells.join(", ")}`);
    setOne((o) => ({ ...o, email: "", name: "" }));
  };
  const nameOf = (list: Opt[], id: string | null) => (id ? (list.find((x) => x.id === id)?.name ?? "—") : "—");

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        {leader
          ? `People you invite join ${forcedTeam?.name ?? "you"} as sellers, reporting to you unless you name another manager.`
          : "Pre-provision people so their role, team and manager are ready the first time they sign in with Google."}{" "}
        They&apos;ll land in the setup wizard on first sign-in.
      </p>

      <div className="space-y-1.5">
        <label htmlFor="ts-paste" className="text-xs font-medium text-secondary">
          Paste rows
        </label>
        <Textarea
          id="ts-paste"
          rows={5}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResults(null);
          }}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={`email, name, role, team, manager, employment type\nalex@roundtable.io, Alex Morgan, AE, ${leader ? "" : "ENT"}, ${me.name}, staff`}
          disabled={readOnly}
        />
        <p className="text-xs text-muted">One person per line. Copying from a spreadsheet works. Role: AE, SDR, Intern, Commission rep{leader ? "" : ", SVP, Finance…"}.</p>
      </div>

      <fieldset className="rounded-lg border border-border p-3" disabled={readOnly}>
        <legend className="px-1 text-xs font-medium text-secondary">Or add one</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Input aria-label="Email" placeholder="email@roundtable.io" value={one.email} onChange={(e) => setOne({ ...one, email: e.target.value })} />
          <Input aria-label="Name" placeholder="Full name" value={one.name} onChange={(e) => setOne({ ...one, name: e.target.value })} />
          <NativeSelect aria-label="Role" value={one.role} onChange={(e) => setOne({ ...one, role: e.target.value as Role })}>
            {allowedRoles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </NativeSelect>
          {leader ? (
            <Input aria-label="Team" value={forcedTeam?.name ?? "Your reports"} readOnly disabled />
          ) : (
            <NativeSelect aria-label="Team" value={one.team} onChange={(e) => setOne({ ...one, team: e.target.value })}>
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          )}
          <NativeSelect aria-label="Manager" value={one.manager} onChange={(e) => setOne({ ...one, manager: e.target.value })}>
            <option value="">{leader ? `${me.name} (you)` : "No manager"}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect aria-label="Employment type" value={one.employment} onChange={(e) => setOne({ ...one, employment: e.target.value })}>
            {EMPLOYMENT.map((e) => (
              <option key={e} value={e}>
                {EMPLOYMENT_LABELS[e]}
              </option>
            ))}
          </NativeSelect>
          <Button type="button" variant="secondary" onClick={addOne} disabled={!one.email.trim() || !one.name.trim()}>
            <Plus /> Add
          </Button>
        </div>
      </fieldset>

      {parsed.rows.length ? (
        <AdminTable>
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Role</Th>
              <Th>Team</Th>
              <Th>Manager</Th>
              <Th>Check</Th>
            </tr>
          </thead>
          <tbody>
            {parsed.rows.map((r) => (
              <tr key={`${r.line}-${r.email}`}>
                <Td>
                  <p className="text-sm text-fg">{r.name || "—"}</p>
                  <p className="text-xs text-muted">{r.email || "—"}</p>
                </Td>
                <Td className="text-xs">{r.role ? ROLE_LABELS[r.role] : "—"}</Td>
                <Td className="text-xs">{leader ? (forcedTeam?.name ?? "—") : nameOf(teams, r.teamId)}</Td>
                <Td className="text-xs">{r.managerId === me.id ? `${me.name} (you)` : nameOf(people, r.managerId)}</Td>
                <Td>
                  {r.errors.length ? (
                    <p className="flex items-start gap-1.5 text-xs text-secondary">
                      <X className="mt-0.5 size-3.5 shrink-0 text-critical" aria-hidden />
                      {r.errors.join(" · ")}
                    </p>
                  ) : (
                    <p className="flex items-center gap-1.5 text-xs text-secondary">
                      <Check className="size-3.5 text-good" aria-hidden /> Ready
                    </p>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      ) : null}
      {parsed.tooMany ? <p className="text-xs text-warning">Up to 100 people at a time — the rest weren&apos;t read.</p> : null}

      {results?.some((r) => !r.ok) ? (
        <div role="alert" className="rounded-lg border border-border-strong px-3 py-2">
          <p className="text-sm text-fg">Not invited</p>
          <ul className="mt-1 space-y-0.5 text-xs text-secondary">
            {results
              .filter((r) => !r.ok)
              .map((r) => (
                <li key={r.email}>
                  {r.email}: {r.error}
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        {parsed.rows.length > valid.length ? <span className="text-xs text-muted">Rows with problems are skipped.</span> : null}
        <Button
          variant="primary"
          disabled={readOnly || pending || !valid.length}
          onClick={() =>
            run({
              rows: valid.map((r) => ({
                email: r.email,
                name: r.name,
                role: r.role!,
                team: leader ? "" : (teams.find((t) => t.id === r.teamId)?.name ?? ""),
                manager: r.managerId ?? "",
                employment: r.employmentType,
              })),
            })
          }
        >
          {pending ? "Inviting…" : `Invite ${valid.length || ""} ${valid.length === 1 ? "person" : "people"}`.replace("  ", " ")}
        </Button>
      </div>
    </div>
  );
}
