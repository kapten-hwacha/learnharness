import { execFile } from "node:child_process";
import {
	CLIPROXY_DEFAULT_KEY,
	CLIPROXY_DEFAULT_URL,
	type CliProxyStatus,
} from "../core/contracts/cliproxy.ts";
import { cliproxyEnabled } from "./cliproxy-config.ts";
import { ensureCliProxyRunning, getCliproxyBinary } from "./cliproxy-process.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

export function readCliproxyVersion(binary: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(binary, ["-help"], {
			encoding: "utf8",
			timeout: 2000,
			windowsHide: true,
		}, (err, stdout, stderr) => {
			const text = String(stdout ?? "") + String(stderr ?? "");
			const match = /CLIProxyAPI Version:\s*([^\s,]+)/i.exec(text);
			resolve(match && match[1] ? match[1] : null);
		});
	});
}

export async function cliproxyInstallationStatus(): Promise<CliProxyStatus> {
	if (!cliproxyEnabled()) {
		return { state: "disabled", version: null, models: [] };
	}

	const binary = getCliproxyBinary();
	if (!binary) {
		return { state: "not-found", version: null, models: [] };
	}

	const version = await readCliproxyVersion(binary);

	const running = await ensureCliProxyRunning();
	if (!running.ok) {
		return { state: "offline", version, models: [] };
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2000);
		const res = await fetch(`${CLIPROXY_DEFAULT_URL}/models`, {
			headers: { Authorization: `Bearer ${CLIPROXY_DEFAULT_KEY}` },
			signal: controller.signal,
		});
		clearTimeout(timeout);

		if (!res.ok) {
			return { state: "offline", version, models: [] };
		}

		const body = await res.json() as { data?: Array<{ id: string }> };
		const models = Array.isArray(body?.data) ? body.data.map((m) => m.id) : [];

		return {
			state: "ready",
			version,
			models,
		};
	} catch {
		return { state: "offline", version, models: [] };
	}
}

export async function cliproxyInstallationResponse(
	request: Request,
	status = cliproxyInstallationStatus,
	enabled = cliproxyEnabled,
): Promise<Response> {
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

	if (
		request.method !== "GET"
		|| !origin
		|| request.headers.get("sec-fetch-site") === "cross-site"
		|| (supplied !== null && supplied !== origin)
	) {
		return Response.json(
			{ error: "CLIProxyAPI checks require a same-origin LearnHarness request." },
			{ status: 403, headers },
		);
	}

	if (!enabled()) {
		return Response.json({ state: "disabled", version: null, models: [] }, { headers });
	}

	return Response.json(await status(), { headers });
}
