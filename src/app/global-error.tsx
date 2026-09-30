"use client";
import * as React from "react";

/**
 * Last-resort boundary (M-26): replaces the root layout when it fails, so it renders its own document and inline
 * design tokens (global styles and fonts are not loaded here). Dark, monochrome, one primary action.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", background: "#070707", color: "#f4f4f4", fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" }}>
        <title>Something went wrong · Roundtable</title>
        <main role="alert" style={{ display: "flex", minHeight: "100vh", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
          <p style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 24, color: "#ffffff", margin: 0 }}>Roundtable Sales OS is unavailable</p>
          <p style={{ maxWidth: 380, fontSize: 14, lineHeight: "20px", color: "#828282", marginTop: 8 }}>
            Something went wrong while loading the app. Nothing was changed — try again in a moment.
            {error.digest ? <span style={{ display: "block", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>Ref {error.digest}</span> : null}
          </p>
          <button
            type="button"
            onClick={() => retry()}
            style={{ marginTop: 16, height: 36, padding: "0 16px", borderRadius: 6, border: "none", background: "#ffffff", color: "#070707", fontSize: 14, fontWeight: 500, cursor: "pointer" }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
