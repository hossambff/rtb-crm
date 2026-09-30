"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { updateProfile } from "@/lib/integrations/actions";

const HOURS = Array.from({ length: 25 }, (_, h) => h);
const fmtHour = (h: number) => (h === 24 ? "24:00" : `${String(h).padStart(2, "0")}:00`);

export function ProfileForm({
  profile,
  zones,
}: {
  profile: { name: string; email: string; title: string | null; timezone: string | null; workStartHour: number | null; workEndHour: number | null };
  zones: string[]; // from the server, so options match on hydration
}) {
  const [name, setName] = useState(profile.name);
  const [title, setTitle] = useState(profile.title ?? "");
  const [timezone, setTimezone] = useState(profile.timezone ?? "America/New_York");
  const [start, setStart] = useState(profile.workStartHour ?? 9);
  const [end, setEnd] = useState(profile.workEndHour ?? 18);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const res = await updateProfile({ name, title, timezone, workStartHour: start, workEndHour: end });
          if (!res.ok) {
            setErrors(res.fieldErrors ?? {});
            toast.error(res.error);
            return;
          }
          setErrors({});
          toast.success("Profile saved.");
        });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="p-name">Name</Label>
        <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name)} />
        {errors.name ? <p className="text-xs text-critical">{errors.name[0]}</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="p-email">Email</Label>
        <Input id="p-email" value={profile.email} disabled readOnly />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="p-title">Title</Label>
        <Input id="p-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Account Executive" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="p-tz">Timezone</Label>
        <NativeSelect id="p-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, " ")}
            </option>
          ))}
        </NativeSelect>
        {errors.timezone ? <p className="text-xs text-critical">{errors.timezone[0]}</p> : null}
      </div>
      <fieldset className="space-y-1.5 sm:col-span-2">
        <legend className="text-xs font-medium text-secondary">Working hours</legend>
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect aria-label="Start of working day" className="w-28" value={start} onChange={(e) => setStart(Number(e.target.value))}>
            {HOURS.slice(0, 24).map((h) => (
              <option key={h} value={h}>
                {fmtHour(h)}
              </option>
            ))}
          </NativeSelect>
          <span className="text-muted">to</span>
          <NativeSelect aria-label="End of working day" className="w-28" value={end} onChange={(e) => setEnd(Number(e.target.value))}>
            {HOURS.slice(1).map((h) => (
              <option key={h} value={h}>
                {fmtHour(h)}
              </option>
            ))}
          </NativeSelect>
          <span className="text-xs text-muted">Drives SLA timers, quiet hours and escalations.</span>
        </div>
        {errors.workEndHour ? <p className="text-xs text-critical">{errors.workEndHour[0]}</p> : null}
      </fieldset>
      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save profile"}
        </Button>
      </div>
    </form>
  );
}
