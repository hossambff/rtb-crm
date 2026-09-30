/**
 * SEC M-11: short attacker-controlled fields (email subject, sender display name, call title, activity subject) that
 * are interpolated into an AI prompt are wrapped as untrusted data, same convention as `untrusted()` in src/lib/ai.ts.
 * Pure (no server deps) so the prompt builders stay unit-testable. Line breaks (incl. Unicode line/paragraph
 * separators) are collapsed so a header can't fake prompt structure, and nested <untrusted> tags are stripped so it
 * can't close the wrapper.
 */
const LINE_BREAKS = new RegExp("[\\r\\n\\u2028\\u2029]+", "g");

export function untrustedField(label: string, text: string | null | undefined, maxChars = 300): string {
  if (text == null || text === "") return "(none)";
  const flat = text.replace(/<\/?untrusted[^>]*>/gi, "").replace(LINE_BREAKS, " ").trim();
  const clipped = flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
  return `<untrusted source="${label}">${clipped}</untrusted>`;
}
