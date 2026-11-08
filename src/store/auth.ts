/**
 * The AuthStore adapter: flat {VAR: value} auth.json map.
 *
 * Implements core/ports.ts AuthStore.
 * When getTauriInvoke() is non-null, calls Rust Tauri commands (lh_auth_read / lh_auth_write).
 * When getTauriInvoke() is null, falls back to memory-backend.ts (Node tests).
 */

import type { AuthStore } from "../core/ports.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { CUSTOM_AUTH_BINDING, parseCustomAuthBinding, type CustomAuthBinding } from "../core/custom-provider-auth.ts";
import { getTauriInvoke } from "../worker/host-bridge.ts";
import { getMemoryAuthContent, setMemoryAuthContent } from "./memory-backend.ts";

async function readAuthContent(): Promise<string | null> {
	const invoke = getTauriInvoke();
	if (invoke) {
		return await invoke<string | null>("lh_auth_read", { filename: "auth.json" });
	}
	return getMemoryAuthContent();
}

async function writeAuthContent(content: string): Promise<void> {
	const invoke = getTauriInvoke();
	if (invoke) {
		await invoke("lh_auth_write", { filename: "auth.json", content });
	} else {
		setMemoryAuthContent(content);
	}
}

async function readMap(): Promise<Record<string, string>> {
	try {
		const text = await readAuthContent();
		if (!text) return {};
		const raw = JSON.parse(text);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(
			Object.entries(raw).filter(([, v]) => typeof v === "string") as [string, string][],
		);
	} catch {
		return {};
	}
}

async function writeMap(map: Record<string, unknown>): Promise<void> {
	const content = `${JSON.stringify(map, null, "\t")}\n`;
	await writeAuthContent(content);
}

export function assertOrdinaryVar(name: string): void {
	if (name === CUSTOM_AUTH_BINDING || name === CUSTOM_PROVIDER.envVar) {
		throw new Error("Use the custom endpoint editor");
	}
}

export const authStore: AuthStore = {
	async authVars(): Promise<Record<string, string>> {
		return readMap();
	},
	async setAuthVar(name: string, value: string): Promise<void> {
		assertOrdinaryVar(name);
		const map = await readMap();
		map[name] = value;
		await writeMap(map);
	},
	async deleteAuthVar(name: string): Promise<void> {
		assertOrdinaryVar(name);
		const map = await readMap();
		if (!(name in map)) return;
		delete map[name];
		await writeMap(map);
	},
};

async function readCustomMap(): Promise<Record<string, unknown>> {
	let text: string | null = null;
	try {
		text = await readAuthContent();
	} catch {
		throw new Error("Custom authorization storage unavailable");
	}
	if (text === null) return {};
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("Custom authorization storage unavailable");
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Custom authorization storage unavailable");
	}
	const map = raw as Record<string, unknown>;
	if (Object.hasOwn(map, CUSTOM_AUTH_BINDING) && !parseCustomAuthBinding(map[CUSTOM_AUTH_BINDING])) {
		throw new Error("Invalid custom authorization record");
	}
	if (Object.hasOwn(map, CUSTOM_PROVIDER.envVar) && typeof map[CUSTOM_PROVIDER.envVar] !== "string") {
		throw new Error("Invalid custom credential record");
	}
	return map;
}

export async function readCustomAuth(): Promise<{ binding: CustomAuthBinding | null; fileKey: () => string | undefined }> {
	const map = await readCustomMap();
	return {
		binding: parseCustomAuthBinding(map[CUSTOM_AUTH_BINDING]) ?? null,
		fileKey: () => map[CUSTOM_PROVIDER.envVar] as string | undefined,
	};
}

export async function writeCustomAuth(
	binding: CustomAuthBinding | undefined,
	fileKey: string | undefined,
): Promise<void> {
	const map = await readCustomMap();
	if (binding && !parseCustomAuthBinding(JSON.stringify(binding))) {
		throw new Error("Invalid custom authorization record");
	}
	if (fileKey === undefined) delete map[CUSTOM_PROVIDER.envVar];
	else Object.defineProperty(map, CUSTOM_PROVIDER.envVar, { value: fileKey, enumerable: true, configurable: true, writable: true });
	if (binding === undefined) delete map[CUSTOM_AUTH_BINDING];
	else Object.defineProperty(map, CUSTOM_AUTH_BINDING, { value: JSON.stringify(binding), enumerable: true, configurable: true, writable: true });
	await writeMap(map);
}
