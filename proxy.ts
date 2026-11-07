import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized, sameOriginAuthorized } from "./src/server/desktop-access.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability. */
export function proxy(request: NextRequest) {
	const pathname = request.nextUrl?.pathname ?? (() => {
		try {
			return new URL(request.url).pathname;
		} catch {
			return "";
		}
	})();
	if (pathname.startsWith("/api/") || pathname === "/api") {
		if (!sameOriginAuthorized(request.headers, request.url)) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}
	}
	if (!desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
