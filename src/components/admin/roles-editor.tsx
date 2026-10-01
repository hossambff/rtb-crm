"use client";
import * as React from "react";
import Link from "next/link";
import { RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ACTIONS, ROLE_LABELS, SCOPES, type Role } from "@/lib/rbac/model";
import { ACTION_LABELS, FIELD_ACCESS, FIELD_ENTITIES, MODULE_LABELS, type MatrixCell } from "@/lib/admin/permissions-core";
import { deleteFieldPermission, resetRolePermissions, setFieldPermission, setRolePermission } from "@/lib/admin/permissions-actions";
import { AdminSection, AdminTable, ConfirmButton, Field, Td, Th, useAction } from "./form";

const SCOPE_LABEL: Record<string, string> = { none: "—", own: "Own", team: "Team", pipeline: "Pipeline", all: "All" };

export function RoleTabs({ roles, current }: { roles: Role[]; current: Role }) {
  return (
    <nav aria-label="Roles" className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <Link
          key={r}
          href={`/admin/roles?role=${r}`}
          aria-current={r === current ? "page" : undefined}
          className={cn(
            "rounded-md border px-2.5 py-1 text-xs transition-colors duration-150",
            r === current ? "border-white bg-white font-medium text-black" : "border-border text-secondary hover:border-border-strong hover:text-fg",
          )}
        >
          {ROLE_LABELS[r]}
        </Link>
      ))}
    </nav>
  );
}

/** Module × action × scope matrix for one role. Overridden cells carry a dot and show the default on hover. */
export function MatrixEditor({ role, grid, editable, overrideCount }: { role: Role; grid: MatrixCell[][]; editable: boolean; overrideCount: number }) {
  const cell = useAction(setRolePermission, { success: "Permission updated" });
  const reset = useAction(resetRolePermissions, { success: "Role reset to defaults" });
  return (
    <AdminSection
      title={`${ROLE_LABELS[role]} · permission matrix`}
      description={
        editable
          ? "Scope per module and action. Changes apply immediately to every user with this role and are audit-logged."
          : role === "super_admin"
            ? "Super Admin always has full access (locked to prevent lock-out)."
            : "Read-only — only a Super Admin can change permissions."
      }
      actions={
        editable && overrideCount > 0 ? (
          <ConfirmButton
            size="sm"
            title={`Reset ${ROLE_LABELS[role]} to defaults?`}
            description={`Removes ${overrideCount} override${overrideCount === 1 ? "" : "s"}; the PRD Appendix B defaults apply again.`}
            confirmLabel="Reset to defaults"
            onConfirm={() => reset.run({ role })}
          >
            <RotateCcw /> Reset to defaults
          </ConfirmButton>
        ) : null
      }
    >
      <p className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>{overrideCount} override{overrideCount === 1 ? "" : "s"} from defaults</span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="size-1.5 rounded-full bg-white" /> overridden cell
        </span>
      </p>
      <AdminTable stickyFirst className="-mx-4">
        <thead>
          <tr>
            <Th className="pl-4">Module</Th>
            {ACTIONS.map((a) => (
              <Th key={a} className="text-center">
                {ACTION_LABELS[a]}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row) => (
            <tr key={row[0]!.module}>
              <Td className="whitespace-nowrap pl-4 text-xs font-medium text-secondary">{MODULE_LABELS[row[0]!.module]}</Td>
              {row.map((c) => (
                <Td key={c.action} className="px-1 text-center">
                  {editable ? (
                    <span className="relative inline-block">
                      <select
                        aria-label={`${MODULE_LABELS[c.module]} · ${ACTION_LABELS[c.action]} scope`}
                        title={`Default: ${SCOPE_LABEL[c.def]}`}
                        value={c.scope}
                        disabled={cell.pending}
                        onChange={(e) => cell.run({ role, module: c.module, action: c.action, scope: e.target.value as never })}
                        className={cn(
                          "h-7 w-[74px] rounded border bg-surface-2 px-1 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
                          c.override ? "border-white/70 text-fg" : "border-border",
                          c.scope === "none" ? "text-muted" : "text-body",
                        )}
                      >
                        {SCOPES.map((sc) => (
                          <option key={sc} value={sc}>
                            {SCOPE_LABEL[sc]}
                          </option>
                        ))}
                      </select>
                      {c.override ? <span aria-hidden className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-white" /> : null}
                    </span>
                  ) : (
                    <span className={cn("text-[11px]", c.scope === "none" ? "text-disabled" : "text-body")} title={c.override ? `Default: ${SCOPE_LABEL[c.def]}` : undefined}>
                      {SCOPE_LABEL[c.scope]}
                      {c.override ? " •" : ""}
                    </span>
                  )}
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </AdminTable>
    </AdminSection>
  );
}

export type FieldOverride = { role: string; entity: string; field: string; access: string };

export function FieldSecurity({
  defaults,
  overrides,
  editable,
  roles,
}: {
  defaults: { entity: string; field: string; roles: Role[] }[];
  overrides: FieldOverride[];
  editable: boolean;
  roles: Role[];
}) {
  const [f, setF] = React.useState({ role: roles[0] ?? "intern", entity: "deal", field: "", access: "hidden" });
  const save = useAction(setFieldPermission, { success: "Field rule saved", onSuccess: () => setF((p) => ({ ...p, field: "" })) });
  const del = useAction(deleteFieldPermission, { success: "Field rule removed" });
  return (
    <AdminSection
      title="Field-level security"
      description="Defaults hide deal terms from interns, commission reps, editorial and viewers (PRD §7.1). Overrides below are stored per role and are enforced server-side wherever field security is read."
    >
      <h3 className="mb-2 text-xs font-medium text-secondary">Defaults (built in)</h3>
      <AdminTable cards className="-mx-4 mb-5">
        <thead>
          <tr>
            <Th className="pl-4">Field</Th>
            <Th>Hidden from</Th>
          </tr>
        </thead>
        <tbody>
          {defaults.map((d) => (
            <tr key={`${d.entity}.${d.field}`}>
              <Td label="Field" primary className="pl-4 font-mono text-xs">
                {d.entity}.{d.field}
              </Td>
              <Td label="Hidden from">
                <div className="flex flex-wrap justify-end gap-1 md:justify-start">
                  {d.roles.map((r) => (
                    <Badge key={r}>{ROLE_LABELS[r]}</Badge>
                  ))}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </AdminTable>
      <h3 className="mb-2 text-xs font-medium text-secondary">Overrides</h3>
      {overrides.length ? (
        <AdminTable cards className="-mx-4 mb-4">
          <thead>
            <tr>
              <Th className="pl-4">Role</Th>
              <Th>Field</Th>
              <Th>Access</Th>
              <Th className="pr-4">
                <span className="sr-only">Remove</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {overrides.map((o) => (
              <tr key={`${o.role}:${o.entity}.${o.field}`}>
                <Td label="Role" primary className="pl-4">{ROLE_LABELS[o.role as Role] ?? o.role}</Td>
                <Td label="Field" className="font-mono text-xs">
                  {o.entity}.{o.field}
                </Td>
                <Td label="Access">
                  <Badge>{o.access.replace("_", " ")}</Badge>
                </Td>
                <Td actions className="pr-4 text-right">
                  {editable ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${o.entity}.${o.field} rule for ${o.role}`}
                      onClick={() => del.run({ role: o.role, entity: o.entity as never, field: o.field })}
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      ) : (
        <p className="mb-4 text-xs text-muted">No overrides — defaults apply.</p>
      )}
      {editable ? (
        <form
          className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[1fr_1fr_1.4fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            save.run(f as never);
          }}
        >
          <Field label="Role" htmlFor="fs-role" error={save.errors.role}>
            <NativeSelect id="fs-role" value={f.role} onChange={(e) => setF((p) => ({ ...p, role: e.target.value as Role }))}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Object" htmlFor="fs-entity" error={save.errors.entity}>
            <NativeSelect id="fs-entity" value={f.entity} onChange={(e) => setF((p) => ({ ...p, entity: e.target.value }))}>
              {FIELD_ENTITIES.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Field (API name)" htmlFor="fs-field" error={save.errors.field}>
            <Input id="fs-field" value={f.field} onChange={(e) => setF((p) => ({ ...p, field: e.target.value }))} placeholder="revSharePct" />
          </Field>
          <Field label="Access" htmlFor="fs-access" error={save.errors.access}>
            <NativeSelect id="fs-access" value={f.access} onChange={(e) => setF((p) => ({ ...p, access: e.target.value }))}>
              {FIELD_ACCESS.map((x) => (
                <option key={x} value={x}>
                  {x.replace("_", " ")}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Button type="submit" variant="primary" disabled={save.pending}>
            Add rule
          </Button>
        </form>
      ) : null}
    </AdminSection>
  );
}
