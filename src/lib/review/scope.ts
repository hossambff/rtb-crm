/** Review scope ↔ URL query (pure, client-safe). */
export type ReviewScope = { pipelineKeys: string[]; teamId: string | null; ownerIds: string[] };

export function scopeToQuery(s: ReviewScope): string {
  const q = new URLSearchParams();
  if (s.pipelineKeys.length) q.set("p", s.pipelineKeys.join(","));
  if (s.teamId) q.set("team", s.teamId);
  if (s.ownerIds.length) q.set("o", s.ownerIds.join(","));
  return q.toString();
}
