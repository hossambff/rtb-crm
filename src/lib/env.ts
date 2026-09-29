import "server-only";

function list(v: string | undefined, fallback: string[]): string[] {
  const parts = (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parts.length ? parts : fallback;
}

export const env = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  isProd: process.env.NODE_ENV === "production",
  /** Dev-only email/password login. Hard-disabled in production builds regardless of the flag. */
  devLoginEnabled: process.env.NODE_ENV !== "production" && process.env.ALLOW_DEV_LOGIN === "true",
  allowedDomains: list(process.env.ALLOWED_EMAIL_DOMAINS, ["roundtable.io", "blockchainff.com"]),
  googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  aiConfigured: Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN),
  aiModelFast: process.env.AI_MODEL_FAST ?? "google/gemini-2.5-flash",
  aiModelStrong: process.env.AI_MODEL_STRONG ?? "openai/gpt-5-mini",
  apifyToken: process.env.APIFY_TOKEN || undefined,
  cronSecret: process.env.CRON_SECRET,
};

export function emailDomainAllowed(email: string, extra: string[] = []): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return [...env.allowedDomains, ...extra.map((d) => d.toLowerCase())].includes(domain);
}
