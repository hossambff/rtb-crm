"use client";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { UserOption } from "@/lib/tasks/queries";
import { TaskDialog } from "./task-dialog";

/** "New task" button; press `n` anywhere on the page (outside inputs) to open it. */
export function NewTaskButton({ users, size = "sm" }: { users: UserOption[]; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "n" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      if (document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <Button variant="primary" size={size} onClick={() => setOpen(true)} aria-keyshortcuts="n">
        <Plus /> New task
        <kbd className="ml-1 hidden rounded border border-black/20 px-1 text-[10px] sm:inline">N</kbd>
      </Button>
      <TaskDialog open={open} onOpenChange={setOpen} users={users} />
    </>
  );
}
