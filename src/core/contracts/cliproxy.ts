export const CLIPROXY_PROVIDER = "cliproxy";
export const CLIPROXY_LABEL = "CLIProxyAPI";
export const CLIPROXY_DEFAULT_PORT = 8317;
export const CLIPROXY_DEFAULT_URL = "http://127.0.0.1:8317/v1";
export const CLIPROXY_DEFAULT_KEY = "lh-proxy-key";

export interface CliProxyStatus {
	state: "ready" | "not-found" | "offline" | "disabled";
	version: string | null;
	models: string[];
}
