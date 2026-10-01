"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Save, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { INPUT_KEYS, INPUT_LABELS, type CandidateKind } from "@/lib/proposals/docx/detect";
import { showTokenText } from "./show-token";
import { addCustomToken, removeCustomToken, saveTemplateMapping } from "@/lib/proposals/template-actions";

export type MappingCandidate = { id: string; kind: CandidateKind; text: string; context: string; occurrences: number; suggested: string };

const KIND_LABEL: Record<CandidateKind, string> = { bracket: "[Token]", underscore: "Blank ___", tabs: "Tab blank", date: "Date", custom: "Phrase" };

const showToken = showTokenText;

export function TemplateMapping({
  templateId,
  candidates,
  initial,
  readOnly,
  reviewed = true,
}: {
  templateId: string;
  candidates: MappingCandidate[];
  initial: Record<string, string>;
  readOnly?: boolean;
  /** False until an admin saved the mapping once — the suggestions must be confirmed before activation (QA MAJ-19). */
  reviewed?: boolean;
}) {
  const router = useRouter();
  const [map, setMap] = React.useState<Record<string, string>>(initial);
  const [customDraft, setCustomDraft] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(initial).filter(([, v]) => v.startsWith("custom:")).map(([k, v]) => [k, v.slice(7)])),
  );
  const [phrase, setPhrase] = React.useState("");
  const [pending, start] = React.useTransition();
  const dirty = candidates.some((c) => (map[c.id] ?? "ignore") !== (initial[c.id] ?? "ignore"));
  const mapped = candidates.filter((c) => (map[c.id] ?? "ignore") !== "ignore").length;

  const setTarget = (id: string, v: string) => {
    if (v === "__custom") {
      const label = customDraft[id] || "";
      setMap({ ...map, [id]: `custom:${label}` });
    } else setMap({ ...map, [id]: v });
  };

  const save = () =>
    start(async () => {
      const bad = Object.values(map).find((v) => v === "custom:" || (v.startsWith("custom:") && !/^custom:[A-Za-z0-9][A-Za-z0-9 _./&()-]{0,39}$/.test(v)));
      if (bad !== undefined) return void toast.error("Name each custom field (letters, digits, spaces; max 40).");
      const res = await saveTemplateMapping({ id: templateId, map: candidates.map((c) => ({ token: c.id, input: map[c.id] ?? "ignore" })) });
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Saved: ${res.data.mapped} placeholder${res.data.mapped === 1 ? "" : "s"} mapped`);
      router.refresh();
    });

  const add = () =>
    start(async () => {
      const res = await addCustomToken({ id: templateId, token: phrase });
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Added (${res.data.occurrences} occurrence${res.data.occurrences === 1 ? "" : "s"}). Map it below.`);
      setPhrase("");
      router.refresh();
    });

  return (
    <div className="space-y-4">
      {candidates.length === 0 ? (
        <p className="text-sm text-muted">No placeholders were detected. Add a phrase from the document below to make it fillable.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-surface-1 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Found in the document</th>
                <th className="px-3 py-2 font-medium">Context</th>
                <th className="w-[250px] px-3 py-2 font-medium">Fill with</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const v = map[c.id] ?? "ignore";
                const isCustom = v.startsWith("custom:");
                return (
                  <tr key={c.id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge>{KIND_LABEL[c.kind]}</Badge>
                        <code className="break-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg">{showToken(c.text)}</code>
                        {c.occurrences > 1 ? <span className="text-xs text-muted">×{c.occurrences}</span> : null}
                      </div>
                    </td>
                    <td className="max-w-[360px] px-3 py-2 text-xs text-secondary">{c.context}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <NativeSelect aria-label={`Fill ${showToken(c.text)} with`} value={isCustom ? "__custom" : v} disabled={readOnly || pending} onChange={(e) => setTarget(c.id, e.target.value)}>
                          <option value="ignore">Leave as is</option>
                          {INPUT_KEYS.map((k) => (
                            <option key={k} value={k}>
                              {INPUT_LABELS[k]}
                            </option>
                          ))}
                          <option value="__custom">Custom field…</option>
                        </NativeSelect>
                        {c.kind === "custom" && !readOnly ? (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Remove this phrase"
                            disabled={pending}
                            onClick={() =>
                              start(async () => {
                                const res = await removeCustomToken({ id: templateId, token: c.id });
                                if (!res.ok) return void toast.error(res.error);
                                router.refresh();
                              })
                            }
                          >
                            <X />
                          </Button>
                        ) : null}
                      </div>
                      {isCustom ? (
                        <Input
                          aria-label="Custom field name"
                          className="mt-1 h-8 text-xs"
                          placeholder="Field name, e.g. Launch market"
                          maxLength={40}
                          disabled={readOnly || pending}
                          value={customDraft[c.id] ?? v.slice(7)}
                          onChange={(e) => {
                            setCustomDraft({ ...customDraft, [c.id]: e.target.value });
                            setMap({ ...map, [c.id]: `custom:${e.target.value.trim()}` });
                          }}
                        />
                      ) : null}
                      {v === "ignore" && c.suggested !== "ignore" ? <p className="mt-1 text-[11px] text-muted">Suggested: {INPUT_LABELS[c.suggested as keyof typeof INPUT_LABELS] ?? c.suggested}</p> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!readOnly ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <form
            className="flex min-w-0 flex-1 flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (phrase.trim().length >= 2) add();
            }}
          >
            <label className="min-w-[220px] flex-1 text-xs text-secondary">
              <span className="mb-1 block">Add a phrase from the document (e.g. the target market wording)</span>
              <Input value={phrase} maxLength={200} onChange={(e) => setPhrase(e.target.value)} placeholder="Exact text as it appears in one paragraph" />
            </label>
            <Button type="submit" disabled={pending || phrase.trim().length < 2}>
              <Plus /> Add phrase
            </Button>
          </form>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted tabular">
              {mapped} of {candidates.length} mapped
            </span>
            <Button variant="primary" onClick={save} disabled={pending || (!dirty && reviewed)}>
              <Save /> {reviewed || dirty ? "Save mapping" : "Confirm mapping"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
