import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Optimistic auth gate: bounce requests without a session cookie to /sign-in.
 * Real authorization happens server-side in every page/action/route (requireUser + RBAC).
 */
export function proxy(request: NextRequest) {
  const cookie = getSessionCookie(request);
  if (!cookie) {
    const url = new URL("/sign-in", request.url);
    return NextResponse.redirect(url);
  }
  // Expose the path to server layouts (e.g. admin section guards need it to answer 403 before streaming).
  const headers = new Headers(request.headers);
  headers.set("x-rso-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|sign-in(?:/|$)|pending(?:/|$)|share/|robots.txt$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
