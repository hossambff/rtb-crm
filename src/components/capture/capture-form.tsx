"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, Check, CheckCircle2, Mic, MicOff, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { DealPicker, type PickedDeal } from "@/components/inbox/deal-picker";
import { applyCapture, parseCapture } from "@/lib/capture/actions";
import type { CaptureParse } from "@/lib/capture/core";
import { cn } from "@/lib/utils";
import { ModKey } from "@/components/ui/mod-key";

/* Minimal Web Speech API typing (not in TS's DOM lib). */
type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type SpeechEvent = { resultIndex: number; results: ArrayLike<SpeechResult> };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
/** Our own Permissions-Policy (or an embedding page) can forbid the microphone: then the mic button must not show. */
function microphoneAllowedByPolicy(): boolean {
  const d = document as unknown as { permissionsPolicy?: { allowsFeature?: (f: string) => boolean }; featurePolicy?: { allowsFeature?: (f: string) => boolean } };
  const policy = d.permissionsPolicy ?? d.featurePolicy;
  try {
    return policy?.allowsFeature ? policy.allowsFeature("microphone") !== false : true;
  } catch {
    return true;
  }
}
function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  if (!microphoneAllowedByPolicy()) return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const fromDateInput = (v: string) => (v ? new Date(`${v}T17:00:00Z`).toISOString() : null);

type Item<T> = T & { on: boolean };
type Preview = {
  engine: string;
  note: Item<{ text: string }>;
  tasks: Item<{ title: string; due: string }>[];
  nextStep: Item<{ text: string; due: string }> | null;
  fields: Item<{ field: "muu" | "expected_close_date"; value: string; label: string }>[];
};

function toPreview(p: CaptureParse): Preview {
  return {
    engine: p.engine,
    note: { text: p.note, on: Boolean(p.note) },
    tasks: p.tasks.map((t) => ({ title: t.title, due: toDateInput(t.due), on: true })),
    nextStep: p.nextStep ? { text: p.nextStep.text, due: toDateInput(p.nextStep.due), on: true } : null,
    fields: p.fieldUpdates.map((f) => ({ ...f, on: true })),
  };
}

/**
 * V2 A10 quick capture: dictate (Web Speech API where available) or type → preview with checkboxes → apply to a deal or
 * account. Works without AI (heuristic "todo:" / "next step:" parsing). Used by the topbar dialog and the /capture page.
 */
export function CaptureForm({ onDone, autoFocus = true, initialTarget = null }: { onDone?: () => void; autoFocus?: boolean; initialTarget?: PickedDeal | null }) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState<PickedDeal | null>(initialTarget);
  const [autoTarget, setAutoTarget] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState<{ href: string; summary: string; name: string } | null>(null);
  const [pending, start] = useTransition();
  const [listening, setListening] = useState(false);
  const [speechOk, setSpeechOk] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const baseText = useRef("");

  useEffect(() => {
    // Feature detection must run client-side only (after hydration).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSpeechOk(Boolean(recognitionCtor()));
    return () => rec.current?.stop();
  }, []);

  function toggleMic() {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = true;
    baseText.current = text ? `${text.trimEnd()} ` : "";
    r.onresult = (e) => {
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      setText(`${baseText.current}${finalText}${interim}`.slice(0, 5000));
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") toast.error("Microphone access is blocked for this site. Allow it in your browser's site settings, or type the note instead.");
      else if (e.error === "no-speech") toast.message("Didn't catch anything — try again a little closer to the mic.");
      else if (e.error === "audio-capture") toast.error("No microphone found. Type the note instead.");
      setListening(false);
    };
    r.onend = () => setListening(false);
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }

  function review() {
    rec.current?.stop();
    start(async () => {
      const r = await parseCapture({ text, target: target ? { kind: target.kind ?? "deal", id: target.id } : null });
      if (!r.ok) {
        toast.error(r.fieldErrors?.text?.[0] ?? r.error);
        return;
      }
      setPreview(toPreview(r.data.parse));
      if (!target && r.data.target) {
        setTarget({ id: r.data.target.id, name: r.data.target.name, kind: r.data.target.kind, subtitle: r.data.target.kind === "deal" ? "Deal" : "Account" });
        setAutoTarget(true);
      }
    });
  }

  const isDeal = (target?.kind ?? "deal") === "deal";
  const chosen = preview
    ? {
        note: preview.note.on ? preview.note.text.trim() : "",
        tasks: preview.tasks.filter((t) => t.on && t.title.trim().length >= 2),
        nextStep: isDeal && preview.nextStep?.on && preview.nextStep.text.trim().length >= 2 ? preview.nextStep : null,
        fields: isDeal ? preview.fields.filter((f) => f.on) : [],
      }
    : null;
  const count = chosen ? (chosen.note ? 1 : 0) + chosen.tasks.length + (chosen.nextStep ? 1 : 0) + chosen.fields.length : 0;

  function apply() {
    if (!preview || !chosen || !target) return;
    start(async () => {
      const r = await applyCapture({
        target: { kind: target.kind ?? "deal", id: target.id },
        note: chosen.note,
        tasks: chosen.tasks.map((t) => ({ title: t.title.trim(), due: fromDateInput(t.due) })),
        nextStep: chosen.nextStep ? { text: chosen.nextStep.text.trim(), due: fromDateInput(chosen.nextStep.due) } : null,
        fieldUpdates: chosen.fields.map((f) => ({ field: f.field, value: f.value })),
        engine: preview.engine,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const parts = [r.data.note ? "note" : null, r.data.tasks ? `${r.data.tasks} task${r.data.tasks === 1 ? "" : "s"}` : null, r.data.nextStep ? "next step" : null, r.data.fields ? `${r.data.fields} field${r.data.fields === 1 ? "" : "s"}` : null].filter(Boolean);
      setDone({ href: r.data.href, summary: parts.join(" · "), name: target.name });
      toast.success(`Saved to ${target.name}`);
    });
  }

  function reset() {
    setText("");
    setPreview(null);
    setDone(null);
    setTarget(initialTarget);
    setAutoTarget(false);
  }

  if (done) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center" role="status">
        <CheckCircle2 className="size-8 text-good motion-safe:animate-[pulse_600ms_ease-out_1]" aria-hidden />
        <p className="font-display text-xl text-fg">Captured</p>
        <p className="text-sm text-secondary">
          {done.summary} saved to{" "}
          <Link href={done.href} className="text-fg underline-offset-2 hover:underline" onClick={onDone}>
            {done.name}
          </Link>
        </p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="secondary" onClick={reset}>
            Capture another
          </Button>
          {onDone ? (
            <Button size="sm" variant="ghost" onClick={onDone}>
              Close
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!preview) {
    return (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          review();
        }}
      >
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="capture-text">What happened?</Label>
            <span className="text-[11px] text-muted tabular">{text.length ? `${text.length}/5000` : ""}</span>
          </div>
          <div className="relative">
            <Textarea
              id="capture-text"
              value={text}
              autoFocus={autoFocus}
              rows={6}
              maxLength={5000}
              placeholder={"Call with Reach — they're at 2.5M monthly uniques.\ntodo: send the pro forma by Friday\nnext step: legal review next week"}
              className={cn("pr-14 text-[15px] leading-6", listening && "border-border-strong")}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim().length >= 2) {
                  e.preventDefault();
                  review();
                }
              }}
            />
            {speechOk ? (
              <button
                type="button"
                onClick={toggleMic}
                aria-pressed={listening}
                aria-label="Dictate"
                title={listening ? "Stop dictation" : "Dictate"}
                className={cn(
                  "absolute right-1.5 top-1.5 grid size-11 place-items-center rounded-full border transition-colors duration-150",
                  listening ? "border-fg bg-fg text-accent-inverse" : "border-border-strong text-secondary hover:bg-surface-2 hover:text-fg",
                )}
              >
                {listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </button>
            ) : null}
          </div>
          <p className="text-[11px] text-muted">
            {listening ? "Listening… tap the mic to stop." : `Say or type “todo:” for tasks and “next step:” for the deal’s next step.${speechOk ? " Tap the mic to dictate." : ""}`}
          </p>
        </div>
        <DealPicker value={target} onChange={(d) => { setTarget(d); setAutoTarget(false); }} kinds={["deal", "account"]} label="Deal or account" placeholder="Optional — detected from the note" />
        <div className="flex items-center justify-end gap-2">
          {onDone ? (
            <Button type="button" variant="ghost" size="sm" onClick={onDone}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" variant="primary" size="sm" disabled={pending || text.trim().length < 2}>
            <Sparkles /> {pending ? "Reading…" : "Review"}
            <kbd className="ml-1 hidden rounded border border-accent-inverse/20 px-1 text-[10px] sm:inline">
              <ModKey then="↵" />
            </kbd>
          </Button>
        </div>
      </form>
    );
  }

  const set = (fn: (p: Preview) => Preview) => setPreview((p) => (p ? fn(p) : p));
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <DealPicker value={target} onChange={(d) => { setTarget(d); setAutoTarget(false); }} kinds={["deal", "account"]} label="Save to" placeholder="Search deals or accounts" />
        {autoTarget && target ? <p className="text-[11px] text-muted">Detected from your note — change it if that’s wrong.</p> : null}
        {!target ? <p className="text-[11px] text-warning">Pick a deal or account to save to.</p> : null}
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Note</legend>
        <div className={cn("flex gap-3 rounded-md border px-3 py-2", preview.note.on ? "border-border-strong" : "border-border opacity-60")}>
          <input type="checkbox" className="mt-1.5 size-4 accent-white" checked={preview.note.on} aria-label="Save the note" onChange={(e) => set((p) => ({ ...p, note: { ...p.note, on: e.target.checked } }))} />
          <Textarea rows={3} value={preview.note.text} aria-label="Note" className="min-h-0 border-0 bg-transparent p-0 focus-visible:ring-0" onChange={(e) => set((p) => ({ ...p, note: { ...p.note, text: e.target.value } }))} />
        </div>
      </fieldset>

      {preview.tasks.length ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Tasks</legend>
          {preview.tasks.map((t, i) => (
            <div key={i} className={cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2", t.on ? "border-border-strong" : "border-border opacity-60")}>
              <input type="checkbox" className="size-4 accent-white" checked={t.on} aria-label={`Create task “${t.title}”`} onChange={(e) => set((p) => ({ ...p, tasks: p.tasks.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)) }))} />
              <Input value={t.title} aria-label="Task" className="h-8 min-w-0 flex-1 text-sm" onChange={(e) => set((p) => ({ ...p, tasks: p.tasks.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) }))} />
              <Input type="date" value={t.due} aria-label="Due date" className="h-8 w-36 text-xs" onChange={(e) => set((p) => ({ ...p, tasks: p.tasks.map((x, j) => (j === i ? { ...x, due: e.target.value } : x)) }))} />
            </div>
          ))}
        </fieldset>
      ) : null}

      {preview.nextStep || preview.fields.length ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Deal updates</legend>
          {!isDeal ? <p className="text-xs text-muted">Pick a deal (not an account) to apply these.</p> : null}
          {preview.nextStep ? (
            <div className={cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2", preview.nextStep.on && isDeal ? "border-border-strong" : "border-border opacity-60")}>
              <input type="checkbox" className="size-4 accent-white" disabled={!isDeal} checked={preview.nextStep.on} aria-label="Set next step" onChange={(e) => set((p) => ({ ...p, nextStep: p.nextStep ? { ...p.nextStep, on: e.target.checked } : null }))} />
              <span className="w-20 text-xs text-secondary">Next step</span>
              <Input value={preview.nextStep.text} aria-label="Next step" className="h-8 min-w-0 flex-1 text-sm" onChange={(e) => set((p) => ({ ...p, nextStep: p.nextStep ? { ...p.nextStep, text: e.target.value } : null }))} />
              <Input type="date" value={preview.nextStep.due} aria-label="Next step due" className="h-8 w-36 text-xs" onChange={(e) => set((p) => ({ ...p, nextStep: p.nextStep ? { ...p.nextStep, due: e.target.value } : null }))} />
            </div>
          ) : null}
          {preview.fields.map((f, i) => (
            <label key={f.field} className={cn("flex items-center gap-2 rounded-md border px-3 py-2 text-sm", f.on && isDeal ? "border-border-strong text-body" : "border-border text-muted opacity-60")}>
              <input type="checkbox" className="size-4 accent-white" disabled={!isDeal} checked={f.on} onChange={(e) => set((p) => ({ ...p, fields: p.fields.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)) }))} />
              {f.label}
            </label>
          ))}
        </fieldset>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" size="sm" onClick={() => setPreview(null)}>
          <ArrowLeft /> Edit text
        </Button>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted">{preview.engine.startsWith("ai:") ? "Parsed by AI" : "Parsed without AI"}</span>
          <Button type="button" variant="primary" size="sm" disabled={pending || !target || count === 0} onClick={apply}>
            <Check /> {pending ? "Saving…" : `Apply ${count || ""}`.trim()}
          </Button>
        </div>
      </div>
    </div>
  );
}
