import Link from "next/link";

export const metadata = { title: "Not found" };

/** Branded root 404 for URLs outside the app shell (QA-09). */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-bg px-4 text-center">
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted">404</p>
      <h1 className="mt-2 font-display text-3xl text-fg">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm text-secondary">The link may be broken or the page may have moved.</p>
      <Link href="/home" className="mt-6 rounded-md bg-white px-4 py-2 text-sm font-medium text-black">
        Go to My Day
      </Link>
    </main>
  );
}
