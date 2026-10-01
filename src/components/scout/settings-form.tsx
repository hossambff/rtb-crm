"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { removeApifyToken, saveApifyToken, saveScoutSettings, testApifyConnection, updateActor } from "@/lib/scout/actions";
import { FIT_FACTOR_LABELS, FIT_FACTORS, type FitFactor } from "@/lib/scout/fit";
import { TagInput } from "./tag-input";

type Settings = {
  visitsPerUnique: number;
  visitsPerUniqueByCategory: Record<string, number>;
  fitWeights: Record<FitFactor, number>;
  targetRoles: Record<string, string[]>;
  budget: { orgMonthlyCents: number; userMonthlyCents: number; execMonthlyCents: number; perRunMaxCents: number; maxDomainsPerRun: number };
  autoPromoteValidSenior: boolean;
};
type Apify = { connected: boolean; source: "env" | "org" | null; masked: string | null; username: string | null; lastError: string | null };
type Actor = { id: string; purpose: string; actorId: string; fallbackOrder: number; costPerResultUsd: number; enabled: boolean; compliant: boolean; timeoutSecs: number; maxItems: number };

export function ApifyTokenCard({ apify }: { apify: Apify }) {
  const router = useRouter();
  const [token, setToken] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Apify connection</CardTitle>
          <CardDescription>Org-level token, encrypted at rest. Users never see it; all calls are server-side.</CardDescription>
        </div>
        {apify.connected ? <Badge>Connected{apify.username ? ` · ${apify.username}` : ""}</Badge> : <Badge className="border-dashed">Not connected</Badge>}
      </CardHeader>
      <CardContent className="space-y-3">
        {apify.source === "env" ? (
          <p className="text-sm text-secondary">Using the APIFY_TOKEN environment variable. Remove it from the environment to manage the token here.</p>
        ) : (
          <>
            {apify.connected ? (
              <p className="flex items-center gap-2 text-sm text-secondary">
                <KeyRound className="size-4 text-muted" aria-hidden /> <span className="font-mono text-xs">{apify.masked}</span>
              </p>
            ) : null}
            {apify.lastError ? <p className="text-xs text-secondary">{apify.lastError}</p> : null}
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                const r = await saveApifyToken({ token });
                setBusy(false);
                if (!r.ok) return void toast.error(r.fieldErrors?.token?.[0] ?? r.error);
                setToken("");
                toast.success(r.data.warning ?? `Connected${r.data.username ? ` as ${r.data.username}` : ""}`);
                router.refresh();
              }}
            >
              <div className="min-w-64 flex-1 space-y-1.5">
                <Label htmlFor="apify-token">{apify.connected ? "Replace token" : "API token"}</Label>
                <Input id="apify-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="apify_api_…" />
              </div>
              <Button type="submit" variant="primary" disabled={busy || token.trim().length < 20}>
                Save token
              </Button>
              {apify.connected ? (
                <>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      const r = await testApifyConnection({});
                      if (r.ok) toast.success(`Apify OK — ${r.data.username}${r.data.plan ? ` (${r.data.plan})` : ""}`);
                      else toast.error(r.error);
                    }}
                  >
                    Test
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy}
                    onClick={async () => {
                      if (!window.confirm("Disconnect Apify? Discovery and enrichment will stop until a new token is added.")) return;
                      const r = await removeApifyToken({});
                      if (r.ok) {
                        toast.success("Apify disconnected");
                        router.refresh();
                      } else toast.error(r.error);
                    }}
                  >
                    <Trash2 aria-hidden /> Disconnect
                  </Button>
                </>
              ) : null}
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function ScoutSettingsForm({ initial }: { initial: Settings }) {
  const router = useRouter();
  const [vpu, setVpu] = React.useState(String(initial.visitsPerUnique));
  const [cats, setCats] = React.useState<[string, string][]>(Object.entries(initial.visitsPerUniqueByCategory).map(([k, v]) => [k, String(v)]));
  const [weights, setWeights] = React.useState<Record<FitFactor, string>>(Object.fromEntries(FIT_FACTORS.map((f) => [f, String(initial.fitWeights[f] ?? 0)])) as Record<FitFactor, string>);
  const [roles, setRoles] = React.useState<Record<string, string[]>>(initial.targetRoles);
  const [budget, setBudget] = React.useState({
    org: (initial.budget.orgMonthlyCents / 100).toFixed(2),
    user: (initial.budget.userMonthlyCents / 100).toFixed(2),
    exec: (initial.budget.execMonthlyCents / 100).toFixed(2),
    perRun: (initial.budget.perRunMaxCents / 100).toFixed(2),
    maxDomains: String(initial.budget.maxDomainsPerRun),
  });
  const [autoPromote, setAutoPromote] = React.useState(initial.autoPromoteValidSenior);
  const [busy, setBusy] = React.useState(false);
  const total = FIT_FACTORS.reduce((a, f) => a + (Number(weights[f]) || 0), 0);
  const cents = (s: string) => Math.round((Number(s) || 0) * 100);

  return (
    <form
      className="space-y-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await saveScoutSettings({
          visitsPerUnique: Number(vpu),
          visitsPerUniqueByCategory: Object.fromEntries(cats.filter(([k, v]) => k.trim() && Number(v) > 0).map(([k, v]) => [k.trim(), Number(v)])),
          fitWeights: Object.fromEntries(FIT_FACTORS.map((f) => [f, Number(weights[f]) || 0])) as Record<FitFactor, number>,
          targetRoles: roles as Record<"NET" | "SPT" | "ENT" | "R100", string[]>,
          budget: { orgMonthlyCents: cents(budget.org), userMonthlyCents: cents(budget.user), execMonthlyCents: cents(budget.exec), perRunMaxCents: cents(budget.perRun), maxDomainsPerRun: Math.round(Number(budget.maxDomains) || 1) },
          autoPromoteValidSenior: autoPromote,
        });
        setBusy(false);
        if (!r.ok) return void toast.error(r.error);
        toast.success("Lead Scout settings saved");
        router.refresh();
      }}
    >
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>MUU estimation</CardTitle>
              <CardDescription>Estimated MUU = monthly visits ÷ visits-per-unique factor (SCOUT-7). Calibrate against verified partner MUU.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="w-40 space-y-1.5">
              <Label htmlFor="vpu">Default factor</Label>
              <Input id="vpu" inputMode="decimal" value={vpu} onChange={(e) => setVpu(e.target.value)} />
            </div>
            <p className="text-xs font-medium text-secondary">Per-vertical overrides</p>
            {cats.map(([k, v], i) => (
              <div key={i} className="flex items-center gap-2">
                <Input aria-label="Vertical" className="min-w-0 flex-1 sm:w-48 sm:flex-none" value={k} onChange={(e) => setCats(cats.map((c, j) => (j === i ? [e.target.value, c[1]] : c)))} />
                <Input aria-label={`Factor for ${k || "vertical"}`} className="w-20 shrink-0 sm:w-24" inputMode="decimal" value={v} onChange={(e) => setCats(cats.map((c, j) => (j === i ? [c[0], e.target.value] : c)))} />
                <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${k}`} onClick={() => setCats(cats.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button type="button" size="sm" variant="ghost" onClick={() => setCats([...cats, ["", "2.5"]])}>
              <Plus aria-hidden /> Add override
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Fit Score weights</CardTitle>
              <CardDescription>Normalized to 100 when scoring. Current total: {total}.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            {FIT_FACTORS.map((f) => (
              <div key={f} className="space-y-1.5">
                <Label htmlFor={`w-${f}`}>{FIT_FACTOR_LABELS[f]}</Label>
                <Input id={`w-${f}`} inputMode="numeric" value={weights[f]} onChange={(e) => setWeights({ ...weights, [f]: e.target.value })} />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Target roles per motion</CardTitle>
              <CardDescription>Defaults for “Find executives”; sellers can edit per run.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {["NET", "SPT", "ENT", "R100"].map((m) => (
              <div key={m} className="space-y-1.5">
                <Label htmlFor={`roles-${m}`}>{m}</Label>
                <TagInput id={`roles-${m}`} value={roles[m] ?? []} onChange={(v) => setRoles({ ...roles, [m]: v })} aria-label={`${m} target roles`} />
              </div>
            ))}
            <label className="flex items-center gap-2 pt-2 text-sm">
              <input type="checkbox" className="accent-white" checked={autoPromote} onChange={(e) => setAutoPromote(e.target.checked)} />
              Auto-promote contacts with a verified (valid) email and a senior title
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Apify budget</CardTitle>
              <CardDescription>Defaults: org $5/month (the Apify free plan hard cap), user $2, SVP/exec $5, $0.50 per run, 50 domains per run.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            {(
              [
                ["org", "Org monthly cap ($)"],
                ["user", "Per user / month ($)"],
                ["exec", "SVP / exec / month ($)"],
                ["perRun", "Per run max ($)"],
                ["maxDomains", "Max domains per run"],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="space-y-1.5">
                <Label htmlFor={`b-${k}`}>{label}</Label>
                <Input id={`b-${k}`} inputMode="decimal" value={budget[k]} onChange={(e) => setBudget({ ...budget, [k]: e.target.value })} />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}

export function ActorRegistryTable({ actors }: { actors: Actor[] }) {
  const router = useRouter();
  const toggle = async (id: string, patch: { enabled?: boolean; compliant?: boolean }) => {
    const r = await updateActor({ id, ...patch });
    if (!r.ok) return void toast.error(r.error);
    router.refresh();
  };
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Actor registry</CardTitle>
          <CardDescription>Only enabled actors ticked as compliant (public data, no personal logged-in cookies) can run. Fallback order runs top to bottom.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="table-cards w-full min-w-[760px] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-border">
              <th className="px-5 py-2">Purpose</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2 text-right">Order</th>
              <th className="px-3 py-2 text-right">$/result</th>
              <th className="px-3 py-2 text-right">Max items · timeout</th>
              <th className="px-3 py-2">Compliant</th>
              <th className="px-3 py-2">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {actors.map((a) => (
              <tr key={a.id} className="border-b border-border last:border-0">
                <td data-label="Purpose" className="px-5 py-2 text-secondary">{a.purpose}</td>
                <td data-primary className="break-all px-3 py-2 font-mono text-xs text-body">{a.actorId}</td>
                <td data-label="Order" className="px-3 py-2 text-right tabular">{a.fallbackOrder}</td>
                <td data-label="$/result" className="px-3 py-2 text-right tabular">{a.costPerResultUsd.toFixed(4)}</td>
                <td data-label="Max items · timeout" className="px-3 py-2 text-right tabular text-muted">
                  {a.maxItems} · {a.timeoutSecs}s
                </td>
                <td data-label="Compliant" className="px-3 py-2">
                  <input type="checkbox" className="accent-white" aria-label={`${a.actorId} compliant`} checked={a.compliant} onChange={(e) => toggle(a.id, { compliant: e.target.checked })} />
                </td>
                <td data-label="Enabled" className="px-3 py-2">
                  <input type="checkbox" className="accent-white" aria-label={`${a.actorId} enabled`} checked={a.enabled} onChange={(e) => toggle(a.id, { enabled: e.target.checked })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
