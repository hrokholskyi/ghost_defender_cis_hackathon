/**
 * Public-exposure guard. On the public host (GLD_PUBLIC_URL) only the
 * investigation tool endpoints answer; everything else is a 404. Other hosts,
 * such as localhost, pass through untouched. See public-guard.ts.
 *
 * No matcher on purpose: the guard must also cover pages, static assets and
 * any route added later.
 */
import { NextResponse, type NextRequest } from "next/server";
import { publicGuardDecision } from "@/lib/investigator/devin/public-guard";

export function proxy(request: NextRequest) {
  const decision = publicGuardDecision(process.env, {
    pathname: request.nextUrl.pathname,
    host: request.headers.get("host"),
    forwardedHost: request.headers.get("x-forwarded-host"),
  });
  if (decision === "block") {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.next();
}
