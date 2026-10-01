/** Make a placeholder's invisible characters readable: tabs as ⇥, long underscore runs shortened. */
export function showTokenText(text: string): string {
  return text.replace(/\t/g, "⇥").replace(/_{12,}/g, (m) => `${"_".repeat(10)}…(${m.length})`);
}
