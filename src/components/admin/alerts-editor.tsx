"use client";
import * as React from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/misc";
import { AdminSection, AdminTable, Field, Switch, Td, Th, useAction } from "@/components/admin/form";
import { numOrNull } from "@/components/admin/fields-editor-controls";
import { ALERT_SEVERITIES, validateAlertParams } from "@/lib/admin/config-schemas";
import { setAlertRuleEnabled, updateAlertRule } from "@/lib/admin/alerts-actions";
import type { AdminAlertRule } from "@/lib/admin/config-queries";

type Severity = (typeof ALERT_SEVERITIES)[number];
const SEVERITY_LABEL: Record<Severity, string> = { info: "Info", warning: "Warning", serious: "Serious", critical: "Critical" };

export function SeverityBadge({ severity }: { severity: Severity }) {
  if (severity === "info") return <Badge>{SEVERITY_LABEL.info}</Badge>;
  return <StatusBadge status={severity} label={SEVERITY_LABEL[severity]} />;
}

function paramsSummary(p: Record<string, unknown>): string {
  const entries = Object.entries(p);
  if (!entries.length) return "—";
  return entries.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("/") : String(v)}`).join(" · ");
}

export function AlertsEditor({ rules }: { rules: AdminAlertRule[] }) {
  const [editing, setEditing] = React.useState<AdminAlertRule | null>(null);
  const enabledCount = rules.filter((r) => r.enabled).length;
  return (
    <AdminSection
      title="Nothing Slips alert rules"
      description={`${enabledCount} of ${rules.length} rules enabled. Thresholds, severity and escalation are editable; toggles save immediately.`}
    >
      {rules.length === 0 ? (
        <EmptyState title="No alert rules" description="Run the seed script to install the PRD §12.1 alert catalog." />
      ) : (
        <AdminTable cards>
          <thead>
            <tr>
              <Th className="w-16">Code</Th>
              <Th>Rule</Th>
              <Th className="w-20">On</Th>
              <Th>Severity</Th>
              <Th className="text-right">Escalate</Th>
              <Th>Parameters</Th>
              <Th className="w-12">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.code} className={r.enabled ? undefined : "opacity-60"}>
                <Td label="Code" className="whitespace-nowrap text-xs text-muted tabular">{r.code}</Td>
                <Td label="Rule" primary>
                  <div className="min-w-0">
                    <div className="font-medium text-fg">{r.name}</div>
                    {r.description ? <div className="text-xs text-muted">{r.description}</div> : null}
                  </div>
                </Td>
                <Td label="On">
                  <EnabledToggle code={r.code} name={r.name} enabled={r.enabled} />
                </Td>
                <Td label="Severity">
                  <SeverityBadge severity={r.severity} />
                </Td>
                <Td label="Escalate" className="text-right tabular">{r.escalateAfterHours != null ? `${r.escalateAfterHours}h` : "—"}</Td>
                <Td label="Parameters" className="truncate md:max-w-56 text-xs text-secondary tabular">
                  <span title={JSON.stringify(r.params)}>{paramsSummary(r.params ?? {})}</span>
                </Td>
                <Td actions>
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${r.code} ${r.name}`} onClick={() => setEditing(r)}>
                    <Pencil aria-hidden />
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>{editing ? <RuleForm rule={editing} onDone={() => setEditing(null)} /> : null}</DialogContent>
      </Dialog>
    </AdminSection>
  );
}

function EnabledToggle({ code, name, enabled }: { code: string; name: string; enabled: boolean }) {
  const [optimistic, setOptimistic] = React.useState<boolean | null>(null);
  const { run, pending } = useAction(setAlertRuleEnabled, { success: (d) => `${code} ${d.enabled ? "enabled" : "disabled"}` });
  return (
    <Switch
      label={`${code} ${name} enabled`}
      checked={optimistic ?? enabled}
      disabled={pending}
      onCheckedChange={async (on) => {
        setOptimistic(on);
        await run({ code, enabled: on });
        setOptimistic(null);
      }}
    />
  );
}

function RuleForm({ rule, onDone }: { rule: AdminAlertRule; onDone: () => void }) {
  const id = React.useId();
  const [severity, setSeverity] = React.useState<Severity>(rule.severity);
  const [esc, setEsc] = React.useState(rule.escalateAfterHours != null ? String(rule.escalateAfterHours) : "");
  const [paramsText, setParamsText] = React.useState(JSON.stringify(rule.params ?? {}, null, 2));
  const check = validateAlertParams(paramsText, rule.params ?? {});
  const { run, pending, errors } = useAction(updateAlertRule, { success: `${rule.code} saved`, onSuccess: onDone });
  const paramsError = !check.ok ? check.error : errors.paramsText;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!check.ok) return;
        void run({ code: rule.code, severity, escalateAfterHours: numOrNull(esc), paramsText });
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {rule.code} · {rule.name}
        </DialogTitle>
        {rule.description ? <DialogDescription>{rule.description}</DialogDescription> : null}
      </DialogHeader>
      <DialogBody>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Severity" htmlFor={`${id}-sev`} error={errors.severity}>
            <NativeSelect id={`${id}-sev`} value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
              {ALERT_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Escalate after (hours)" htmlFor={`${id}-esc`} error={errors.escalateAfterHours} hint="Empty = no escalation">
            <Input id={`${id}-esc`} className="tabular" type="number" min="1" max="720" value={esc} onChange={(e) => setEsc(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Parameters (JSON)"
          htmlFor={`${id}-params`}
          error={paramsError}
          hint={Object.keys(rule.params ?? {}).length ? "Keep the same keys and value types." : "This rule has no parameters."}
        >
          <Textarea
            id={`${id}-params`}
            rows={6}
            spellCheck={false}
            className="font-mono text-xs"
            value={paramsText}
            onChange={(e) => setParamsText(e.target.value)}
            aria-invalid={!check.ok}
          />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !check.ok}>
          Save rule
        </Button>
      </DialogFooter>
    </form>
  );
}
