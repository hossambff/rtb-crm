import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  // Never echo server-action arguments (email bodies, API keys) into dev logs.
  logging: { serverFunctions: false },
  poweredByHeader: false,
  // forbidden() / forbidden.tsx → real HTTP 403 for pages a role can't open (QA-09, AT-02).
  experimental: { authInterrupts: true },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // public partner links (V2 C10): never cached, never indexed
      {
        source: "/share/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
};

export default nextConfig;
