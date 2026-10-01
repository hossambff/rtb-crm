"use client";
import { useEffect, useState } from "react";
import { CopilotPanel } from "@/components/copilot/copilot-panel";

const EVENT = "rtb:copilot";

/** Open the global Copilot side panel from anywhere (optionally asking `prompt` right away). */
export function openCopilot(prompt?: string) {
  window.dispatchEvent(new CustomEvent<{ prompt?: string }>(EVENT, { detail: { prompt } }));
}

/**
 * Close the ⌘K palette (or any other open Radix dialog that isn't Copilot) before Copilot opens, so two modals never
 * stack (QA MIN-10). Radix dismisses its top layer on Escape keydown at the document.
 */
function closeOtherDialogs() {
  if (typeof document === "undefined") return;
  if (!document.querySelector("[role=dialog] [cmdk-root], [cmdk-root][role=dialog], [role=dialog][data-command-palette]")) return;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

/**
 * One Copilot panel for the whole app (V2 §B7), mounted by the topbar for users who may use Copilot.
 * Opens on ⌘J / Ctrl+J or an `openCopilot()` call (My Day's Ask bar and suggestions, the checklist).
 */
export function CopilotLauncher() {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<string | undefined>();
  const [nonce, setNonce] = useState<string>();
  useEffect(() => {
    const onOpen = (e: Event) => {
      closeOtherDialogs();
      setPrompt((e as CustomEvent<{ prompt?: string }>).detail?.prompt || undefined);
      setNonce(crypto.randomUUID()); // per open: the same suggested question asked twice is sent twice (QA MAJ-03)
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        closeOtherDialogs();
        setPrompt(undefined);
        setOpen((o) => !o);
      }
    };
    window.addEventListener(EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <CopilotPanel
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setPrompt(undefined);
      }}
      initialPrompt={open ? prompt : undefined}
      promptNonce={nonce}
    />
  );
}
