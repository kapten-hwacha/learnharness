import { getHostBridge, type FsMutationOp, type HydratedFsSnapshot } from "../host-bridge.ts";
import { ShimBuffer, toBuffer } from "./crypto.ts";
import { dirname, normalize } from "./path.ts";

export interface MemfsOptions {
	encoding?: BufferEncoding | string | null;
	mode?: number;
	flag?: string;
}

export type PathLike = string | URL | Uint8Array;

function createError(code: string, message: string): Error & { code: string } {
	const err = new Error(message) as Error & { code: string };
	err.code = code;
	return err;
}

export function normalizeFsPath(p: PathLike): string {
	let str: string;
	if (typeof p === "string") {
		str = p;
	} else if (p instanceof URL) {
		str = decodeURIComponent(p.pathname);
	} else if (ArrayBuffer.isView(p)) {
		str = new TextDecoder().decode(p);
	} else {
		str = String(p);
	}
	const norm = normalize(str);
	const rooted = norm.startsWith("/") ? norm : "/" + norm;
	if (rooted.length > 1 && rooted.endsWith("/")) {
		return rooted.replace(/\/+$/, "");
	}
	return rooted;
}

const files = new Map<string, Uint8Array>();
const dirs = new Set<string>(["/"]);
const fileModes = new Map<string, number>();
const fileMtimes = new Map<string, number>();

let syncChain: Promise<void> = Promise.resolve();

function toBase64(bytes: Uint8Array): string {
	if (typeof globalThis.Buffer !== "undefined") {
		return globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
	}
	return ShimBuffer.from(bytes).toString("base64");
}

function fromBase64(base64: string): Uint8Array {
	if (typeof globalThis.Buffer !== "undefined") {
		const buf = globalThis.Buffer.from(base64, "base64");
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	return ShimBuffer.from(base64, "base64");
}

export function ensureParentDirs(normPath: string): void {
	let dir = dirname(normPath);
	while (dir !== "/" && dir !== "." && dir.length > 0) {
		dirs.add(dir);
		dir = dirname(dir);
	}
	dirs.add("/");
}

export function getInternalFiles(): Map<string, Uint8Array> {
	return files;
}

export function getInternalDirs(): Set<string> {
	return dirs;
}

export function enqueueOp(op: FsMutationOp): void {
	syncChain = syncChain.then(async () => {
		try {
			await getHostBridge().syncFs(op);
		} catch (err) {
			console.warn("[memfs] write-behind syncFs error:", err);
		}
	});
}

export async function flushFsQueue(): Promise<void> {
	await syncChain;
}

export function hydrateMemfs(snapshot: HydratedFsSnapshot): void {
	files.clear();
	dirs.clear();
	fileModes.clear();
	fileMtimes.clear();
	dirs.add("/");

	for (const d of snapshot.dirs) {
		const normDir = normalizeFsPath(d);
		dirs.add(normDir);
		ensureParentDirs(normDir);
	}

	for (const [filePath, base64] of Object.entries(snapshot.files)) {
		const normFile = normalizeFsPath(filePath);
		const bytes = fromBase64(base64);
		files.set(normFile, bytes);
		fileMtimes.set(normFile, Date.now());
		ensureParentDirs(normFile);
	}

	syncChain = Promise.resolve();
}

export class Dirent {
	name: string;
	private _isDir: boolean;
	private _isFile: boolean;
	private _isSymlink: boolean;

	constructor(name: string, isDirectory: boolean, isFile: boolean, isSymbolicLink = false) {
		this.name = name;
		this._isDir = isDirectory;
		this._isFile = isFile;
		this._isSymlink = isSymbolicLink;
	}

	isDirectory(): boolean {
		return this._isDir;
	}
	isFile(): boolean {
		return this._isFile;
	}
	isSymbolicLink(): boolean {
		return this._isSymlink;
	}
	isBlockDevice(): boolean {
		return false;
	}
	isCharacterDevice(): boolean {
		return false;
	}
	isFIFO(): boolean {
		return false;
	}
	isSocket(): boolean {
		return false;
	}
}

export class Stats {
	private _isDir: boolean;
	private _isFile: boolean;
	size: number;
	mtimeMs: number;
	atimeMs: number;
	ctimeMs: number;
	birthtimeMs: number;
	mode: number;

	constructor(isDir: boolean, isFile: boolean, size: number, mtimeMs: number, mode: number) {
		this._isDir = isDir;
		this._isFile = isFile;
		this.size = size;
		this.mtimeMs = mtimeMs;
		this.atimeMs = mtimeMs;
		this.ctimeMs = mtimeMs;
		this.birthtimeMs = mtimeMs;
		this.mode = mode;
	}

	isDirectory(): boolean {
		return this._isDir;
	}
	isFile(): boolean {
		return this._isFile;
	}
	isSymbolicLink(): boolean {
		return false;
	}
	isBlockDevice(): boolean {
		return false;
	}
	isCharacterDevice(): boolean {
		return false;
	}
	isFIFO(): boolean {
		return false;
	}
	isSocket(): boolean {
		return false;
	}
	get mtime(): Date {
		return new Date(this.mtimeMs);
	}
	get atime(): Date {
		return new Date(this.atimeMs);
	}
	get ctime(): Date {
		return new Date(this.ctimeMs);
	}
	get birthtime(): Date {
		return new Date(this.birthtimeMs);
	}
}

export function existsSync(path: PathLike): boolean {
	const norm = normalizeFsPath(path);
	return files.has(norm) || dirs.has(norm);
}

export function readFileSync(path: PathLike, options: { encoding: BufferEncoding | string; [key: string]: unknown } | BufferEncoding | string): string;
export function readFileSync(path: PathLike, options?: { encoding?: null; [key: string]: unknown } | null): Buffer;
export function readFileSync(path: PathLike, options?: MemfsOptions | string | null): Buffer | string;
export function readFileSync(path: PathLike, options?: MemfsOptions | string | null): Buffer | string {
	const norm = normalizeFsPath(path);
	if (dirs.has(norm)) {
		throw createError("EISDIR", `EISDIR: illegal operation on a directory, read '${path}'`);
	}
	if (!files.has(norm)) {
		throw createError("ENOENT", `ENOENT: no such file or directory, open '${path}'`);
	}
	const bytes = files.get(norm)!;
	const encoding = typeof options === "string" ? options : options?.encoding;
	if (encoding === "utf8" || encoding === "utf-8") {
		return new TextDecoder().decode(bytes);
	}
	if (encoding) {
		return toBuffer(bytes).toString(encoding as BufferEncoding);
	}
	return toBuffer(bytes);
}

let nextFd = 100;
interface OpenFd {
	path: string;
	flags: string;
	position: number;
}
const openFds = new Map<number, OpenFd>();

export function openSync(path: PathLike, flags: string | number = "r", _mode?: number): number {
	const norm = normalizeFsPath(path);
	const fd = nextFd++;
	openFds.set(fd, { path: norm, flags: String(flags), position: 0 });
	if (String(flags).includes("w") || String(flags).includes("a")) {
		ensureParentDirs(norm);
		if (!files.has(norm)) files.set(norm, new Uint8Array(0));
	}
	return fd;
}

export function closeSync(fd: number): void {
	openFds.delete(fd);
}

export function fsyncSync(_fd: number): void {
	// Sync in memory
}

export function readSync(
	fd: number,
	buffer: NodeJS.ArrayBufferView,
	offset?: number,
	length?: number,
	position?: number | null,
): number {
	const handle = openFds.get(fd);
	if (!handle) throw createError("EBADF", "bad file descriptor");
	const data = files.get(handle.path) ?? new Uint8Array(0);
	const pos = position != null ? position : handle.position;
	const len = length ?? buffer.byteLength;
	const off = offset ?? 0;
	const bytesToRead = Math.min(len, Math.max(0, data.length - pos));
	const target = new Uint8Array(buffer.buffer, buffer.byteOffset + off, bytesToRead);
	target.set(data.subarray(pos, pos + bytesToRead));
	if (position == null) handle.position += bytesToRead;
	return bytesToRead;
}

export function writeFileSync(
	file: PathLike | number,
	data: string | Uint8Array | ArrayBufferView,
	options?: MemfsOptions | string | null,
): void {
	if (typeof file === "number") {
		const handle = openFds.get(file);
		if (!handle) throw createError("EBADF", "bad file descriptor");
		return writeFileSync(handle.path, data, options);
	}
	const norm = normalizeFsPath(file);
	if (dirs.has(norm)) {
		throw createError("EISDIR", `EISDIR: illegal operation on a directory, open '${String(file)}'`);
	}
	ensureParentDirs(norm);

	let bytes: Uint8Array;
	if (typeof data === "string") {
		const enc = typeof options === "string" ? options : options?.encoding;
		if (enc && enc !== "utf8" && enc !== "utf-8") {
			bytes = ShimBuffer.from(data, enc);
		} else {
			bytes = new TextEncoder().encode(data);
		}
	} else if (ArrayBuffer.isView(data)) {
		bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	} else {
		bytes = new Uint8Array(data);
	}

	const mode = typeof options === "object" ? options?.mode : undefined;
	files.set(norm, bytes);
	fileMtimes.set(norm, Date.now());
	if (mode !== undefined) {
		fileModes.set(norm, mode);
	}

	enqueueOp({ type: "writeFile", path: norm, dataBase64: toBase64(bytes), mode });
}

export function appendFileSync(
	path: PathLike,
	data: string | Uint8Array | ArrayBufferView,
	options?: MemfsOptions | string | null,
): void {
	const norm = normalizeFsPath(path);
	if (dirs.has(norm)) {
		throw createError("EISDIR", `EISDIR: illegal operation on a directory, open '${path}'`);
	}
	ensureParentDirs(norm);

	let newBytes: Uint8Array;
	if (typeof data === "string") {
		newBytes = new TextEncoder().encode(data);
	} else if (ArrayBuffer.isView(data)) {
		newBytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	} else {
		newBytes = new Uint8Array(data);
	}

	const existing = files.get(norm);
	let combined: Uint8Array;
	if (existing) {
		combined = new Uint8Array(existing.length + newBytes.length);
		combined.set(existing, 0);
		combined.set(newBytes, existing.length);
	} else {
		combined = newBytes;
	}

	const mode = typeof options === "object" ? options?.mode : undefined;
	files.set(norm, combined);
	fileMtimes.set(norm, Date.now());
	if (mode !== undefined) {
		fileModes.set(norm, mode);
	}

	enqueueOp({ type: "appendFile", path: norm, dataBase64: toBase64(newBytes), mode });
}

export function statSync(path: PathLike): Stats {
	const norm = normalizeFsPath(path);
	if (files.has(norm)) {
		const bytes = files.get(norm)!;
		const mtime = fileMtimes.get(norm) ?? Date.now();
		const mode = fileModes.get(norm) ?? 0o100644;
		return new Stats(false, true, bytes.length, mtime, mode);
	}
	if (dirs.has(norm)) {
		return new Stats(true, false, 4096, Date.now(), 0o040755);
	}
	throw createError("ENOENT", `ENOENT: no such file or directory, stat '${path}'`);
}

export function lstatSync(path: PathLike): Stats {
	return statSync(path);
}

export function mkdirSync(
	path: PathLike,
	options?: { recursive?: boolean; mode?: number } | boolean | number,
): string | undefined {
	const norm = normalizeFsPath(path);
	const recursive = typeof options === "boolean" ? options : Boolean(options && typeof options === "object" && options.recursive);

	if (!recursive) {
		const parent = dirname(norm);
		if (!dirs.has(parent) && parent !== norm) {
			throw createError("ENOENT", `ENOENT: no such file or directory, mkdir '${path}'`);
		}
	}

	dirs.add(norm);
	if (recursive) {
		ensureParentDirs(norm);
	}

	const mode = typeof options === "object" ? options?.mode : typeof options === "number" ? options : undefined;
	enqueueOp({ type: "mkdir", path: norm, recursive, mode });
	return recursive ? norm : undefined;
}

export function readdirSync(path: PathLike, options: { withFileTypes: true; [key: string]: unknown }): Dirent[];
export function readdirSync(path: PathLike, options?: { withFileTypes?: false; [key: string]: unknown } | null | string): string[];
export function readdirSync(path: PathLike, options?: { withFileTypes?: boolean; [key: string]: unknown } | null | string): string[] | Dirent[];
export function readdirSync(
	path: PathLike,
	options?: { withFileTypes?: boolean } | null | string,
): string[] | Dirent[] {
	const norm = normalizeFsPath(path);
	if (files.has(norm)) {
		throw createError("ENOTDIR", `ENOTDIR: not a directory, scandir '${path}'`);
	}
	if (!dirs.has(norm)) {
		throw createError("ENOENT", `ENOENT: no such file or directory, scandir '${path}'`);
	}

	const prefix = norm === "/" ? "/" : norm + "/";
	const childMap = new Map<string, { isDir: boolean; isFile: boolean }>();

	for (const f of files.keys()) {
		if (f.startsWith(prefix)) {
			const rest = f.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) {
				childMap.set(rest, { isDir: false, isFile: true });
			} else {
				const sub = rest.slice(0, slash);
				if (!childMap.has(sub)) {
					childMap.set(sub, { isDir: true, isFile: false });
				}
			}
		}
	}

	for (const d of dirs) {
		if (d !== norm && d.startsWith(prefix)) {
			const rest = d.slice(prefix.length);
			const slash = rest.indexOf("/");
			const sub = slash === -1 ? rest : rest.slice(0, slash);
			if (sub.length > 0 && !childMap.has(sub)) {
				childMap.set(sub, { isDir: true, isFile: false });
			}
		}
	}

	const names = Array.from(childMap.keys()).sort();
	if (typeof options === "object" && options?.withFileTypes) {
		return names.map((name) => {
			const info = childMap.get(name)!;
			return new Dirent(name, info.isDir, info.isFile);
		});
	}
	return names;
}

export function renameSync(oldPath: PathLike, newPath: PathLike): void {
	const normOld = normalizeFsPath(oldPath);
	const normNew = normalizeFsPath(newPath);

	const isFile = files.has(normOld);
	const isDir = dirs.has(normOld);
	if (!isFile && !isDir) {
		throw createError("ENOENT", `ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`);
	}

	ensureParentDirs(normNew);

	if (isFile) {
		const bytes = files.get(normOld)!;
		const mtime = fileMtimes.get(normOld);
		const mode = fileModes.get(normOld);

		files.delete(normOld);
		fileMtimes.delete(normOld);
		fileModes.delete(normOld);

		if (dirs.has(normNew)) {
			dirs.delete(normNew);
		}

		files.set(normNew, bytes);
		if (mtime !== undefined) fileMtimes.set(normNew, mtime);
		if (mode !== undefined) fileModes.set(normNew, mode);
	} else {
		dirs.delete(normOld);
		dirs.add(normNew);

		const oldPrefix = normOld + "/";
		const newPrefix = normNew + "/";

		for (const [f, b] of Array.from(files.entries())) {
			if (f.startsWith(oldPrefix)) {
				files.delete(f);
				files.set(newPrefix + f.slice(oldPrefix.length), b);
			}
		}
		for (const d of Array.from(dirs)) {
			if (d.startsWith(oldPrefix)) {
				dirs.delete(d);
				dirs.add(newPrefix + d.slice(oldPrefix.length));
			}
		}
	}

	enqueueOp({ type: "rename", oldPath: normOld, newPath: normNew });
}

export function unlinkSync(path: PathLike): void {
	const norm = normalizeFsPath(path);
	if (dirs.has(norm)) {
		throw createError("EPERM", `EPERM: operation not permitted, unlink '${path}'`);
	}
	if (!files.has(norm)) {
		throw createError("ENOENT", `ENOENT: no such file or directory, unlink '${path}'`);
	}
	files.delete(norm);
	fileMtimes.delete(norm);
	fileModes.delete(norm);
	enqueueOp({ type: "unlink", path: norm });
}

export function rmSync(
	path: PathLike,
	options?: { recursive?: boolean; force?: boolean } | null,
): void {
	const norm = normalizeFsPath(path);
	const force = Boolean(options?.force);
	const recursive = Boolean(options?.recursive);
	const exists = files.has(norm) || dirs.has(norm);

	if (!exists) {
		if (force) return;
		throw createError("ENOENT", `ENOENT: no such file or directory, rm '${path}'`);
	}

	if (files.has(norm)) {
		files.delete(norm);
		fileMtimes.delete(norm);
		fileModes.delete(norm);
	} else if (dirs.has(norm)) {
		if (!recursive) {
			const prefix = norm === "/" ? "/" : norm + "/";
			let hasChildren = false;
			for (const f of files.keys()) {
				if (f.startsWith(prefix)) {
					hasChildren = true;
					break;
				}
			}
			if (!hasChildren) {
				for (const d of dirs) {
					if (d !== norm && d.startsWith(prefix)) {
						hasChildren = true;
						break;
					}
				}
			}
			if (hasChildren) {
				throw createError("ENOTEMPTY", `ENOTEMPTY: directory not empty, rm '${path}'`);
			}
			dirs.delete(norm);
		} else {
			dirs.delete(norm);
			const prefix = norm === "/" ? "/" : norm + "/";
			for (const f of Array.from(files.keys())) {
				if (f.startsWith(prefix)) {
					files.delete(f);
					fileMtimes.delete(f);
					fileModes.delete(f);
				}
			}
			for (const d of Array.from(dirs)) {
				if (d.startsWith(prefix)) {
					dirs.delete(d);
				}
			}
		}
	}

	enqueueOp({ type: "rm", path: norm, recursive, force });
}

export function mkdtempSync(prefix: string, _options?: MemfsOptions | string | null): string {
	const suffix = Math.random().toString(36).slice(2, 8);
	const dir = prefix + suffix;
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function realpathSync(path: PathLike): string {
	const norm = normalizeFsPath(path);
	if (!existsSync(norm)) {
		throw createError("ENOENT", `ENOENT: no such file or directory, realpath '${path}'`);
	}
	return norm;
}

export function accessSync(path: PathLike, _mode?: number): void {
	const norm = normalizeFsPath(path);
	if (!existsSync(norm)) {
		throw createError("ENOENT", `ENOENT: no such file or directory, access '${path}'`);
	}
}

export function chmodSync(path: PathLike, mode: number): void {
	const norm = normalizeFsPath(path);
	if (!existsSync(norm)) {
		throw createError("ENOENT", `ENOENT: no such file or directory, chmod '${path}'`);
	}
	if (files.has(norm)) {
		fileModes.set(norm, mode);
	}
}

export const constants = {
	F_OK: 0,
	R_OK: 4,
	W_OK: 2,
	X_OK: 1,
	O_RDONLY: 0,
	O_WRONLY: 1,
	O_RDWR: 2,
	O_CREAT: 64,
	O_EXCL: 128,
	O_TRUNC: 512,
	O_APPEND: 1024,
};

// Lazy import fsPromises to break circular dependency
export const promises = {
	async readFile(path: PathLike, options?: MemfsOptions | string | null): Promise<Buffer | string> {
		const { readFile } = await import("./fs-promises.ts");
		return readFile(path, options);
	},
	async writeFile(path: PathLike, data: string | Uint8Array | ArrayBufferView, options?: MemfsOptions | string | null): Promise<void> {
		const { writeFile } = await import("./fs-promises.ts");
		return writeFile(path, data, options);
	},
	async appendFile(path: PathLike, data: string | Uint8Array | ArrayBufferView, options?: MemfsOptions | string | null): Promise<void> {
		const { appendFile } = await import("./fs-promises.ts");
		return appendFile(path, data, options);
	},
	async stat(path: PathLike): Promise<Stats> {
		const { stat } = await import("./fs-promises.ts");
		return stat(path);
	},
	async lstat(path: PathLike): Promise<Stats> {
		const { lstat } = await import("./fs-promises.ts");
		return lstat(path);
	},
	async mkdir(path: PathLike, options?: { recursive?: boolean; mode?: number } | boolean | number): Promise<string | undefined> {
		const { mkdir } = await import("./fs-promises.ts");
		return mkdir(path, options);
	},
	async readdir(path: PathLike, options?: { withFileTypes?: boolean } | null): Promise<string[] | Dirent[]> {
		const { readdir } = await import("./fs-promises.ts");
		return readdir(path, options);
	},
	async rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
		const { rename } = await import("./fs-promises.ts");
		return rename(oldPath, newPath);
	},
	async unlink(path: PathLike): Promise<void> {
		const { unlink } = await import("./fs-promises.ts");
		return unlink(path);
	},
	async rm(path: PathLike, options?: { recursive?: boolean; force?: boolean } | null): Promise<void> {
		const { rm } = await import("./fs-promises.ts");
		return rm(path, options);
	},
	async mkdtemp(prefix: string, options?: MemfsOptions | string | null): Promise<string> {
		const { mkdtemp } = await import("./fs-promises.ts");
		return mkdtemp(prefix, options);
	},
	async realpath(path: PathLike): Promise<string> {
		const { realpath } = await import("./fs-promises.ts");
		return realpath(path);
	},
	async access(path: PathLike, mode?: number): Promise<void> {
		const { access } = await import("./fs-promises.ts");
		return access(path, mode);
	},
	async chmod(path: PathLike, mode: number): Promise<void> {
		const { chmod } = await import("./fs-promises.ts");
		return chmod(path, mode);
	},
	async open(path: PathLike, flags?: string): Promise<import("./fs-promises.ts").FileHandle> {
		const { open } = await import("./fs-promises.ts");
		return open(path, flags);
	},
};

const fsShim = {
	hydrateMemfs,
	flushFsQueue,
	readFileSync,
	writeFileSync,
	appendFileSync,
	existsSync,
	statSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	unlinkSync,
	rmSync,
	mkdtempSync,
	realpathSync,
	accessSync,
	chmodSync,
	openSync,
	readSync,
	closeSync,
	fsyncSync,
	constants,
	promises,
	Dirent,
	Stats,
};

export default fsShim;
