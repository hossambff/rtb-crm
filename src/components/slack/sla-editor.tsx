"use client";
import * as React from "react";
import { AdminSection, Field, Switch, useAction } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveApprovalSla } from "@/lib/approvals/actions";
import { APPROVAL_KIND_LABELS } from "@/lib/approvals/kinds";
import { DEFAULT_SLA_HOURS, MAX_SLA_HOURS, MIN_SLA_HOURS, type SlaSettings } from "@/lib/approvals/sla-core";

const KINDS = Object.keys(DEFAULT_SLA_HOURS);

const asDays = (h: number) => (h >= 24 && h % 24 === 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h} h`);

/** C7: per-kind approval SLA. Overdue requests escalate once to the next role up (executives / super admins). */
export function SlaEditor({ initial }: { initial: SlaSettings }) {
  const [hours, setHours] = React.useState<Record<string, string>>(() => Object.fromEntries(KINDS.map((k) => [k, String(initial.hours[k] ?? DEFAULT_SLA_HOURS[k])])));
  const [defaultHours, setDefaultHours] = React.useState(String(initial.defaultHours));
  const [pauseWeekends, setPauseWeekends] = React.useState(initial.pauseWeekends);
  const [timezone, setTimezone] = React.useState(initial.timezone);
  const { run, pending, errors } = useAction(saveApprovalSla, { success: "Approval SLAs saved" });

  const parsed = (v: string) => Math.round(Number(v));
  const invalid = (v: string) => !Number.isFinite(Number(v)) || v.trim() === "" || parsed(v) < MIN_SLA_HOURS || parsed(v) > MAX_SLA_HOURS;
  const anyInvalid = KINDS.some((k) => invalid(hours[k] ?? "")) || invalid(defaultHours);

  return (
    <AdminSection
      title="Approval SLAs"
      description="How long each kind of request may wait. Past due, the request shows as overdue and escalates once to the next role up (executives; super admins for executive approvals)."
    >
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {KINDS.map((k) => (
          <Field key={k} label={APPROVAL_KIND_LABELS[k] ?? k} htmlFor={`sla-${k}`} error={invalid(hours[k] ?? "") ? `${MIN_SLA_HOURS}–${MAX_SLA_HOURS} hours` : errors[`hours.${k}`]}>
            <div className="flex items-center gap-2">
              <Input
                id={`sla-${k}`}
                type="number"
                inputMode="numeric"
                min={MIN_SLA_HOURS}
                max={MAX_SLA_HOURS}
                value={hours[k] ?? ""}
                onChange={(e) => setHours((p) => ({ ...p, [k]: e.target.value }))}
                className="w-24 tabular-nums"
              />
              <span className="text-xs text-muted">hours{!invalid(hours[k] ?? "") ? ` · ${asDays(parsed(hours[k]!))}` : ""}</span>
            </div>
          </Field>
        ))}
        <Field label="Any other kind" htmlFor="sla-default" error={invalid(defaultHours) ? `${MIN_SLA_HOURS}–${MAX_SLA_HOURS} hours` : errors.defaultHours}>
          <div className="flex items-center gap-2">
            <Input id="sla-default" type="number" inputMode="numeric" value={defaultHours} onChange={(e) => setDefaultHours(e.target.value)} className="w-24 tabular-nums" />
            <span className="text-xs text-muted">hours</span>
          </div>
        </Field>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
        <label className="flex items-center gap-3">
          <Switch checked={pauseWeekends} onCheckedChange={setPauseWeekends} label="Weekends don't count" />
          <span>
            <span className="block text-sm text-fg">Weekends don’t count</span>
            <span className="block text-xs text-muted">The clock pauses Saturday–Sunday ({timezone}). 24 h from Friday 3 pm is due Monday 3 pm.</span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted">
          Time zone
          <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} className="h-8 w-48" aria-label="SLA time zone" />
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="primary"
          disabled={pending || anyInvalid}
          onClick={() =>
            run({
              hours: Object.fromEntries(KINDS.map((k) => [k, parsed(hours[k]!)])),
              defaultHours: parsed(defaultHours),
              pauseWeekends,
              timezone: timezone.trim(),
            })
          }
        >
          {pending ? "Saving…" : "Save SLAs"}
        </Button>
        <p className="text-xs text-muted">Applies to new requests; pending ones keep their due date.</p>
      </div>
    </AdminSection>
  );
}
