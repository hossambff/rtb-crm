"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { AdminSection, AdminTable, Field, Td, Th, useAction } from "@/components/admin/form";
import { toPctStr } from "@/components/admin/fields-editor-controls";
import { AiModelsSection, DomainsSection } from "@/components/admin/settings-editor-sections";
import { updateSetting } from "@/lib/admin/settings-actions";
import { AUTONOMY_ACTIONS, AUTONOMY_LEVELS, SETTINGS_REGISTRY, type AutonomyAction, type SettingKey, type SettingsValues } from "@/lib/admin/settings-registry";

type Kind = "int" | "number" | "percent" | "select";

export function SettingsEditor({ settings, domains, superAdmin, aiReady }: { settings: SettingsValues; domains: string[]; superAdmin: boolean; aiReady: boolean }) {
  return (
    <>
      <DomainsSection domains={domains} superAdmin={superAdmin} />
      <AiModelsSection fast={settings["ai.model_fast"]} strong={settings["ai.model_strong"]} aiReady={aiReady} />
      <AutonomySection value={settings["agent.autonomy"]} />
      <AdminSection title="Claims guardrail" description="What happens when a draft contains a banned or restricted claim (see Claims library).">
        <SettingRow
          settingKey="agent.claims_mode"
          kind="select"
          initial={settings["agent.claims_mode"]}
          options={[
            { value: "warn", label: "Warn — flag the claim and suggest the approved alternative" },
            { value: "block", label: "Block — drafts with banned claims can't be sent" },
          ]}
        />
      </AdminSection>
      <AdminSection title="Email" description="Gmail sync and Nothing-Slips thresholds.">
        <div className="space-y-4">
          <SettingRow settingKey="email.backfill_days" kind="int" initial={settings["email.backfill_days"]} unit="days" hint="History imported when a mailbox connects (1–365)." />
          <SettingRow settingKey="email.unanswered_hours" kind="int" initial={settings["email.unanswered_hours"]} unit="hours" hint="Prospect email counts as unanswered after this (1–720)." />
          <SettingRow
            settingKey="email.retention_unlinked_days"
            kind="int"
            initial={settings["email.retention_unlinked_days"]}
            unit="days"
            hint="Emails not linked to any record are purged after this (0–365)."
          />
        </div>
      </AdminSection>
      <AdminSection title="Pipeline & programs" description="Defaults used by value math, forecasting and approvals.">
        <div className="space-y-4">
          <SettingRow settingKey="pipeline.usd_per_muu" kind="number" initial={settings["pipeline.usd_per_muu"]} unit="$ / MUU / yr" hint="Default value per monthly unique user for new pipelines." />
          <SettingRow settingKey="pipeline.engaged_threshold" kind="percent" initial={settings["pipeline.engaged_threshold"]} unit="%" hint="Stages at or above this probability count as engaged." />
          <SettingRow
            settingKey="pipeline.override_approval_threshold_pts"
            kind="number"
            initial={settings["pipeline.override_approval_threshold_pts"]}
            unit="pts"
            hint="Probability overrides beyond this many points need executive approval (0–100)."
          />
          <SettingRow settingKey="r100.goal_live" kind="int" initial={settings["r100.goal_live"]} unit="companies" hint="Roundtable 100 live-profile goal." />
          <SettingRow
            settingKey="commission.registration_protect_days"
            kind="int"
            initial={settings["commission.registration_protect_days"]}
            unit="days"
            hint="Ownership protection for approved commission-rep registrations (1–365)."
          />
        </div>
      </AdminSection>
    </>
  );
}

function toInput(kind: Kind, v: unknown): string {
  if (kind === "percent") return toPctStr(typeof v === "number" ? v : null);
  return v == null ? "" : String(v);
}
function fromInput(kind: Kind, s: string): unknown {
  if (kind === "select") return s;
  const n = s.trim() === "" ? Number.NaN : Number(s);
  return kind === "percent" ? n / 100 : n;
}

function SettingRow({
  settingKey,
  kind,
  initial,
  unit,
  hint,
  options,
}: {
  settingKey: SettingKey;
  kind: Kind;
  initial: unknown;
  unit?: string;
  hint?: string;
  options?: { value: string; label: string }[];
}) {
  const id = React.useId();
  const initialStr = toInput(kind, initial);
  const [value, setValue] = React.useState(initialStr);
  const { run, pending, errors } = useAction(updateSetting, { success: `${SETTINGS_REGISTRY[settingKey].label} saved` });
  const label = `${SETTINGS_REGISTRY[settingKey].label}${unit && kind !== "select" ? ` (${unit})` : ""}`;
  return (
    <form
      className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        void run({ key: settingKey, value: fromInput(kind, value) });
      }}
    >
      <Field label={label} htmlFor={`${id}-v`} error={errors.value} hint={hint}>
        {kind === "select" ? (
          <NativeSelect id={`${id}-v`} value={value} onChange={(e) => setValue(e.target.value)}>
            {options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <Input
            id={`${id}-v`}
            className="tabular sm:max-w-48"
            type="number"
            inputMode="decimal"
            step={kind === "int" ? 1 : "any"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" size="sm" className="sm:mb-5" disabled={pending || value === initialStr}>
        Save
      </Button>
    </form>
  );
}

function AutonomySection({ value }: { value: Record<AutonomyAction, 0 | 1 | 2 | 3> }) {
  const id = React.useId();
  const [levels, setLevels] = React.useState(value);
  const dirty = AUTONOMY_ACTIONS.some((a) => levels[a.key] !== value[a.key]);
  const { run, pending, errors } = useAction(updateSetting, { success: "Agent autonomy saved" });
  return (
    <AdminSection
      title="Agent autonomy"
      description="Per action type (PRD §11.4). The agent never sends external email, marks deals won/lost, changes terms or deletes data without an explicit human action."
      actions={
        <Button size="sm" variant="primary" disabled={pending || !dirty} onClick={() => void run({ key: "agent.autonomy", value: levels })}>
          Save autonomy
        </Button>
      }
    >
      <AdminTable className="[&_table]:min-w-[480px]">
        <thead>
          <tr>
            <Th>Action</Th>
            <Th className="w-64">Level</Th>
          </tr>
        </thead>
        <tbody>
          {AUTONOMY_ACTIONS.map((a) => (
            <tr key={a.key}>
              <Td>
                <label htmlFor={`${id}-${a.key}`} className="text-fg">
                  {a.label}
                </label>
                <div className="text-xs text-muted">{AUTONOMY_LEVELS[levels[a.key]].hint}</div>
              </Td>
              <Td>
                <NativeSelect
                  id={`${id}-${a.key}`}
                  value={levels[a.key]}
                  onChange={(e) => setLevels({ ...levels, [a.key]: Number(e.target.value) as 0 | 1 | 2 | 3 })}
                >
                  {AUTONOMY_LEVELS.map((l) => (
                    <option key={l.value} value={l.value} disabled={a.key === "send_email" && l.value >= 2}>
                      {l.label}
                    </option>
                  ))}
                </NativeSelect>
              </Td>
            </tr>
          ))}
        </tbody>
      </AdminTable>
      {errors.value ? (
        <p className="mt-2 text-xs text-secondary" role="alert">
          {errors.value[0]}
        </p>
      ) : null}
    </AdminSection>
  );
}
