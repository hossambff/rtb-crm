"use client";
import * as React from "react";
import { VIZ } from "@/lib/palette";

/**
 * Tiny inline trend (no axes). Pure SVG so it renders on the server with no layout shift.
 * The line is 2px in the series hue; the latest point carries an end-dot with a surface ring.
 */
export function Sparkline({
  values,
  color = VIZ[0],
  width = 96,
  height = 28,
  label,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  label?: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 4;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const [lx, ly] = pts[pts.length - 1]!;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? `Trend: ${values.join(", ")}`}>
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={3} fill={color} stroke="#0B0B0B" strokeWidth={2} />
    </svg>
  );
}
