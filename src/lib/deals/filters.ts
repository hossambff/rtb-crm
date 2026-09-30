/** URL ⇄ board filter/view state (KAN-4). Pure + client-safe. */
import type { BoardFilters, BoardView, Lane, Priority, StageCategory } from "./types";

type SP = Record<string, string | string[] | undefined> | URLSearchParams;

function get(sp: SP, key: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(key) ?? undefined;
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

const PRIORITIES = ["top10", "high", "medium", "low", "none"];
const STATUSES = ["open", "won", "lost", "hold"];

export function parseBoardParams(sp: SP): { filters: BoardFilters; lane: Lane; view: BoardView } {
  const q = get(sp, "q")?.trim().slice(0, 120) || undefined;
  const owner = get(sp, "owner")?.trim() || undefined;
  const p = get(sp, "priority");
  const priority = p && PRIORITIES.includes(p) ? (p as Priority | "none") : undefined;
  const category = get(sp, "category")?.trim().slice(0, 80) || undefined;
  const overdue = get(sp, "overdue") === "1" ? true : undefined;
  const st = get(sp, "status");
  const status = st && STATUSES.includes(st) ? (st as StageCategory) : undefined;
  const l = get(sp, "lane");
  const lane: Lane = l === "owner" || l === "priority" ? l : "none";
  const view: BoardView = get(sp, "view") === "list" ? "list" : "board";
  return { filters: { q, owner, priority, category, overdue, status }, lane, view };
}

/** Build the query string for a filter/view change (drops empty values, keeps others). */
export function withParam(current: URLSearchParams, key: string, value: string | null | undefined): string {
  const next = new URLSearchParams(current.toString());
  if (value == null || value === "" || value === "none-selected") next.delete(key);
  else next.set(key, value);
  const s = next.toString();
  return s ? `?${s}` : "?";
}

export function activeFilterCount(f: BoardFilters): number {
  return [f.q, f.owner, f.priority, f.category, f.overdue, f.status].filter((v) => v != null && v !== "").length;
}
