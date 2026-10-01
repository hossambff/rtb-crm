import * as React from "react";
import Link from "next/link";
import { Download, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { fmtNumber } from "@/lib/format";
import { auditQuery, jsonDiff, visibleDiff, type AuditFilters, type DiffEntry } from "@/lib/admin/audit-core";
import type { AuditRow } from "@/lib/admin/audit-queries";
import { AdminSection } from "./form";

function short(v: unknown, max = 160): string {
  if (v === undefined) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const KIND_MARK: Record<DiffEntry["kind"], string> = { added: "+", removed: "−", changed: "~" };

function Diff({ row }: { row: AuditRow }) {
  if (row.redacted) return <p className="text-xs text-muted">Restricted record — details are visible only to its access list.</p>;
  const all = jsonDiff(row.before, row.after);
  const entries = visibleDiff(all);
  if (!entries.length)
    return <p className="text-xs text-muted">{row.before == null && row.after == null ? "No payload recorded." : "No field changes (bookkeeping only)."}</p>;
  return (
    <table className="table-cards w-full text-left text-xs">
      <thead>
        <tr className="text-muted">
          <th scope="col" className="w-6 py-1 font-medium">
            <span className="sr-only">Change</span>
          </th>
          <th scope="col" className="py-1 pr-3 font-medium">Field</th>
          <th scope="col" className="py-1 pr-3 font-medium">Before</th>
          <th scope="col" className="py-1 font-medium">After</th>
        </tr>
      </thead>
      <tbody>
        {entries.slice(0, 80).map((e) => (
          <tr key={e.path} className="border-t border-border/60 align-top">
            <td data-select className="py-1 font-mono text-muted" aria-label={e.kind}>
              {KIND_MARK[e.kind]}
            </td>
            <td data-label="Field" data-primary className="break-all py-1 pr-3 font-mono text-secondary md:break-normal">{e.path}</td>
            <td data-label="Before" className="break-all py-1 pr-3 font-mono text-muted line-through decoration-border-strong">{e.kind === "added" ? "" : short(e.before)}</td>
            <td data-label="After" className="break-all py-1 font-mono text-body">{e.kind === "removed" ? "" : short(e.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AuditFilterBar({
  f,
  actors,
  entities,
  hasSystem,
  canExport,
}: {
  f: AuditFilters;
  actors: { id: string; name: string }[];
  entities: string[];
  hasSystem: boolean;
  canExport: boolean;
}) {
  return (
    <form method="get" action="/admin/audit" className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
      <div className="space-y-1.5">
        <Label htmlFor="au-actor">Actor</Label>
        <NativeSelect id="au-actor" name="actor" defaultValue={f.actor ?? ""}>
          <option value="">Anyone</option>
          {hasSystem ? <option value="system">System / jobs</option> : null}
          {actors.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="au-entity">Entity</Label>
        <NativeSelect id="au-entity" name="entity" defaultValue={f.entity ?? ""}>
          <option value="">Any</option>
          {entities.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="au-action">Action contains</Label>
        <Input id="au-action" name="action" defaultValue={f.action ?? ""} placeholder="e.g. admin.user" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="au-from">From</Label>
        <Input id="au-from" name="from" type="date" defaultValue={f.from ?? ""} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="au-to">To</Label>
        <Input id="au-to" name="to" type="date" defaultValue={f.to ?? ""} />
      </div>
      <div className="flex flex-wrap items-end gap-2 sm:col-span-2 2xl:col-span-3">
        <Button type="submit" variant="primary">
          Apply
        </Button>
        <Button asChild variant="ghost">
          <Link href="/admin/audit">Clear</Link>
        </Button>
        {canExport ? (
          <Button asChild variant="secondary" aria-label="Export CSV">
            <a href={`/admin/audit/export${auditQuery({ ...f, page: 1 })}`}>
              <Download /> CSV
            </a>
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function AuditTable({ rows, total, f, pageSize }: { rows: AuditRow[]; total: number; f: AuditFilters; pageSize: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <AdminSection title="Audit log" description={`${fmtNumber(total)} entries · immutable, newest first. Expand a row for the before/after diff.`}>
      {rows.length === 0 ? (
        <EmptyState title="No audit entries" description="Nothing matches these filters." />
      ) : (
        <ul className="-mx-4 divide-y divide-border/60 border-y border-border">
          {rows.map((r) => (
            <li key={r.id}>
              <details className="group">
                <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-2 text-sm hover:bg-surface-2/50 [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted transition-transform duration-150 group-open:rotate-90" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-fg">{r.action}</span>
                    <span className="block truncate text-[11px] text-muted">
                      <time className="tabular" dateTime={new Date(r.createdAt).toISOString()}>
                        {new Date(r.createdAt).toISOString().slice(0, 19).replace("T", " ")} UTC
                      </time>
                      {" · "}
                      {r.actorName ?? (r.actorId ? r.actorId.slice(0, 8) : r.actorKind)}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    {r.entity ? <Badge>{r.entity}</Badge> : null}
                    {r.actorKind !== "user" ? <Badge>{r.actorKind}</Badge> : null}
                    {r.redacted ? <Badge>restricted</Badge> : null}
                  </span>
                </summary>
                <div className="space-y-2 bg-surface-2/30 px-4 py-3 sm:pl-11">
                  <p className="text-[11px] text-muted [overflow-wrap:anywhere]">
                    #{r.id} · entity {r.entity ?? "—"} {r.entityId ? <span className="font-mono">{r.entityId}</span> : null} · IP {r.ip ?? "—"}
                  </p>
                  <Diff row={r} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 ? (
        <nav aria-label="Pagination" className="mt-3 flex items-center justify-between text-xs text-muted">
          <span>
            Page {f.page} of {fmtNumber(pages)}
          </span>
          <span className="flex gap-2">
            {f.page > 1 ? (
              <Button asChild size="sm" variant="secondary">
                <Link href={`/admin/audit${auditQuery(f, { page: f.page - 1 })}`}>Previous</Link>
              </Button>
            ) : null}
            {f.page < pages ? (
              <Button asChild size="sm" variant="secondary">
                <Link href={`/admin/audit${auditQuery(f, { page: f.page + 1 })}`}>Next</Link>
              </Button>
            ) : null}
          </span>
        </nav>
      ) : null}
    </AdminSection>
  );
}
