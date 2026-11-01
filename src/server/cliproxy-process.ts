import { execSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { CLIPROXY_DEFAULT_PORT } from "../core/contracts/cliproxy.ts";

let managedChild: ChildProcess | null = null;

function isExecutable(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

export function getCliproxyBinary(): string | null {
	if (process.env.CLIPROXY_PATH && isExecutable(process.env.CLIPROXY_PATH)) {
		return process.env.CLIPROXY_PATH;
	}
	const homebrewPath = "/opt/homebrew/bin/cliproxyapi";
	if (isExecutable(homebrewPath)) {
		return homebrewPath;
	}
	const localPath = "/usr/local/bin/cliproxyapi";
	if (isExecutable(localPath)) {
		return localPath;
	}
	try {
		const out = execSync("which cliproxyapi", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (out && isExecutable(out)) {
			return out;
		}
	} catch {
		// Ignore which failure
	}
	return null;
}

export function isPortListening(port = CLIPROXY_DEFAULT_PORT): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		const onError = () => {
			socket.destroy();
			resolve(false);
		};
		socket.setTimeout(400);
		socket.once("error", onError);
		socket.once("timeout", onError);
		socket.connect(port, "127.0.0.1", () => {
			socket.end();
			resolve(true);
		});
	});
}

function getCliProxyConfigPath(): string {
	const userConfig = path.join(os.homedir(), ".cli-proxy-api", "config.yaml");
	if (fs.existsSync(userConfig)) {
		return userConfig;
	}
	const defaultBrewConfig = "/opt/homebrew/etc/cliproxyapi.conf";
	if (fs.existsSync(defaultBrewConfig)) {
		return defaultBrewConfig;
	}
	return userConfig;
}

export async function ensureCliProxyRunning(): Promise<{ ok: boolean; error?: string }> {
	if (await isPortListening()) {
		return { ok: true };
	}

	const binary = getCliproxyBinary();
	if (!binary) {
		return { ok: false, error: "Binary not found" };
	}

	const configPath = getCliProxyConfigPath();
	const args = fs.existsSync(configPath) ? ["-config", configPath] : [];

	try {
		const child = spawn(binary, args, {
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		});

		child.on("error", (err) => {
			console.error("[cliproxy-process] error:", err);
			if (managedChild === child) managedChild = null;
		});

		child.on("exit", (code, signal) => {
			if (managedChild === child) managedChild = null;
		});

		managedChild = child;

		// Probe with timeout up to 5s
		const startTime = Date.now();
		while (Date.now() - startTime < 5000) {
			if (await isPortListening()) {
				return { ok: true };
			}
			await new Promise((r) => setTimeout(r, 200));
		}

		return { ok: false, error: "Timed out waiting for CLIProxyAPI to start" };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export function stopManagedCliProxy(): void {
	if (managedChild) {
		try {
			managedChild.kill();
			managedChild.unref();
		} catch {
			// Ignore kill errors
		}
		managedChild = null;
	}
}

process.once("exit", () => stopManagedCliProxy());
process.once("SIGINT", () => stopManagedCliProxy());
process.once("SIGTERM", () => stopManagedCliProxy());
