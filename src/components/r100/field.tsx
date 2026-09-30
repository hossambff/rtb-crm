"use client";
import * as React from "react";
import { Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Labelled form field that wires the label to its single child control and shows the first field error. */
export function Field({
  label,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  className?: string;
  children: React.ReactElement<{ id?: string }>;
}) {
  const id = React.useId();
  return (
    <div className={cn("space-y-1", className)}>
      <Label htmlFor={id}>{label}</Label>
      {React.cloneElement(children, { id })}
      {error ? <p className="text-[11px] text-critical">{error}</p> : hint ? <p className="text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}
