"use client";
import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { AdminSection, ConfirmButton, Field, useAction } from "@/components/admin/form";
import { fmtNumber } from "@/lib/format";
import { addAllowedDomain, removeAllowedDomain, testAiModel, updateSetting, type ModelTestResult } from "@/lib/admin/settings-actions";
import { SETTINGS_REGISTRY } from "@/lib/admin/settings-registry";

/* ───────────────────────────── Allowed domains ───────────────────────────── */

export function DomainsSection({ domains, superAdmin }: { domains: string[]; superAdmin: boolean }) {
  const id = React.useId();
  const [domain, setDomain] = React.useState("");
  const add = useAction(addAllowedDomain, { success: (d) => `${d.domain} added`, onSuccess: () => setDomain("") });
  const remove = useAction(removeAllowedDomain, { success: (d) => `${d.domain} removed` });
  return (
    <AdminSection
      title="Allowed sign-in domains"
      description={
        superAdmin
          ? "Google accounts on these domains can request access. Security setting — Super Admin only."
          : "Read-only: only a Super Admin can change sign-in domains."
      }
    >
      {domains.length === 0 ? (
        <EmptyState title="No domains" description="Sign-in falls back to the environment's ALLOWED_EMAIL_DOMAINS." />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {domains.map((d) => (
            <li key={d} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="text-fg">{d}</span>
              {superAdmin ? (
                <ConfirmButton
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${d}`}
                  title={`Remove ${d}?`}
                  description="New sign-ins from this domain will be refused. Existing users keep their accounts."
                  confirmLabel="Remove domain"
                  disabled={domains.length <= 1}
                  onConfirm={() => remove.run({ domain: d })}
                >
                  <Trash2 aria-hidden />
                </ConfirmButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {superAdmin ? (
        <form
          className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void add.run({ domain });
          }}
        >
          <Field label="Add domain" htmlFor={`${id}-domain`} error={add.errors.domain}>
            <Input id={`${id}-domain`} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" autoComplete="off" />
          </Field>
          <Button type="submit" disabled={add.pending || !domain.trim()}>
            <Plus aria-hidden /> Add
          </Button>
        </form>
      ) : null}
    </AdminSection>
  );
}

/* ───────────────────────────── AI models ───────────────────────────── */

export function AiModelsSection({ fast, strong, aiReady }: { fast: string; strong: string; aiReady: boolean }) {
  return (
    <AdminSection
      title="AI models"
      description={
        aiReady
          ? "Vercel AI Gateway model ids (provider/model). Test runs the id currently typed, before saving."
          : "AI gateway not configured — features run on deterministic fallbacks. Model ids can still be saved."
      }
    >
      <div className="space-y-5">
        <ModelRow tier="fast" settingKey="ai.model_fast" initial={fast} hint="Classification, extraction, short drafts." />
        <ModelRow tier="strong" settingKey="ai.model_strong" initial={strong} hint="Copilot answers, briefs, long analysis." />
      </div>
    </AdminSection>
  );
}

function ModelRow({ tier, settingKey, initial, hint }: { tier: "fast" | "strong"; settingKey: "ai.model_fast" | "ai.model_strong"; initial: string; hint: string }) {
  const id = React.useId();
  const [model, setModel] = React.useState(initial);
  const [result, setResult] = React.useState<ModelTestResult | { success: false; error: string; latencyMs?: undefined; reply?: undefined } | null>(null);
  const save = useAction(updateSetting, { success: `${SETTINGS_REGISTRY[settingKey].label} saved` });
  const test = useAction(testAiModel, {
    onSuccess: (r) => {
      setResult(r);
      if (r.success) toast.success(`Model responded in ${fmtNumber(r.latencyMs)} ms`);
      else toast.error(`Model test failed${r.error ? `: ${r.error}` : ""}`);
    },
    refresh: false,
  });
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <Field label={SETTINGS_REGISTRY[settingKey].label} htmlFor={`${id}-model`} error={save.errors.value ?? test.errors.model} hint={hint}>
          <Input
            id={`${id}-model`}
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setResult(null);
            }}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <Button
          type="button"
          disabled={test.pending || !model.trim()}
          onClick={async () => {
            const res = await test.run({ tier, model });
            if (!res.ok) setResult({ success: false, error: res.error });
          }}
        >
          {test.pending ? "Testing…" : "Test model"}
        </Button>
        <Button type="button" variant="primary" disabled={save.pending || model.trim() === initial} onClick={() => void save.run({ key: settingKey, value: model.trim() })}>
          Save
        </Button>
      </div>
      {result ? (
        <div className="flex flex-wrap items-center gap-2 text-xs" role="status">
          {result.success ? (
            <>
              <StatusBadge status="good" label="Responded" />
              <span className="tabular text-secondary">{fmtNumber(result.latencyMs)} ms</span>
              <span className="truncate text-muted">“{result.reply}”</span>
            </>
          ) : (
            <>
              <StatusBadge status="critical" label="Failed" />
              <span className="break-all text-secondary">{result.error}</span>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
