/**
 * Actor input templating (PRD SCOUT-20). Pure — unit tested.
 *
 * Registry input templates are JSON with placeholders:
 * - A string that is exactly "{{name}}" is replaced by the typed value (array, number, boolean, object).
 * - A placeholder embedded in a longer string is replaced by its string form (arrays joined with ", ").
 * - An array like ["{{query}}"] whose single element is an array-valued placeholder is flattened.
 * - Unknown placeholders: exact matches are dropped (key removed); embedded ones become "".
 */
export type TemplateVars = Record<string, unknown>;

const EXACT = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/;
const EMBEDDED = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const DROP = Symbol("drop");

function asString(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(asString).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function render(node: unknown, vars: TemplateVars): unknown {
  if (typeof node === "string") {
    const exact = node.match(EXACT);
    if (exact) {
      const key = exact[1]!;
      return key in vars && vars[key] !== undefined ? vars[key] : DROP;
    }
    return node.replace(EMBEDDED, (_, key: string) => asString(vars[key]));
  }
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const el of node) {
      const r = render(el, vars);
      if (r === DROP) continue;
      // ["{{queries}}"] where queries is an array → flatten
      if (typeof el === "string" && EXACT.test(el) && Array.isArray(r)) out.push(...r);
      else out.push(r);
    }
    return out;
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const r = render(v, vars);
      if (r !== DROP) out[k] = r;
    }
    return out;
  }
  return node;
}

export function renderInputTemplate(template: Record<string, unknown>, vars: TemplateVars): Record<string, unknown> {
  const r = render(template, vars);
  return (r && typeof r === "object" && !Array.isArray(r) ? r : {}) as Record<string, unknown>;
}

/** Placeholder names referenced by a template (for admin validation / UI hints). */
export function templatePlaceholders(template: unknown): string[] {
  const found = new Set<string>();
  const walk = (n: unknown) => {
    if (typeof n === "string") for (const m of n.matchAll(EMBEDDED)) found.add(m[1]!);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") Object.values(n).forEach(walk);
  };
  walk(template);
  return [...found];
}

/** Apify API path form of an actor id: "user/actor" → "user~actor". */
export function actorPath(actorId: string): string {
  return encodeURIComponent(actorId.trim().replace("/", "~"));
}
