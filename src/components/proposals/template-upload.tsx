"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect } from "@/components/ui/input";

const MAX = 2 * 1024 * 1024;

/** Admin upload of a .docx template (multipart POST to /api/proposals/templates). */
export function TemplateUpload({ kinds }: { kinds: { kind: string; label: string }[] }) {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState(kinds[0]?.kind ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const pick = (f: File | null) => {
    setError(null);
    if (!f) return setFile(null);
    if (!/\.docx$/i.test(f.name)) return setError("Only .docx files are accepted (not .doc, .docm or PDF).");
    if (f.size > MAX) return setError("The file is larger than 2 MB.");
    setFile(f);
    if (!name) setName(f.name.replace(/\.docx$/i, ""));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return setError("Choose a .docx file.");
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("kind", kind);
      body.set("name", name);
      const res = await fetch("/api/proposals/templates", { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string; candidates?: number; tierTables?: number; active?: boolean };
      if (!res.ok || !data.id) {
        setError(data.error ?? "Upload failed.");
        return;
      }
      toast.success(`Uploaded as a draft: ${data.candidates ?? 0} placeholders, ${data.tierTables ?? 0} tier table${data.tierTables === 1 ? "" : "s"} found. Review them, then activate.`);
      router.push(`/admin/templates/${data.id}`);
    } catch {
      setError("Upload failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="tpl-kind">Template for</Label>
          <NativeSelect id="tpl-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="tpl-name">Name</Label>
          <Input id="tpl-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Coalition term sheet, Q4" />
        </div>
      </div>
      <label
        htmlFor="tpl-file"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pick(e.dataTransfer.files[0] ?? null);
        }}
        className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong px-4 py-6 text-center transition-colors duration-150 hover:bg-surface-2"
      >
        <FileUp className="size-5 text-secondary" aria-hidden />
        <span className="text-sm text-fg">{file ? file.name : "Drop the .docx here or click to choose"}</span>
        <span className="text-xs text-muted">{file ? `${Math.round(file.size / 1024)} KB` : "Word .docx, up to 2 MB. Stored privately; never added to the code."}</span>
        <input ref={inputRef} id="tpl-file" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={busy || !file}>
          {busy ? <Loader2 className="animate-spin" /> : <FileUp />} Upload and scan
        </Button>
      </div>
    </form>
  );
}
