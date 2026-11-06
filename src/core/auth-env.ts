/** Shared provenance only: no credential-store reads in the agent layer. */
interface AuthBoot {
	/** Names owned by the original launch environment. */
	realEnv: Set<string>;
	/** Names reflected into process.env by LearnHarness's key store. */
	fillGap: Set<string>;
}
const BOOT_KEY = Symbol.for("lh.authBoot");

export function authEnvRecord(): AuthBoot {
	const g = globalThis as Record<symbol, AuthBoot | undefined>;
	if (!g[BOOT_KEY]) g[BOOT_KEY] = { realEnv: new Set(), fillGap: new Set() };
	return g[BOOT_KEY];
}

export function getRuntimeEnv(): Record<string, string | undefined> {
	const g = typeof globalThis !== "undefined" ? (globalThis as Record<string, unknown>) : undefined;
	const globalProc = g?.process as { env?: Record<string, string | undefined> } | undefined;
	if (globalProc?.env) return globalProc.env;
	if (typeof process !== "undefined" && process?.env) return process.env;
	return {};
}

/** External CLIs own their authentication. Never pass LearnHarness-only injections. */
export function externalCliEnv(env: NodeJS.ProcessEnv = getRuntimeEnv() as NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result = { ...env };
	const { realEnv, fillGap } = authEnvRecord();
	for (const name of fillGap) {
		if (!realEnv.has(name)) delete result[name];
	}
	return result;
}
