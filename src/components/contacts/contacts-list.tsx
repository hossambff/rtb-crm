"use client";
import * as React from "react";
import Link from "next/link";
import { Search, UserX, X } from "lucide-react";
import { createColumnHelper } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Pager, ServerTable, type ColumnUi, type ListFeatures } from "@/components/accounts/server-table";
import { useQueryParams } from "@/components/accounts/use-query-params";
import { fmtRelative } from "@/lib/format";

export type ContactRowDto = {
  id: string;
  fullName: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  doNotContact: boolean;
  lastContactedAt: string | null;
  accountId: string | null;
  accountName: string | null;
  relationshipOwner: string | null;
};

const h = createColumnHelper<ListFeatures, ContactRowDto>();
const columns = h.columns([
  h.accessor("fullName", {
    header: "Name",
    cell: (c) => (
      <span className="inline-flex items-center gap-1.5">
        <Link href={`/contacts/${c.row.original.id}`} className="font-medium text-fg hover:underline">
          {c.getValue()}
        </Link>
        {c.row.original.doNotContact ? <UserX className="size-3 text-muted" aria-label="Do not contact" /> : null}
      </span>
    ),
  }),
  h.accessor("title", { header: "Title", cell: (c) => <span className="text-secondary">{c.getValue() ?? "—"}</span> }),
  h.accessor("accountName", {
    header: "Account",
    cell: (c) =>
      c.row.original.accountId ? (
        <Link href={`/accounts/${c.row.original.accountId}`} className="text-secondary hover:text-fg hover:underline">
          {c.getValue()}
        </Link>
      ) : (
        <span className="text-muted">—</span>
      ),
  }),
  h.accessor("email", { header: "Email", cell: (c) => (c.getValue() ? <a href={`mailto:${c.getValue()}`} className="text-secondary hover:text-fg">{c.getValue()}</a> : <span className="text-muted">{c.row.original.phone ?? "—"}</span>) }),
  h.accessor("relationshipOwner", { header: "Relationship", cell: (c) => <span className="text-secondary">{c.getValue() ?? "—"}</span> }),
  h.accessor("status", { header: "Status", cell: (c) => <Badge>{c.getValue() === "left_company" ? "Left company" : "Active"}</Badge> }),
  h.accessor("lastContactedAt", { header: "Last contacted", cell: (c) => <span className="text-xs text-muted">{fmtRelative(c.getValue())}</span> }),
]);

const UI: Record<string, ColumnUi> = {
  fullName: { sortKey: "name" },
  title: { hideOnMobile: true, className: "max-w-[200px] truncate" },
  accountName: { sortKey: "account", className: "max-w-[200px] truncate" },
  email: { hideOnMobile: true, className: "max-w-[240px] truncate" },
  relationshipOwner: { hideOnMobile: true },
  status: { hideOnMobile: true },
  lastContactedAt: { sortKey: "lastContacted" },
};

export function ContactsList({ rows, total, page, pageSize, owners }: { rows: ContactRowDto[]; total: number; page: number; pageSize: number; owners: { id: string; name: string }[] }) {
  const { get, set, pending } = useQueryParams();
  const [q, setQ] = React.useState(get("q"));
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const sort = get("sort") || "name";
  const dir = (get("dir") || (sort === "lastContacted" ? "desc" : "asc")) as "asc" | "desc";
  const active = ["status", "owner", "dnc"].filter((k) => get(k));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (timer.current) clearTimeout(timer.current);
              const v = e.target.value;
              timer.current = setTimeout(() => set({ q: v.trim() || null }), 250);
            }}
            placeholder="Search name, email, title, account…"
            aria-label="Search contacts"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <NativeSelect aria-label="Status" value={get("status")} onChange={(e) => set({ status: e.target.value || null })} className="h-8 w-auto min-w-28 text-xs">
          <option value="">Status</option>
          <option value="active">Active</option>
          <option value="left_company">Left company</option>
        </NativeSelect>
        <NativeSelect aria-label="Relationship owner" value={get("owner")} onChange={(e) => set({ owner: e.target.value || null })} className="h-8 w-auto min-w-28 text-xs">
          <option value="">Relationship owner</option>
          <option value="me">Mine</option>
          <option value="none">None</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Do not contact" value={get("dnc")} onChange={(e) => set({ dnc: e.target.value || null })} className="h-8 w-auto min-w-28 text-xs">
          <option value="">Any consent</option>
          <option value="yes">Do not contact</option>
        </NativeSelect>
        {active.length ? (
          <Button size="sm" variant="ghost" onClick={() => set(Object.fromEntries(active.map((k) => [k, null])))}>
            <X /> Clear
          </Button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <EmptyState title={q || active.length ? "No contacts match" : "No contacts yet"} description={q || active.length ? "Try a different search or clear filters." : "Add contacts manually, from an account, or import them."} />
      ) : (
        <>
          <ServerTable
            columns={columns}
            ui={UI}
            data={rows}
            sort={sort}
            dir={dir}
            pending={pending}
            rowHref={(r) => `/contacts/${r.id}`}
            onSort={(key) => set({ sort: key, dir: sort === key ? (dir === "asc" ? "desc" : "asc") : key === "lastContacted" ? "desc" : "asc" })}
          />
          <Pager page={page} pageSize={pageSize} total={total} onPage={(p) => set({ page: String(p) }, { resetPage: false })} onSize={(n) => set({ size: String(n) })} />
        </>
      )}
    </div>
  );
}
