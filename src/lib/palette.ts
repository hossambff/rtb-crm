/** Chart palette (PRD §16A.4) — validated on #0B0B0B. Fixed order; never cycled. */
export const VIZ = ["#5C98D5", "#CE7C4C", "#44A781", "#AB6DBA", "#A9933B", "#6C79C7", "#CF6872", "#13A5B2"] as const;
export const VIZ_OTHER = "#828282";
/** Scatter / all-pairs charts: max 3 series from slots 1, 5, 7. */
export const VIZ_SCATTER = ["#5C98D5", "#A9933B", "#CF6872"] as const;

export const PIPELINE_COLORS: Record<string, string> = {
  NET: "#5C98D5",
  ENT: "#AB6DBA",
  SPT: "#44A781",
  R100: "#A9933B",
  ADS: "#CE7C4C",
  PAY: "#13A5B2",
};

export const STATUS_COLORS = {
  good: "#44A781",
  warning: "#A9933B",
  serious: "#CE7C4C",
  critical: "#CF6872",
} as const;

/** Sequential single-hue blue ramp (low → high). */
export const SEQ_BLUE = ["#1B2B3D", "#243B55", "#2E4D70", "#3C6590", "#4F80B3", "#6B9BCF", "#9CC3EA"] as const;

export const CHART_AXIS = { stroke: "#2E2E2E", tick: "#828282", grid: "#1A1A1A", surface: "#0B0B0B" } as const;

export function healthStatus(score: number | null | undefined): keyof typeof STATUS_COLORS {
  if (score == null) return "warning";
  if (score >= 70) return "good";
  if (score >= 50) return "warning";
  if (score >= 30) return "serious";
  return "critical";
}
