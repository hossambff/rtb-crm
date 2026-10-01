"use client";
import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};
const isApple = () => /Mac|iPhone|iPad|iPod/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? navigator.userAgent);

/** "⌘" on Apple devices, "Ctrl" elsewhere (QA POL-17). Renders "⌘" on the server, the platform's key after hydration. */
export function useModKey(): string {
  return useSyncExternalStore(
    noopSubscribe,
    () => (isApple() ? "⌘" : "Ctrl"),
    () => "⌘",
  );
}

/** Platform-aware modifier key label for shortcut hints. `then` is appended with a "+" off Apple ("Ctrl+K" vs "⌘K"). */
export function ModKey({ then }: { then?: string }) {
  const mod = useModKey();
  return (
    <>
      {mod}
      {then ? (mod === "⌘" ? then : `+${then}`) : null}
    </>
  );
}
