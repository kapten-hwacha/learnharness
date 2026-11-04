const K = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export class ShimBuffer extends Uint8Array {
	static override from(
		data: any,
		encodingOrOffset?: any,
		length?: any,
	): any {
		if (typeof data === "string") {
			const enc = typeof encodingOrOffset === "string" ? encodingOrOffset.toLowerCase() : "utf8";
			if (enc === "hex") {
				const bytes = new Uint8Array(Math.floor(data.length / 2));
				for (let i = 0; i < bytes.length; i++) {
					bytes[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16) || 0;
				}
				const buf = new ShimBuffer(bytes.byteLength);
				buf.set(bytes);
				return buf;
			}
			if (enc === "base64" || enc === "base64url") {
				let base64 = data.replace(/-/g, "+").replace(/_/g, "/");
				while (base64.length % 4) base64 += "=";
				const binary = atob(base64);
				const bytes = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i++) {
					bytes[i] = binary.charCodeAt(i);
				}
				const buf = new ShimBuffer(bytes.byteLength);
				buf.set(bytes);
				return buf;
			}
			const encoded = new TextEncoder().encode(data);
			const buf = new ShimBuffer(encoded.byteLength);
			buf.set(encoded);
			return buf;
		}

		if (data instanceof ArrayBuffer) {
			const offset = typeof encodingOrOffset === "number" ? encodingOrOffset : 0;
			const len = typeof length === "number" ? length : data.byteLength - offset;
			const view = new Uint8Array(data, offset, len);
			const buf = new ShimBuffer(view.byteLength);
			buf.set(view);
			return buf;
		}

		if (ArrayBuffer.isView(data)) {
			const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
			const buf = new ShimBuffer(view.byteLength);
			buf.set(view);
			return buf;
		}

		const buf = new ShimBuffer(data.length);
		buf.set(data);
		return buf;
	}

	static alloc(size: number, fill?: number): ShimBuffer {
		const buf = new ShimBuffer(size);
		if (typeof fill === "number" && fill !== 0) {
			buf.fill(fill);
		}
		return buf;
	}

	static concat(list: Uint8Array[], totalLength?: number): ShimBuffer {
		const len = totalLength ?? list.reduce((acc, curr) => acc + curr.byteLength, 0);
		const out = new ShimBuffer(len);
		let offset = 0;
		for (const item of list) {
			const toCopy = Math.min(item.byteLength, len - offset);
			out.set(item.subarray(0, toCopy), offset);
			offset += toCopy;
			if (offset >= len) break;
		}
		return out;
	}

	static byteLength(string: string, encoding = "utf8"): number {
		return ShimBuffer.from(string, encoding).length;
	}

	override toString(encoding?: string): string {
		const enc = (encoding ?? "utf8").toLowerCase();
		if (enc === "hex") {
			return Array.from(this)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
		}
		if (enc === "base64") {
			let binary = "";
			const len = this.byteLength;
			for (let i = 0; i < len; i++) {
				binary += String.fromCharCode(this[i]!);
			}
			return btoa(binary);
		}
		if (enc === "base64url") {
			let binary = "";
			const len = this.byteLength;
			for (let i = 0; i < len; i++) {
				binary += String.fromCharCode(this[i]!);
			}
			return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		}
		return new TextDecoder().decode(this);
	}

	override subarray(begin?: number, end?: number): ShimBuffer {
		const sub = super.subarray(begin, end);
		const out = new ShimBuffer(sub.byteLength);
		out.set(sub);
		return out;
	}

	readUInt32BE(offset: number): number {
		return (
			((this[offset]! << 24) >>> 0) +
			((this[offset + 1]! << 16) | (this[offset + 2]! << 8) | this[offset + 3]!)
		);
	}

	readUInt32LE(offset: number): number {
		return (
			((this[offset + 3]! << 24) >>> 0) +
			((this[offset + 2]! << 16) | (this[offset + 1]! << 8) | this[offset]!)
		);
	}
}

export function toBuffer(bytes: Uint8Array): Buffer {
	if (typeof globalThis.Buffer !== "undefined") {
		return globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}
	return ShimBuffer.from(bytes) as unknown as Buffer;
}

export class Hash {
	private h0 = 0x6a09e667;
	private h1 = 0xbb67ae85;
	private h2 = 0x3c6ef372;
	private h3 = 0xa54ff53a;
	private h4 = 0x510e527f;
	private h5 = 0x9b05688c;
	private h6 = 0x1f83d9ab;
	private h7 = 0x5be0cd19;
	private block = new Uint8Array(64);
	private blockLen = 0;
	private totalLen = 0;
	private w = new Int32Array(64);

	constructor(algorithm: string) {
		const algo = algorithm.toLowerCase().replace(/-/g, "");
		if (algo !== "sha256") {
			throw new Error(`Unsupported hash algorithm: ${algorithm}`);
		}
	}

	private compress(block: Uint8Array): void {
		const view = new DataView(block.buffer, block.byteOffset, 64);
		for (let t = 0; t < 16; t++) {
			this.w[t] = view.getInt32(t * 4, false);
		}
		for (let t = 16; t < 64; t++) {
			const s0 =
				((this.w[t - 15]! >>> 7) | (this.w[t - 15]! << 25)) ^
				((this.w[t - 15]! >>> 18) | (this.w[t - 15]! << 14)) ^
				(this.w[t - 15]! >>> 3);
			const s1 =
				((this.w[t - 2]! >>> 17) | (this.w[t - 2]! << 15)) ^
				((this.w[t - 2]! >>> 19) | (this.w[t - 2]! << 13)) ^
				(this.w[t - 2]! >>> 10);
			this.w[t] = (this.w[t - 16]! + s0 + this.w[t - 7]! + s1) | 0;
		}
		let a = this.h0;
		let b = this.h1;
		let c = this.h2;
		let d = this.h3;
		let e = this.h4;
		let f = this.h5;
		let g = this.h6;
		let h = this.h7;
		for (let t = 0; t < 64; t++) {
			const S1 =
				((e >>> 6) | (e << 26)) ^
				((e >>> 11) | (e << 21)) ^
				((e >>> 25) | (e << 7));
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + S1 + ch + K[t]! + this.w[t]!) | 0;
			const S0 =
				((a >>> 2) | (a << 30)) ^
				((a >>> 13) | (a << 19)) ^
				((a >>> 22) | (a << 10));
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (S0 + maj) | 0;
			h = g;
			g = f;
			f = e;
			e = (d + temp1) | 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) | 0;
		}
		this.h0 = (this.h0 + a) | 0;
		this.h1 = (this.h1 + b) | 0;
		this.h2 = (this.h2 + c) | 0;
		this.h3 = (this.h3 + d) | 0;
		this.h4 = (this.h4 + e) | 0;
		this.h5 = (this.h5 + f) | 0;
		this.h6 = (this.h6 + g) | 0;
		this.h7 = (this.h7 + h) | 0;
	}

	update(data: string | Uint8Array | ArrayBufferView, encoding?: string): this {
		let bytes: Uint8Array;
		if (typeof data === "string") {
			if (encoding === "hex" || encoding === "base64" || encoding === "base64url") {
				bytes = ShimBuffer.from(data, encoding);
			} else {
				bytes = new TextEncoder().encode(data);
			}
		} else if (ArrayBuffer.isView(data)) {
			bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		} else {
			bytes = new Uint8Array(data);
		}

		this.totalLen += bytes.length;
		let offset = 0;
		while (offset < bytes.length) {
			const take = Math.min(bytes.length - offset, 64 - this.blockLen);
			this.block.set(bytes.subarray(offset, offset + take), this.blockLen);
			this.blockLen += take;
			offset += take;
			if (this.blockLen === 64) {
				this.compress(this.block);
				this.blockLen = 0;
			}
		}
		return this;
	}

	digest(): Buffer;
	digest(encoding: "hex" | "base64" | "base64url"): string;
	digest(encoding?: string): Buffer | string {
		const bitLen = this.totalLen * 8;
		this.block[this.blockLen++] = 0x80;
		if (this.blockLen > 56) {
			for (let i = this.blockLen; i < 64; i++) {
				this.block[i] = 0;
			}
			this.compress(this.block);
			this.blockLen = 0;
		}
		for (let i = this.blockLen; i < 56; i++) {
			this.block[i] = 0;
		}
		const view = new DataView(this.block.buffer, this.block.byteOffset, 64);
		view.setBigUint64(56, BigInt(bitLen), false);
		this.compress(this.block);

		const out = new Uint8Array(32);
		const outView = new DataView(out.buffer);
		outView.setInt32(0, this.h0, false);
		outView.setInt32(4, this.h1, false);
		outView.setInt32(8, this.h2, false);
		outView.setInt32(12, this.h3, false);
		outView.setInt32(16, this.h4, false);
		outView.setInt32(20, this.h5, false);
		outView.setInt32(24, this.h6, false);
		outView.setInt32(28, this.h7, false);

		if (encoding === "hex") {
			return Array.from(out)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
		}
		if (encoding === "base64") {
			return toBuffer(out).toString("base64");
		}
		if (encoding === "base64url") {
			return toBuffer(out).toString("base64url" as BufferEncoding);
		}
		return toBuffer(out);
	}
}

export class Hmac {
	private opad = new Uint8Array(64);
	private inner: Hash;

	constructor(algorithm: string, key: string | Uint8Array | ArrayBufferView) {
		const algo = algorithm.toLowerCase().replace(/-/g, "");
		if (algo !== "sha256") {
			throw new Error(`Unsupported hmac algorithm: ${algorithm}`);
		}

		let k: Uint8Array;
		if (typeof key === "string") {
			k = new TextEncoder().encode(key);
		} else if (ArrayBuffer.isView(key)) {
			k = new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
		} else {
			k = new Uint8Array(key);
		}

		if (k.length > 64) {
			const hash = new Hash("sha256");
			hash.update(k);
			k = new Uint8Array(hash.digest());
		}

		const ipad = new Uint8Array(64);
		for (let i = 0; i < 64; i++) {
			const b = i < k.length ? k[i]! : 0;
			this.opad[i] = b ^ 0x5c;
			ipad[i] = b ^ 0x36;
		}

		this.inner = new Hash("sha256");
		this.inner.update(ipad);
	}

	update(data: string | Uint8Array | ArrayBufferView, encoding?: string): this {
		this.inner.update(data, encoding);
		return this;
	}

	digest(): Buffer;
	digest(encoding: "hex" | "base64" | "base64url"): string;
	digest(encoding?: string): Buffer | string {
		const innerDigest = this.inner.digest();
		const outer = new Hash("sha256");
		outer.update(this.opad);
		outer.update(innerDigest);
		if (encoding === "hex" || encoding === "base64" || encoding === "base64url") {
			return outer.digest(encoding);
		}
		return outer.digest();
	}
}

export function createHash(algorithm: string): Hash {
	return new Hash(algorithm);
}

export function createHmac(algorithm: string, key: string | Uint8Array | ArrayBufferView): Hmac {
	return new Hmac(algorithm, key);
}

export function randomUUID(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	const bytes = new Uint8Array(16);
	if (typeof globalThis.crypto?.getRandomValues === "function") {
		globalThis.crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export function randomBytes(size: number): Buffer {
	const bytes = new Uint8Array(size);
	if (typeof globalThis.crypto?.getRandomValues === "function") {
		globalThis.crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < size; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	return toBuffer(bytes);
}

export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
	if (a.byteLength !== b.byteLength) {
		throw new RangeError("Input buffers must have the same length");
	}
	const viewA = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	const viewB = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
	let diff = 0;
	for (let i = 0; i < viewA.length; i++) {
		diff |= viewA[i]! ^ viewB[i]!;
	}
	return diff === 0;
}

const cryptoShim = {
	createHash,
	createHmac,
	randomUUID,
	randomBytes,
	timingSafeEqual,
	Hash,
	Hmac,
};

export default cryptoShim;
