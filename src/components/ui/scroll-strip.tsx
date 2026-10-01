"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

const ACTIVE_SELECTOR = '[aria-current="page"],[aria-current="step"],[aria-current="true"],[aria-selected="true"],[data-state="active"],[data-active="true"]';

/**
 * Wires a horizontally scrolling strip: sets `data-fade` (start|end|both) for the `.scroll-fade-x` edge mask and
 * scrolls the active item (aria-current / aria-selected / data-state=active / data-active) into view on mount and
 * whenever `activeKey` changes. Works on any element with overflow-x.
 */
export function useScrollStrip<T extends HTMLElement>(activeKey?: unknown) {
  const ref = React.useRef<T>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const atStart = el.scrollLeft <= 2;
      const atEnd = el.scrollLeft >= max - 2;
      const fade = max <= 2 ? "" : atStart ? "end" : atEnd ? "start" : "both";
      if (fade) el.dataset.fade = fade;
      else delete el.dataset.fade;
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const active = el.querySelector<HTMLElement>(ACTIVE_SELECTOR);
    if (!active) return;
    // Center the active item within the strip without scrolling the page vertically.
    const box = el.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    const left = el.scrollLeft + (item.left - box.left) - (el.clientWidth - item.width) / 2;
    el.scrollTo({ left: Math.max(0, left), behavior: "auto" });
  }, [activeKey]);
  return ref;
}

/**
 * A horizontally scrolling chip/tab strip: hidden scrollbar, edge-fade hint, active item scrolled into view.
 * Children keep their own layout; pass flex/gap classes via className.
 */
export function ScrollStrip({
  className,
  activeKey,
  as: Comp = "div",
  ...props
}: React.HTMLAttributes<HTMLElement> & { activeKey?: unknown; as?: "div" | "nav" | "ul" }) {
  const ref = useScrollStrip<HTMLElement>(activeKey);
  return React.createElement(Comp, {
    ref,
    className: cn("scrollbar-none scroll-fade-x overflow-x-auto overscroll-x-contain", className),
    ...props,
  });
}
