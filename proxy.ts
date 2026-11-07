import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized, sameOriginAuthorized } from "./src/server/desktop-access.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability. */
export function proxy(request: NextRequest) {
	const origin = request.headers.get("origin");
	const isDevTauri =
		process.env.NODE_ENV !== "production" &&
		origin !== null &&
		(origin === "tauri://localhost" ||
			origin === "http://tauri.localhost" ||
			origin.startsWith("tauri://"));

	if (request.method === "OPTIONS" && isDevTauri) {
		return new NextResponse(null, {
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": origin!,
				"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
				"Access-Control-Allow-Headers": "*",
				"Access-Control-Max-Age": "86400",
			},
		});
	}

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
	const response = NextResponse.next();
	if (isDevTauri) {
		response.headers.set("Access-Control-Allow-Origin", origin!);
		response.headers.set("Access-Control-Allow-Headers", "*");
		response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
	}
	return response;
}

export const config = { matcher: "/api/:path*" };
