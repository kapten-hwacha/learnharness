import { createRequire } from "node:module";

type PhotonModule = typeof import("@silvia-odwyer/photon-node");

let nodePhoton: PhotonModule | null = null;
try {
	const req = createRequire(import.meta.url);
	nodePhoton = req("../../../node_modules/@silvia-odwyer/photon-node/photon_rs.js") as PhotonModule;
} catch {
	// Not in Node / bundled in browser
}

export const PhotonImage = nodePhoton?.PhotonImage ?? (class PhotonImage {
	static new_from_byteslice(slice: Uint8Array) {
		if (nodePhoton?.PhotonImage) return nodePhoton.PhotonImage.new_from_byteslice(slice);
		throw new Error("PhotonImage not supported in Web Worker without native bindings");
	}
	static new_from_base64(base64: string) {
		if (nodePhoton?.PhotonImage) return nodePhoton.PhotonImage.new_from_base64(base64);
		throw new Error("PhotonImage not supported in Web Worker without native bindings");
	}
} as unknown as PhotonModule["PhotonImage"]);

export const SamplingFilter = nodePhoton?.SamplingFilter ?? ({
	1: "Nearest",
	2: "Triangle",
	3: "CatmullRom",
	4: "Gaussian",
	5: "Lanczos3",
	Nearest: 1,
	Triangle: 2,
	CatmullRom: 3,
	Gaussian: 4,
	Lanczos3: 5,
} as unknown as PhotonModule["SamplingFilter"]);

export const resize: PhotonModule["resize"] = nodePhoton?.resize ?? ((...args: Parameters<PhotonModule["resize"]>) => {
	if (nodePhoton?.resize) return nodePhoton.resize(...args);
	throw new Error("resize not supported in Web Worker without native bindings");
});

let photonPromise: Promise<PhotonModule> | null = null;

export async function loadPhotonWasm(): Promise<PhotonModule> {
	if (photonPromise) return photonPromise;

	photonPromise = (async () => {
		if (nodePhoton) return nodePhoton;

		try {
			const wasmUrl = new URL("../../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm", import.meta.url);
			const response = await fetch(wasmUrl);
			const bytes = await response.arrayBuffer();
			await WebAssembly.compile(bytes);
			return {
				PhotonImage,
				SamplingFilter,
				resize,
				...(nodePhoton || {}),
			} as unknown as PhotonModule;
		} catch (err) {
			throw new Error(`Failed to load Photon WASM: ${err instanceof Error ? err.message : String(err)}`);
		}
	})();

	return photonPromise;
}

export default {
	PhotonImage,
	SamplingFilter,
	resize,
	loadPhotonWasm,
	...(nodePhoton || {}),
};
