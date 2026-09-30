/**
 * Board shaping (KAN-3 / KAN-8): card order, per-column totals over ALL filtered deals, and trimming to the first N
 * cards per stage so large boards (2,500+ cards) stay fast. Pure + client-safe; unit tested.
 */
import { PRIORITY_ORDER, type BoardDeal } from "./types";

export const CARDS_PER_STAGE = 50;

export type ColumnTotals = { count: number; muu: number; gross: number; net: number | null; weighted: number };

export function sortCards(a: BoardDeal, b: BoardDeal): number {
  const pa = a.priority ? PRIORITY_ORDER[a.priority]! : 9;
  const pb = b.priority ? PRIORITY_ORDER[b.priority]! : 9;
  if (pa !== pb) return pa - pb;
  if (b.overdueDays !== a.overdueDays) return b.overdueDays - a.overdueDays;
  return b.weightedUsd - a.weightedUsd || b.muu - a.muu || a.name.localeCompare(b.name);
}

export function columnTotals(deals: BoardDeal[]): Record<string, ColumnTotals> {
  const out: Record<string, ColumnTotals> = {};
  for (const d of deals) {
    const t = (out[d.stageId] ??= { count: 0, muu: 0, gross: 0, net: 0, weighted: 0 });
    t.count++;
    t.muu += d.muu;
    t.gross += d.grossUsd;
    t.weighted += d.weightedUsd;
    if (d.netUsd === undefined) t.net = null;
    else if (t.net !== null) t.net += d.netUsd;
  }
  return out;
}

/** Sort each stage's cards and keep the first `perStage` (+ offset window for "show more"). */
export function trimPerStage(deals: BoardDeal[], perStage = CARDS_PER_STAGE): BoardDeal[] {
  const by = new Map<string, BoardDeal[]>();
  for (const d of deals) (by.get(d.stageId) ?? by.set(d.stageId, []).get(d.stageId)!).push(d);
  const out: BoardDeal[] = [];
  for (const list of by.values()) out.push(...list.sort(sortCards).slice(0, perStage));
  return out;
}

export function stageSlice(deals: BoardDeal[], stageId: string, offset: number, limit: number): BoardDeal[] {
  return deals
    .filter((d) => d.stageId === stageId)
    .sort(sortCards)
    .slice(offset, offset + limit);
}
