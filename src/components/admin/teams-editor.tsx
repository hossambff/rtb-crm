"use client";
import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorTick } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/misc";
import { AdminSection, AdminTable, ConfirmButton, Field, Td, Th, useAction } from "@/components/admin/form";
import { ChipMultiSelect, ListSuggestions } from "@/components/admin/fields-editor-controls";
import { fmtNumber } from "@/lib/format";
import { parseList } from "@/lib/admin/config-schemas";
import { deleteTeam, saveTeam } from "@/lib/admin/teams-actions";
import type { AdminTeam } from "@/lib/admin/config-queries";

type PipelineOpt = { key: string; name: string; color: string };
type UserOpt = { id: string; name: string; email: string };

function territorySummary(t: AdminTeam["territory"]): string {
  const parts = [...(t?.regions ?? []), ...(t?.verticals ?? []), ...(t?.leagues ?? [])];
  if (!parts.length) return "—";
  return parts.length > 5 ? `${parts.slice(0, 5).join(", ")} +${parts.length - 5}` : parts.join(", ");
}

export function TeamsEditor({
  teams,
  users,
  pipelines,
  leagues,
  verticals,
}: {
  teams: AdminTeam[];
  users: UserOpt[];
  pipelines: PipelineOpt[];
  leagues: string[];
  verticals: string[];
}) {
  const [editing, setEditing] = React.useState<AdminTeam | "new" | null>(null);
  const del = useAction(deleteTeam, { success: "Team deleted" });
  const colorOf = new Map(pipelines.map((p) => [p.key, p.color]));
  return (
    <AdminSection
      title="Teams"
      description="Teams scope pipeline visibility (team scope in the permission matrix) and territory routing. Assign members under Users."
      actions={
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus aria-hidden /> New team
        </Button>
      }
    >
      {teams.length === 0 ? (
        <EmptyState title="No teams" description="Create a team to group reps by pipeline and territory." />
      ) : (
        <AdminTable cards>
          <thead>
            <tr>
              <Th>Team</Th>
              <Th>Lead</Th>
              <Th>Pipelines</Th>
              <Th>Territory</Th>
              <Th className="text-right">Members</Th>
              <Th className="w-20">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.id}>
                <Td label="Team" primary className="font-medium text-fg">{t.name}</Td>
                <Td label="Lead">{t.leadName ?? <span className="text-muted">—</span>}</Td>
                <Td label="Pipelines">
                  <div className="flex flex-wrap justify-end gap-2 text-xs md:justify-start">
                    {t.pipelineTypes.map((k) => (
                      <span key={k} className="inline-flex items-center gap-1">
                        <ColorTick color={colorOf.get(k) ?? "#828282"} />
                        {k}
                      </span>
                    ))}
                    {!t.pipelineTypes.length ? <span className="text-muted">—</span> : null}
                  </div>
                </Td>
                <Td label="Territory" className="text-xs md:max-w-64 text-secondary">{territorySummary(t.territory)}</Td>
                <Td label="Members" className="text-right tabular">{fmtNumber(t.memberCount)}</Td>
                <Td actions>
                  <div className="flex justify-end gap-0.5">
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}>
                      <Pencil aria-hidden />
                    </Button>
                    <ConfirmButton
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Delete ${t.name}`}
                      title={`Delete team "${t.name}"?`}
                      description={
                        t.memberCount > 0
                          ? `${fmtNumber(t.memberCount)} members are still on this team — reassign them first; deletion will be refused.`
                          : "This can't be undone. The change is audit-logged."
                      }
                      confirmLabel="Delete team"
                      onConfirm={() => del.run({ id: t.id })}
                    >
                      <Trash2 aria-hidden />
                    </ConfirmButton>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          {editing ? (
            <TeamForm team={editing === "new" ? null : editing} users={users} pipelines={pipelines} leagues={leagues} verticals={verticals} onDone={() => setEditing(null)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </AdminSection>
  );
}

function TeamForm({
  team,
  users,
  pipelines,
  leagues,
  verticals,
  onDone,
}: {
  team: AdminTeam | null;
  users: UserOpt[];
  pipelines: PipelineOpt[];
  leagues: string[];
  verticals: string[];
  onDone: () => void;
}) {
  const id = React.useId();
  const [name, setName] = React.useState(team?.name ?? "");
  const [leadId, setLeadId] = React.useState(team?.leadId ?? "");
  const [pipelineTypes, setPipelineTypes] = React.useState<string[]>(team?.pipelineTypes ?? []);
  const [regions, setRegions] = React.useState((team?.territory?.regions ?? []).join(", "));
  const [verts, setVerts] = React.useState((team?.territory?.verticals ?? []).join(", "));
  const [lgs, setLgs] = React.useState((team?.territory?.leagues ?? []).join(", "));
  const { run, pending, errors } = useAction(saveTeam, { success: team ? "Team saved" : "Team created", onSuccess: onDone });
  // Keep a lead who is no longer active selectable so saving doesn't silently drop them.
  const leadMissing = leadId && !users.some((u) => u.id === leadId);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run({ id: team?.id, name, leadId: leadId || null, pipelineTypes, regions: parseList(regions), verticals: parseList(verts), leagues: parseList(lgs) });
      }}
    >
      <DialogHeader>
        <DialogTitle>{team ? `Edit team · ${team.name}` : "New team"}</DialogTitle>
        <DialogDescription>Territory values are comma-separated.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor={`${id}-name`} error={errors.name}>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label="Team lead" htmlFor={`${id}-lead`} error={errors.leadId}>
            <NativeSelect id={`${id}-lead`} value={leadId} onChange={(e) => setLeadId(e.target.value)}>
              <option value="">No lead</option>
              {leadMissing ? <option value={leadId}>{team?.leadName ?? "Inactive user"} (inactive)</option> : null}
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} · {u.email}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <div className="space-y-1.5">
          <p id={`${id}-pipes`} className="text-xs font-medium text-secondary">
            Pipelines
          </p>
          <ChipMultiSelect
            labelId={`${id}-pipes`}
            options={pipelines.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}`, color: p.color }))}
            value={pipelineTypes}
            onChange={setPipelineTypes}
          />
          {errors.pipelineTypes ? <p className="text-xs text-secondary" role="alert">{errors.pipelineTypes[0]}</p> : null}
        </div>
        <Field label="Regions" htmlFor={`${id}-regions`} error={errors.regions} hint="e.g. US, UK, LATAM">
          <Input id={`${id}-regions`} value={regions} onChange={(e) => setRegions(e.target.value)} />
        </Field>
        <Field label="Verticals" htmlFor={`${id}-verticals`} error={errors.verticals}>
          <Input id={`${id}-verticals`} value={verts} onChange={(e) => setVerts(e.target.value)} />
        </Field>
        <ListSuggestions label="Verticals" text={verts} suggestions={verticals} onChange={setVerts} />
        <Field label="Leagues" htmlFor={`${id}-leagues`} error={errors.leagues}>
          <Input id={`${id}-leagues`} value={lgs} onChange={(e) => setLgs(e.target.value)} />
        </Field>
        <ListSuggestions label="Leagues" text={lgs} suggestions={leagues} onChange={setLgs} />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {team ? "Save team" : "Create team"}
        </Button>
      </DialogFooter>
    </form>
  );
}
