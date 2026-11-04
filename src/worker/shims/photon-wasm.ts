let photonPromise: Promise<typeof import("@silvia-odwyer/photon-node")> | null = null;

export async function loadPhotonWasm(): Promise<typeof import("@silvia-odwyer/photon-node")> {
	if (photonPromise) return photonPromise;

	photonPromise = (async () => {
		try {
			const mod = await import("@silvia-odwyer/photon-node");
			const resolved = (mod && mod.PhotonImage ? mod : (mod as unknown as { default: typeof import("@silvia-odwyer/photon-node") })?.default);
			if (resolved && typeof resolved.PhotonImage === "function") {
				return resolved;
			}
		} catch {
			// Fallback if direct import fails
		}

		try {
			const wasmUrl = new URL("@silvia-odwyer/photon-node/photon_rs_bg.wasm", import.meta.url);
			const response = await fetch(wasmUrl);
			const bytes = await response.arrayBuffer();
			await WebAssembly.compile(bytes);
			const mod = await import("@silvia-odwyer/photon-node");
			return (mod && mod.PhotonImage ? mod : (mod as unknown as { default: typeof import("@silvia-odwyer/photon-node") })?.default);
		} catch (err) {
			throw new Error(`Failed to load Photon WASM: ${err instanceof Error ? err.message : String(err)}`);
		}
	})();

	return photonPromise;
}
