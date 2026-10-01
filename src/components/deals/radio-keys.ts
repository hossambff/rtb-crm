import type * as React from "react";

/**
 * QA MIN-07: arrow-key roving for the custom button radiogroups (WAI-ARIA radio pattern). Put on the
 * `role="radiogroup"` element; give each `role="radio"` button `tabIndex={checked ? 0 : -1}`.
 */
export function onRadioGroupKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!dir) return;
  const radios = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])'));
  if (!radios.length) return;
  e.preventDefault();
  const i = radios.findIndex((r) => r === document.activeElement || r.getAttribute("aria-checked") === "true");
  const next = radios[(Math.max(0, i) + dir + radios.length) % radios.length]!;
  next.focus();
  next.click();
}
