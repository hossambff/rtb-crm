"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { snoozePreset } from "@/lib/tasks/core";
import { cn } from "@/lib/utils";

function browserTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** `<input type="datetime-local">` value for a Date (browser local time). */
export function toLocalInput(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type Submit = (v: { reason: string; until?: string }) => Promise<string | null>;

/**
 * Dialog that requires a reason, optionally with a snooze time (presets + custom).
 * onSubmit returns an error message or null on success.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  withUntil,
  confirmLabel,
  reasonLabel = "Reason",
  reasonRequired = true,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  withUntil?: boolean;
  confirmLabel: string;
  reasonLabel?: string;
  reasonRequired?: boolean;
  onSubmit: Submit;
}) {
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [preset, setPreset] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const presets = [
    { key: "tomorrow", label: "Tomorrow 9:00" },
    { key: "in3days", label: "In 3 days" },
    { key: "nextweek", label: "Next Monday" },
  ] as const;

  function reset(o: boolean) {
    if (!o) {
      setReason("");
      setUntil("");
      setPreset(null);
      setError(null);
    }
    onOpenChange(o);
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (reasonRequired && reason.trim().length < 3) return setError("Please give a short reason (3+ characters).");
            if (withUntil && !until) return setError("Pick when it should come back.");
            setBusy(true);
            const err = await onSubmit({ reason: reason.trim(), until: withUntil ? new Date(until).toISOString() : undefined });
            setBusy(false);
            if (err) setError(err);
            else reset(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <DialogBody>
            {withUntil ? (
              <div className="space-y-2">
                <Label htmlFor="snooze-until">Until</Label>
                <div className="flex flex-wrap gap-2">
                  {presets.map((p) => (
                    <button
                      type="button"
                      key={p.key}
                      aria-pressed={preset === p.key}
                      onClick={() => {
                        setPreset(p.key);
                        setUntil(toLocalInput(snoozePreset(p.key, new Date(), browserTz())));
                      }}
                      className={cn(
                        "rounded-md border px-2.5 py-1 text-xs transition-colors duration-150",
                        preset === p.key ? "border-white text-fg" : "border-border-strong text-secondary hover:text-fg",
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <Input
                  id="snooze-until"
                  type="datetime-local"
                  value={until}
                  onChange={(e) => {
                    setPreset(null);
                    setUntil(e.target.value);
                  }}
                />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="reason-text">
                {reasonLabel}
                {reasonRequired ? " (required)" : ""}
              </Label>
              <Textarea id="reason-text" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus={!withUntil} maxLength={500} />
            </div>
            {error ? (
              <p role="alert" className="text-xs text-critical">
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => reset(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Saving…" : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
