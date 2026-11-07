import { timingSafeEqual } from "node:crypto";

/** Same-origin and CSRF guard. Returns false for cross-site browser requests. */
export function sameOriginAuthorized(
	headers: Pick<Headers, "get">,
	url?: string,
): boolean {
	const fetchSite = headers.get("sec-fetch-site")?.toLowerCase();
	if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
		return false;
	}

	const origin = headers.get("origin");
	if (origin !== null) {
		if (origin === "null") return false;
		let parsedOrigin: URL;
		try {
			parsedOrigin = new URL(origin);
		} catch {
			return false;
		}

		const expectedHost =
			headers.get("x-forwarded-host") ??
			headers.get("host") ??
			(url
				? (() => {
						try {
							return new URL(url).host;
						} catch {
							return null;
						}
				  })()
				: null);

		if (expectedHost && parsedOrigin.host !== expectedHost) {
			return false;
		}
	}

	return true;
}

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Browser-only mode is unchanged. */
export function desktopAPIAuthorized(
	headers: Pick<Headers, "get">,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = env.LH_DESKTOP_API_SECRET;
	if (env.LH_DESKTOP_SERVER !== "1" && !expected) {
		return sameOriginAuthorized(headers);
	}
	if (!expected || expected.length < 64) return false;
	const supplied = headers.get("x-learnharness-desktop");
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
