/**
 * Stage probability presets for MUU pipelines (PRD Appendix A). Pure — unit-tested.
 *
 * - "tiered": the default 100 / 90 / 50 / 10 scheme (seed values for MUU + ENT stages).
 * - "granular": the 19-status MASTER-file scheme mapped onto the system stage keys:
 *     Contract/Migrating/Beta 95% · Hot 90% · Demo 75% · Warming up 60% · Met 45% · In comms 40% · Call set 30% ·
 *     Stuck 20% · Hold 15% · Cold 10% · Outreach 8% · Target 6% · New 5% · On Pause 5% · Old Lead 3% · No status 2% ·
 *     Rejected 1%.
 * Won-category stages always stay 100%; lost-category stages get 0% (tiered) or 1% (granular, "Rejected").
 * Stage keys not covered by a preset keep their current probability.
 */
import type { PROBABILITY_PRESETS } from "./config-schemas";

export type ProbabilityPreset = (typeof PROBABILITY_PRESETS)[number];

export const PRESET_LABELS: Record<ProbabilityPreset, string> = {
  tiered: "Tiered (100 / 90 / 50 / 10)",
  granular: "Granular (Appendix A 19-status scheme)",
};

export const TIERED: Readonly<Record<string, number>> = {
  target: 0.1,
  outreach: 0.1,
  in_comms: 0.5,
  warming: 0.5,
  hot: 0.9,
  demo: 0.9,
  contract: 1,
  migrating: 1,
  live: 1,
  on_hold: 0.5,
  cold: 0.1,
  lost: 0,
  // ENT-only stages
  nda: 0.5,
  proposal: 0.5,
  negotiation: 0.9,
  won: 1,
};

export const GRANULAR: Readonly<Record<string, number>> = {
  target: 0.06, // Target 6%
  outreach: 0.08, // Outreach 8%
  in_comms: 0.4, // In comms 40% (Met 45% / Call set 30% collapse here)
  warming: 0.6, // Warming up 60%
  hot: 0.9, // Hot 90%
  demo: 0.75, // Demo 75%
  contract: 0.95, // Contract 95%
  migrating: 0.95, // Migrating 95% (won category → 100%, see below)
  live: 1,
  on_hold: 0.15, // Hold 15%
  cold: 0.1, // Cold 10%
  lost: 0.01, // Rejected 1%
  // ENT-only stages
  nda: 0.45, // Met 45% (NDA follows a first meeting)
  proposal: 0.6, // ≈ Warming up
  negotiation: 0.9, // ≈ Hot / Verbal
  won: 1,
};

export type PresetStage = { id: string; key: string; name: string; category: string; probability: number };
export type PresetChange = { id: string; key: string; name: string; before: number; after: number; changed: boolean };

export function presetProbability(preset: ProbabilityPreset, stage: Pick<PresetStage, "key" | "category" | "probability">): number {
  if (stage.category === "won") return 1;
  if (stage.category === "lost") return preset === "granular" ? 0.01 : 0;
  const table = preset === "granular" ? GRANULAR : TIERED;
  return table[stage.key] ?? stage.probability;
}

/** Before → after preview for applying a preset to a pipeline's stages. */
export function previewPreset(preset: ProbabilityPreset, stages: PresetStage[]): PresetChange[] {
  return stages.map((s) => {
    const after = presetProbability(preset, s);
    return { id: s.id, key: s.key, name: s.name, before: s.probability, after, changed: Math.abs(after - s.probability) > 1e-9 };
  });
}

export function presetSettingKey(pipelineKey: string): string {
  return `pipeline.probability_preset.${pipelineKey}`;
}
