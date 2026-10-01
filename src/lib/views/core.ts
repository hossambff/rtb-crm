/** Saved views & smart list defaults (docs/V2_SPEC.md §B8) — pure helpers, client-safe, unit tested. */

/** Params never stored in a view (pagination and one-off selections). */
export const VOLATILE_PARAMS = ["page", "task", "thread", "approval", "deal", "selected"];
export const MAX_VIEW_PARAMS = 20;
export const MAX_VIEWS_PER_PAGE = 30;
/** Page keys: "accounts", "contacts", "deals", "pipelines:NET" … */
export const PAGE_KEY = /^[a-z][a-z0-9_-]{1,30}(:[A-Za-z0-9_-]{1,30})?$/;

/** Keep simple string params, drop volatile ones and empties, cap sizes; stable key order. */
export function sanitizeParams(input: Record<string, unknown> | URLSearchParams): Record<string, string> {
  const entries: [string, unknown][] = input instanceof URLSearchParams ? [...input.entries()] : Object.entries(input);
  const out: Record<string, string> = {};
  for (const [k, raw] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v !== "string" || !v.trim() || VOLATILE_PARAMS.includes(k)) continue;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/.test(k)) continue;
    out[k] = v.slice(0, 200);
    if (Object.keys(out).length >= MAX_VIEW_PARAMS) break;
  }
  return out;
}

export function toQueryString(params: Record<string, string>): string {
  const q = new URLSearchParams(Object.entries(params)).toString();
  return q ? `?${q}` : "";
}

/**
 * Href for a client-side list navigation (filters, sort, clear, apply a view). An empty query becomes `?page=1`:
 * `page` is volatile (never stored), so the remembered "last" view becomes "no filters", and — because the request still
 * carries a param — `resolveListView` treats it as an explicit choice instead of a fresh entry. Without this, clearing
 * the filters would bounce straight back to the remembered/default view.
 */
export function listHref(pathname: string, query: string): string {
  const q = query.replace(/^\?/, "");
  return `${pathname}?${q || "page=1"}`;
}

export function sameParams(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

export type ViewRow = { params: Record<string, string>; isDefault: boolean; isLast: boolean };

/**
 * What a list opens on when entered without params: the user's default named view → their last-used filters (an
 * empty last view means "everything", on purpose) → the smart default ("Mine", or "My team" for leaders).
 * Returns null when nothing should be applied.
 */
export function pickEntryParams(views: ViewRow[], smart: Record<string, string> | null): Record<string, string> | null {
  const def = views.find((v) => v.isDefault);
  if (def) return Object.keys(def.params).length ? def.params : null;
  const last = views.find((v) => v.isLast);
  if (last) return Object.keys(last.params).length ? last.params : null;
  return smart && Object.keys(smart).length ? smart : null;
}

/**
 * Smart default owner filter for a role. `teamValue` null = the page has no team filter.
 * Executives and admins see everything by default (they own little and have no team — "My team" would be empty);
 * sales leaders get "My team" only when they actually lead other people.
 */
export function smartOwnerParams(role: string, ownerParam: string, teamValue: string | null, hasTeam = true): Record<string, string> {
  if (["executive", "admin", "super_admin"].includes(role)) return {};
  if (role === "sales_leader") return teamValue && hasTeam ? { [ownerParam]: teamValue } : {};
  if (["viewer", "finance", "editorial", "onboarding"].includes(role)) return {};
  return { [ownerParam]: "me" };
}
