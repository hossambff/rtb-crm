"use client";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { updateProfile } from "@/lib/integrations/actions";

/** Zones RTB people actually use — listed first so nobody scrolls past Africa/Abidjan (QA MIN-08). */
const COMMON_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Lisbon", "Europe/Paris", "Asia/Dubai", "Africa/Cairo", "Asia/Singapore", "UTC"];
const zoneLabel = (z: string) => z.replace(/_/g, " ");

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
  // Detected after mount (server and client must render the same options first).
  const [detected, setDetected] = useState<string | null>(null);
  useEffect(() => {
    try {
      const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only value, read once after hydration
      if (z && zones.includes(z)) setDetected(z);
    } catch {
      /* no Intl zone */
    }
  }, [zones]);
  const common = COMMON_ZONES.filter((z) => zones.includes(z));

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
        <NativeSelect id="p-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} aria-describedby="p-tz-hint">
          <optgroup label="Common">
            {common.map((z) => (
              <option key={`c-${z}`} value={z}>
                {zoneLabel(z)}
              </option>
            ))}
          </optgroup>
          <optgroup label="All time zones">
            {zones
              .filter((z) => !common.includes(z))
              .map((z) => (
                <option key={z} value={z}>
                  {zoneLabel(z)}
                </option>
              ))}
          </optgroup>
        </NativeSelect>
        <p id="p-tz-hint" className="text-xs text-muted">
          Type to jump to a zone.
          {detected && detected !== timezone ? (
            <>
              {" "}
              <button type="button" className="-my-2 py-2 text-fg underline underline-offset-2" onClick={() => setTimezone(detected)}>
                Use this device&apos;s zone ({zoneLabel(detected)})
              </button>
            </>
          ) : null}
        </p>
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
