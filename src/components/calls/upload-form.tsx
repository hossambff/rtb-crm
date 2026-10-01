"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DealPicker, type PickedDeal } from "@/components/inbox/deal-picker";
import { ACCEPTED_EXTENSIONS, MAX_TRANSCRIPT_BYTES, validateTranscriptFile } from "@/lib/transcripts/parse";

/** CALL-4 manual upload / paste with consent confirmation (CALL-11). Posts multipart to /api/integrations/transcripts. */
export function UploadForm({
  initialDeal,
  meeting,
  consentText,
}: {
  initialDeal: PickedDeal | null;
  meeting: { id: string; title: string | null; startsAtLocal: string | null } | null;
  consentText: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"paste" | "file">("paste");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState(meeting?.title ?? "");
  const [occurredAt, setOccurredAt] = useState(meeting?.startsAtLocal ?? "");
  const [deal, setDeal] = useState<PickedDeal | null>(initialDeal);
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  function pickFile(f: File | null) {
    if (!f) return;
    const err = validateTranscriptFile(f.name, f.size);
    if (err) {
      setErrors((e) => ({ ...e, file: err }));
      setFile(null);
      return;
    }
    setErrors((e) => ({ ...e, file: "" }));
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (mode === "file" && !file) errs.file = "Choose a .txt, .vtt, .srt or .md file.";
    if (mode === "paste" && text.trim().length < 20) errs.text = "Paste the transcript (at least a few lines).";
    if (mode === "paste" && new Blob([text]).size > MAX_TRANSCRIPT_BYTES) errs.text = "The transcript is larger than 2 MB.";
    if (!consent) errs.consent = "Please confirm participants were notified.";
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;

    const fd = new FormData();
    if (mode === "file" && file) fd.set("file", file);
    else fd.set("text", text);
    fd.set("title", title);
    if (deal) fd.set("dealId", deal.id);
    if (meeting) fd.set("meetingId", meeting.id);
    if (occurredAt) fd.set("occurredAt", new Date(occurredAt).toISOString());
    fd.set("consent", "true");
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/transcripts", { method: "POST", body: fd });
      const json = (await res.json()) as { ok?: boolean; id?: string; error?: string; fieldErrors?: Record<string, string[]> };
      if (!res.ok || !json.id) {
        setErrors(Object.fromEntries(Object.entries(json.fieldErrors ?? {}).map(([k, v]) => [k, v[0] ?? ""])));
        toast.error(json.error ?? "Upload failed.");
        setBusy(false);
        return;
      }
      toast.success("Transcript saved. Analysis is running…");
      router.push(`/calls/${json.id}`);
    } catch {
      toast.error("Network error — please try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {meeting ? (
        <p className="rounded-md border border-border px-3 py-2 text-xs text-secondary">
          Attaching to meeting <span className="text-fg">{meeting.title ?? "Untitled meeting"}</span>
        </p>
      ) : null}
      <Tabs value={mode} onValueChange={(v) => setMode(v as "paste" | "file")}>
        <TabsList>
          <TabsTrigger value="paste">Paste text</TabsTrigger>
          <TabsTrigger value="file">Upload file</TabsTrigger>
        </TabsList>
        <TabsContent value="paste" className="space-y-1.5">
          <Label htmlFor="t-text">Transcript</Label>
          <Textarea
            id="t-text"
            rows={14}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"[00:00:05] Alex: Thanks for joining…\n[00:00:12] Jane: Happy to be here…"}
            className="font-mono text-xs"
            aria-invalid={Boolean(errors.text)}
          />
          <p className="text-xs text-muted">Speaker labels (“Name: …”) and timestamps are kept when present. Max 2 MB.</p>
          {errors.text ? <p className="text-xs text-critical">{errors.text}</p> : null}
        </TabsContent>
        <TabsContent value="file" className="space-y-1.5">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pickFile(e.dataTransfer.files?.[0] ?? null);
            }}
            className={`flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center transition-colors ${dragging ? "border-white bg-surface-2" : "border-border-strong"}`}
          >
            <FileUp className="size-6 text-muted" aria-hidden />
            <p className="break-all text-sm text-body">{file ? file.name : "Drop a transcript here"}</p>
            <p className="text-xs text-muted">{ACCEPTED_EXTENSIONS.join(", ")} · up to 2 MB</p>
            <Button type="button" size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
              Choose file
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPTED_EXTENSIONS.join(",")}
              className="sr-only"
              aria-label="Transcript file"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
          </div>
          {errors.file ? <p className="text-xs text-critical">{errors.file}</p> : null}
        </TabsContent>
      </Tabs>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="t-title">Title</Label>
          <Input id="t-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Reach x RTB — discovery" maxLength={200} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="t-date">Call date</Label>
          <Input id="t-date" type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </div>
      </div>
      <DealPicker value={deal} onChange={setDeal} label="Deal (optional)" placeholder="Search deals to attach…" />

      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-3">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-4 accent-white" aria-invalid={Boolean(errors.consent)} />
        <span className="text-sm text-body">
          {consentText}
          {errors.consent ? <span className="mt-1 block text-xs text-critical">{errors.consent}</span> : null}
        </span>
      </label>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          <Upload /> {busy ? "Saving…" : "Save & analyze"}
        </Button>
      </div>
    </form>
  );
}
