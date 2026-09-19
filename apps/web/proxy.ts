import { NextResponse, type NextRequest } from "next/server";

// CloudBase's gateway serves this site over plain HTTP as readily as over
// HTTPS and offers no redirect of its own - checked live on 2026-09-18:
// http://www.heyirmy.com/download-client returned the page, install command
// and all. On an open network that page can be rewritten in transit, and the
// macOS instructions are literally "paste this into Terminal".
//
// So the redirect lives here, keyed on what the gateway reports in
// X-Forwarded-Proto. It fires only when that says `http`: with no header the
// request passes untouched, so there is no way to loop, and if the gateway
// turns out not to send the header at all, forcing HTTPS has to be done at
// the gateway instead (HSTS below still covers every returning visitor).
const CANONICAL_HOSTS = new Set(["www.heyirmy.com", "heyirmy.com"]);

export function proxy(request: NextRequest) {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const host = request.headers.get("host")?.trim().toLowerCase() ?? "";
  // Only our own hosts: a redirect built from an arbitrary Host header would
  // be an open redirect.
  if (proto === "http" && CANONICAL_HOSTS.has(host)) {
    const { pathname, search } = request.nextUrl;
    return NextResponse.redirect(`https://www.heyirmy.com${pathname}${search}`, 308);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
