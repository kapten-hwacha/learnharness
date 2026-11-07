import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
// The search-hit shape lives in the core port since the search wave
// (2026-09-20); this alias keeps callers churn-free.
import type { SearchHit as WebSearchResult, SearchProvider } from "../../core/search.ts";
export type { WebSearchResult };
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

/**
 * Server-side web tools for the researcher sub-agent — a minimal port of the
 * pi extensions (~/.pi/agent/extensions/web-search + web-fetch):
 *
 *   web_search(query, count?) → {title, url, snippet}[]   (injected search port)
 *   web_fetch(url)            → readable markdown text     (Readability + Turndown,
 *                                                          Jina Reader fallback for
 *                                                          JS-rendered pages)
 *
 * SEARCH REWIRING (search port wave, 2026-09-20): the Google CSE backend is
 * retired — web_search now runs on the injected search port (core/search.ts).
 * The live adapter (server/search.ts) arrives as a DEPENDENCY
 * (import law: this tool depends on the core port, never server code). NO
 * silent fallback (owner decision): provider absent → search is honestly
 * unavailable. Research dispatch and keyless web_fetch remain available.
 *
 * Tool contract: NEVER throw into the agent loop — missing provider and
 * every failure path return a clear error STRING as the tool output, so the
 * researcher can adapt (or report) instead of crashing.
 */

// ── web_search ───────────────────────────────────────────────────────────────
// (WebSearchResult is the core SearchHit, re-exported above.)

// ── web_fetch ────────────────────────────────────────────────────────────────

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 30_000;
export const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES = MAX_FETCH_BYTES;
/** Keep the researcher's context sane — long pages truncate with a marker. */
const MAX_CONTENT_CHARS = 40_000;
const MIN_USEFUL_CONTENT = 200;

/**
 * Detect private, loopback, link-local, or cloud-metadata hostnames.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
	let host = hostname.trim().toLowerCase();
	while (host.endsWith(".")) {
		host = host.slice(0, -1);
	}
	if (host.startsWith("[") && host.endsWith("]")) {
		host = host.slice(1, -1).trim();
	}
	while (host.endsWith(".")) {
		host = host.slice(0, -1);
	}
	if (!host) return true;

	if (
		host === "localhost" ||
		host === "localhost.localdomain" ||
		host === "metadata.google.internal" ||
		host === "0.0.0.0" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local")
	) {
		return true;
	}

	if (!host.includes(":")) {
		try {
			const parsed = new URL(`http://${host}`);
			if (parsed.hostname !== host) {
				return isPrivateOrLoopbackHost(parsed.hostname);
			}
		} catch {
			// ignore
		}
	}

	const ipv4Match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (ipv4Match) {
		const a = Number(ipv4Match[1]);
		const b = Number(ipv4Match[2]);
		const c = Number(ipv4Match[3]);
		const d = Number(ipv4Match[4]);
		if (
			a >= 0 && a <= 255 &&
			b >= 0 && b <= 255 &&
			c >= 0 && c <= 255 &&
			d >= 0 && d <= 255
		) {
			if (
				a === 0 || // 0.0.0.0/8
				a === 10 || // 10.0.0.0/8
				a === 127 || // 127.0.0.0/8 loopback
				(a === 169 && b === 254) || // 169.254.0.0/16 link-local / cloud metadata
				(a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
				(a === 192 && b === 168) || // 192.168.0.0/16 private
				(a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 CGNAT
			) {
				return true;
			}
			return false;
		}
	}

	if (host.includes(":")) {
		if (
			host === "::1" ||
			host === "::" ||
			host === "::0" ||
			host === "0:0:0:0:0:0:0:1" ||
			host === "0:0:0:0:0:0:0:0"
		) {
			return true;
		}
		if (host.startsWith("fc") || host.startsWith("fd")) {
			return true;
		}
		if (
			host.startsWith("fe8") ||
			host.startsWith("fe9") ||
			host.startsWith("fea") ||
			host.startsWith("feb")
		) {
			return true;
		}
		if (host.startsWith("::ffff:")) {
			const mapped = host.slice("::ffff:".length);
			if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) {
				return isPrivateOrLoopbackHost(mapped);
			}
			const hexMatch = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
			if (hexMatch) {
				const n1 = parseInt(hexMatch[1]!, 16);
				const n2 = parseInt(hexMatch[2]!, 16);
				const a = (n1 >> 8) & 0xff;
				const b = n1 & 0xff;
				const c = (n2 >> 8) & 0xff;
				const d = n2 & 0xff;
				return isPrivateOrLoopbackHost(`${a}.${b}.${c}.${d}`);
			}
			return true;
		}
		return false;
	}

	return false;
}

/**
 * Validate that a URL is a valid, public HTTP or HTTPS URL (no credentials,
 * non-private and non-loopback host).
 */
export function assertPublicHttpUrl(rawUrl: string): URL {
	const parsed = new URL(rawUrl);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Only http(s) URLs are supported");
	}
	if (parsed.username || parsed.password) {
		throw new Error("URLs with credentials are not allowed");
	}
	if (isPrivateOrLoopbackHost(parsed.hostname)) {
		throw new Error(`Refusing to fetch private or local URL: ${rawUrl}`);
	}
	return parsed;
}

/**
 * Read up to maxBytes from a response body stream, throwing if the content length
 * header or total bytes read exceeds maxBytes.
 */
export async function readBoundedBytes(resp: Response, maxBytes: number): Promise<Uint8Array> {
	const cl = resp.headers.get("content-length");
	if (cl !== null) {
		const len = Number(cl);
		if (Number.isFinite(len) && len > maxBytes) {
			throw new Error(`Response too large (${len} bytes, max ${maxBytes})`);
		}
	}
	if (!resp.body) {
		return new Uint8Array(0);
	}
	const reader = resp.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				total += value.byteLength;
				if (total > maxBytes) {
					await reader.cancel();
					throw new Error(`Response too large (> ${maxBytes} bytes)`);
				}
				chunks.push(value);
			}
		}
	} catch (err) {
		try {
			await reader.cancel();
		} catch {
			// ignore cancel error
		}
		throw err;
	}

	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

/**
 * Fetch a public URL with redirect validation to prevent SSRF via redirect.
 */
export async function fetchPublicUrl(
	rawUrl: string,
	init: RequestInit = {},
	maxRedirects = 5,
): Promise<Response> {
	let currentUrl = assertPublicHttpUrl(rawUrl).toString();
	let redirects = 0;
	while (true) {
		const resp = await fetch(currentUrl, { ...init, redirect: "manual" });
		if (resp.status >= 300 && resp.status < 400) {
			const location = resp.headers.get("location");
			if (!location) {
				return resp;
			}
			redirects++;
			if (redirects > maxRedirects) {
				throw new Error("Too many redirects");
			}
			const nextUrl = new URL(location, currentUrl).toString();
			currentUrl = assertPublicHttpUrl(nextUrl).toString();
			continue;
		}
		return resp;
	}
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function truncate(text: string): string {
	if (text.length <= MAX_CONTENT_CHARS) return text;
	return `${text.slice(0, MAX_CONTENT_CHARS)}\n\n[Truncated at ${MAX_CONTENT_CHARS} characters]`;
}

/** Jina Reader fallback for JS-rendered pages (no deps — plain fetch). */
async function fetchViaJina(url: string): Promise<string | null> {
	try {
		const res = await fetch(`https://r.jina.ai/${url}`, {
			headers: { Accept: "text/markdown", "X-No-Cache": "true" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const content = await res.text();
		const marker = "Markdown Content:";
		const start = content.indexOf(marker);
		if (start < 0) return null;
		const markdown = content.slice(start + marker.length).trim();
		if (markdown.length < MIN_USEFUL_CONTENT || markdown.startsWith("Loading...")) return null;
		return markdown;
	} catch {
		return null;
	}
}

function htmlToMarkdown(html: string): { title: string; content: string } | null {
	const { document } = parseHTML(html);
	const article = new Readability(document as unknown as Document).parse();
	if (!article?.content) return null;
	const markdown = turndown.turndown(article.content);
	if (markdown.trim().length < MIN_USEFUL_CONTENT) return null;
	return { title: article.title ?? "", content: markdown };
}

async function fetchAndExtract(url: string, signal?: AbortSignal): Promise<string> {
	const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

	const resp = await fetchPublicUrl(url, {
		headers: {
			"User-Agent": USER_AGENT,
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
		signal: combinedSignal,
	});
	if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

	// Final URL after redirects + status — the researcher's only way to
	// tell a real page from a 200-served error body (owner-reported
	// "ill-formed request" case: the SITE answered, we just relayed it).
	const sourceLine = `Source: ${resp.url || url} (HTTP ${resp.status})`;

	const contentType = resp.headers.get("content-type") ?? "";
	if (contentType.includes("application/pdf")) {
		// Pointer, not dead-end (researcher PDF wave, 2026-10-07): the
		// researcher's web_fetch_pdf tool downloads + triages PDFs.
		return `web_fetch: this URL is a PDF document — call web_fetch_pdf on it to download and read it.`;
	}
	if (/image\/|audio\/|video\/|zip|octet-stream/.test(contentType)) {
		throw new Error(`Unsupported content type: ${contentType.split(";")[0]}`);
	}

	const bytes = await readBoundedBytes(resp, MAX_FETCH_BYTES);
	const text = new TextDecoder().decode(bytes);
	if (!contentType.includes("html")) return `${sourceLine}\n\n${truncate(text)}`; // plain text / markdown / code

	const extracted = htmlToMarkdown(text);
	if (extracted) {
		const header = extracted.title ? `# ${extracted.title}\n\n${sourceLine}\n\n---\n\n` : `${sourceLine}\n\n---\n\n`;
		return header + truncate(extracted.content);
	}
	// Readability failed — likely JS-rendered. Try Jina Reader.
	const jina = await fetchViaJina(url);
	if (jina) return truncate(jina);
	throw new Error("Could not extract readable content (the page may be JavaScript-rendered)");
}

// ── tool registry ────────────────────────────────────────────────────────────

const webSearchInput = Type.Object({
	query: Type.String({ description: "The search query (a normal search string, phrases included)" }),
	count: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 10, description: "Number of results (default 5, max 10)" }),
	),
});

const webFetchInput = Type.Object({
	url: Type.String({ description: "The URL to fetch" }),
});

export function createWebTools(search: () => SearchProvider | null): Record<string, AgentTool<any>> {
	return {
		web_search: {
			name: "web_search",
			label: "web_search",
			description: "Search the web. One search per call — use one call per search angle. " +
				"Returns an array of results with title, url, and snippet.",
			parameters: webSearchInput,
			execute: serverExecute("web_search", webSearchInput, async ({ query, count }): Promise<WebSearchResult[] | string> => {
				const provider = search();
				if (!provider) {
					return (
						"web_search is not available: no search engine is configured. " +
						"Set a Tavily, Brave, Exa, Firecrawl, or Ollama search API key in settings. Report in your brief that web search is unavailable."
					);
				}
				try {
					return await provider.search(query, count ?? 5);
				} catch (err) {
					return `web_search failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},

		web_fetch: {
			name: "web_fetch",
			label: "web_fetch",
			description:
				"Fetch a web page and extract its readable content as markdown (Readability). " +
				"Handles HTML pages and plain text; JS-rendered pages fall back to a reader service.",
			parameters: webFetchInput,
			execute: serverExecute("web_fetch", webFetchInput, async ({ url }, ctx): Promise<string> => {
				try {
					assertPublicHttpUrl(url);
				} catch (err) {
					return `web_fetch failed: invalid URL "${url}" (${err instanceof Error ? err.message : String(err)})`;
				}
				try {
					return await fetchAndExtract(url, ctx?.signal);
				} catch (err) {
					return `web_fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},
	};
}

/** The provider-less backstop (tests pin the shape with it; the runner
 *  always injects the real seam — an absent seam reads as unavailable,
 *  never a crash and never a silent alternative engine). */
export const webTools = createWebTools(() => null);
