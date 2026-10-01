/**
 * Client-side bridge between the /deals list selection and the ⌘K palette ("assign these to Will").
 * A tiny module singleton (no React context needed: both live in the same client bundle). Pure, client-safe.
 */
type Listener = (ids: string[]) => void;
let current: string[] = [];
const listeners = new Set<Listener>();

export function setDealSelection(ids: string[]) {
  current = ids.slice(0, 500);
  for (const l of listeners) l(current);
}

export function getDealSelection(): string[] {
  return current;
}

export function onDealSelection(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
