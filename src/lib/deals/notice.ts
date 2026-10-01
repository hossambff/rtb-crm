/**
 * MNPI-safe notification text (V2 §0.4): notifications can be relayed to Slack DMs and the daily digest, so for
 * restricted deals the title is generic, the body is dropped and the row is flagged `sensitive` (notify() then never
 * relays it to Slack at all) — the link still opens the (access-checked) deal.
 * Pure; unit tested.
 */
export type NoticeText = { title: string; body?: string | null; sensitive?: boolean };

export function mnpiSafe(restricted: boolean, n: NoticeText, generic: string): NoticeText {
  return restricted ? { title: generic, body: null, sensitive: true } : n;
}
