import "server-only";
import { TokenBucket } from "@/lib/copilot/rate-limit";

/**
 * Public /share/[token] throttling (per server instance): per client IP and per link. Enough to stop enumeration
 * and scraping bursts; tokens are 256-bit so guessing is infeasible anyway.
 */
const g = globalThis as unknown as { __shareIpBucket?: TokenBucket; __shareLinkBucket?: TokenBucket };
/** 20 page views burst per IP, refilling one every 3 s. */
const ipBucket: TokenBucket = g.__shareIpBucket ?? (g.__shareIpBucket = new TokenBucket(20, 1 / 3));
/** 60 views burst per link, refilling one per second. */
const linkBucket: TokenBucket = g.__shareLinkBucket ?? (g.__shareLinkBucket = new TokenBucket(60, 1));

export function allowShareView(ip: string, tokenKey: string): boolean {
  const a = ipBucket.take(`ip:${ip}`);
  if (!a.ok) return false;
  return linkBucket.take(`t:${tokenKey}`).ok;
}
