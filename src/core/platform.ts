export type PlatformId = "darwin" | "win32" | "linux" | "ios" | "web";

/**
 * Detects iOS or iPadOS runtime environments.
 * Checks standard iOS user-agent tokens (iPhone, iPad, iPod) as well as
 * iPadOS Safari desktop-mode UA (reports "Macintosh" / "MacIntel" with multi-touch points).
 */
export function isIos(): boolean {
	if (typeof window !== "undefined" && (window as any).lh?.isIos !== undefined) {
		return Boolean((window as any).lh.isIos);
	}
	if (typeof navigator === "undefined") return false;
	const ua = navigator.userAgent || "";
	if (/iPad|iPhone|iPod/.test(ua)) return true;
	if (
		(navigator.platform === "MacIntel" || ua.includes("Macintosh")) &&
		typeof navigator.maxTouchPoints === "number" &&
		navigator.maxTouchPoints > 1
	) {
		return true;
	}
	return false;
}

/**
 * Returns true if running within the Tauri native host shell (desktop or mobile).
 */
export function isTauri(): boolean {
	if (typeof window === "undefined") return false;
	return Boolean((window as any).__TAURI_INTERNALS__ || (window as any).lh);
}

/**
 * Returns true if running in Tauri on desktop (macOS, Windows, Linux), excluding iOS/iPadOS.
 */
export function isDesktop(): boolean {
	return isTauri() && !isIos();
}

/**
 * Resolves the active platform identifier.
 */
export function getPlatform(): PlatformId {
	if (isIos()) return "ios";
	if (typeof window !== "undefined" && (window as any).lh?.platform) {
		const p = (window as any).lh.platform;
		if (p === "ios" || p === "darwin" || p === "win32" || p === "linux") {
			return p;
		}
	}
	if (!isTauri()) return "web";
	if (typeof navigator === "undefined") return "web";
	const ua = navigator.userAgent || "";
	if (ua.includes("Win")) return "win32";
	if (ua.includes("Linux")) return "linux";
	if (ua.includes("Mac")) return "darwin";
	return "web";
}
