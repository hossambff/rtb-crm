"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { addAudienceMetric } from "@/lib/accounts/actions";
import { METRIC_CONFIDENCE, METRIC_SOURCES, METRIC_TYPES } from "@/lib/accounts/constants";
import { Field } from "./create-account-dialog";

export function AddMetricForm({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});
  const [form, setForm] = React.useState({ metric: "muu", raw: "", period: new Date().toISOString().slice(0, 7), source: "Similarweb", confidence: "reported" });
  const upd = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <form
      className="grid gap-3 sm:grid-cols-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErrors({});
        const res = await addAudienceMetric({ accountId, ...form, metric: form.metric as never, confidence: form.confidence as never });
        setBusy(false);
        if (!res.ok) {
          setErrors(res.fieldErrors ?? {});
          toast.error(res.error);
          return;
        }
        toast.success("Audience metric added");
        setForm((f) => ({ ...f, raw: "" }));
        router.refresh();
      }}
    >
      <Field label="Metric" className="sm:col-span-2">
        <NativeSelect id="m-metric" value={form.metric} onChange={upd("metric")}>
          {METRIC_TYPES.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Value" error={errors.raw?.[0]}>
        <Input id="m-raw" value={form.raw} onChange={upd("raw")} placeholder="450k, 1.5–2M" required />
      </Field>
      <Field label="Period" error={errors.period?.[0]}>
        <Input id="m-period" type="month" value={form.period} onChange={upd("period")} required />
      </Field>
      <Field label="Source" error={errors.source?.[0]}>
        <Input id="m-source" list="m-sources" value={form.source} onChange={upd("source")} required />
        <datalist id="m-sources">
          {METRIC_SOURCES.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </Field>
      <Field label="Confidence">
        <NativeSelect id="m-conf" value={form.confidence} onChange={upd("confidence")}>
          {METRIC_CONFIDENCE.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="flex flex-wrap items-end gap-2 sm:col-span-6">
        <p className="mr-auto min-w-0 flex-1 basis-60 text-xs text-muted">Monthly visits are stored separately from MUU; a derived MUU (visits ÷ org factor) is kept as an estimate.</p>
        <Button type="submit" variant="secondary" size="sm" disabled={busy}>
          {busy ? "Saving…" : "Add metric"}
        </Button>
      </div>
    </form>
  );
}
