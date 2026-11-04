import { getHostBridge } from "../host-bridge.ts";
import {
	accessSync,
	chmodSync,
	ensureParentDirs,
	getInternalDirs,
	getInternalFiles,
	mkdirSync,
	mkdtempSync,
	normalizeFsPath,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	appendFileSync,
	type Dirent,
	type MemfsOptions,
	type PathLike,
	type Stats,
} from "./fs.ts";

export interface FileHandle {
	read<T extends Uint8Array | ArrayBufferView>(
		buffer: T,
		offset?: number,
		length?: number,
		position?: number | null,
	): Promise<{ bytesRead: number; buffer: T }>;
	close(): Promise<void>;
	stat(): Promise<Stats>;
}

async function ensureFileCached(normPath: string): Promise<boolean> {
	const files = getInternalFiles();
	if (files.has(normPath)) {
		return true;
	}
	try {
		const bytes = await getHostBridge().readExternalFile(normPath);
		files.set(normPath, bytes);
		ensureParentDirs(normPath);
		return true;
	} catch {
		return false;
	}
}

export async function readFile(path: PathLike, options: { encoding: BufferEncoding | string; [key: string]: unknown } | BufferEncoding | string): Promise<string>;
export async function readFile(path: PathLike, options?: { encoding?: null; [key: string]: unknown } | null): Promise<Buffer>;
export async function readFile(path: PathLike, options?: MemfsOptions | string | null): Promise<Buffer | string>;
export async function readFile(
	path: PathLike,
	options?: MemfsOptions | string | null,
): Promise<Buffer | string> {
	const norm = normalizeFsPath(path);
	const files = getInternalFiles();
	if (!files.has(norm)) {
		await ensureFileCached(norm);
	}
	return readFileSync(norm, options);
}

export async function writeFile(
	path: PathLike,
	data: string | Uint8Array | ArrayBufferView,
	options?: MemfsOptions | string | null,
): Promise<void> {
	writeFileSync(path, data, options);
}

export async function appendFile(
	path: PathLike,
	data: string | Uint8Array | ArrayBufferView,
	options?: MemfsOptions | string | null,
): Promise<void> {
	appendFileSync(path, data, options);
}

export async function stat(path: PathLike): Promise<Stats> {
	const norm = normalizeFsPath(path);
	const files = getInternalFiles();
	const dirs = getInternalDirs();
	if (!files.has(norm) && !dirs.has(norm)) {
		await ensureFileCached(norm);
	}
	return statSync(norm);
}

export async function lstat(path: PathLike): Promise<Stats> {
	return stat(path);
}

export async function mkdir(
	path: PathLike,
	options?: { recursive?: boolean; mode?: number } | boolean | number,
): Promise<string | undefined> {
	return mkdirSync(path, options);
}

export async function readdir(path: PathLike, options: { withFileTypes: true; [key: string]: unknown }): Promise<Dirent[]>;
export async function readdir(path: PathLike, options?: { withFileTypes?: false; [key: string]: unknown } | null | string): Promise<string[]>;
export async function readdir(path: PathLike, options?: { withFileTypes?: boolean; [key: string]: unknown } | null | string): Promise<string[] | Dirent[]>;
export async function readdir(
	path: PathLike,
	options?: { withFileTypes?: boolean } | null | string,
): Promise<string[] | Dirent[]> {
	return readdirSync(path, options);
}

export async function rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
	renameSync(oldPath, newPath);
}

export async function unlink(path: PathLike): Promise<void> {
	unlinkSync(path);
}

export async function rm(
	path: PathLike,
	options?: { recursive?: boolean; force?: boolean } | null,
): Promise<void> {
	rmSync(path, options);
}

export async function mkdtemp(
	prefix: string,
	options?: MemfsOptions | string | null,
): Promise<string> {
	return mkdtempSync(prefix, options);
}

export async function realpath(path: PathLike): Promise<string> {
	return realpathSync(path);
}

export async function access(path: PathLike, mode?: number): Promise<void> {
	accessSync(path, mode);
}

export async function chmod(path: PathLike, mode: number): Promise<void> {
	chmodSync(path, mode);
}

export async function open(path: PathLike, _flags = "r"): Promise<FileHandle> {
	const norm = normalizeFsPath(path);
	const files = getInternalFiles();
	if (!files.has(norm)) {
		await ensureFileCached(norm);
	}
	if (!files.has(norm)) {
		const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code: string };
		err.code = "ENOENT";
		throw err;
	}

	let currentPos = 0;
	return {
		async read<T extends Uint8Array | ArrayBufferView>(
			buffer: T,
			offset = 0,
			length = buffer.byteLength,
			position: number | null = null,
		): Promise<{ bytesRead: number; buffer: T }> {
			const fileBytes = files.get(norm)!;
			const pos = position !== null && position !== undefined ? position : currentPos;
			if (pos >= fileBytes.length) {
				return { bytesRead: 0, buffer };
			}
			const toRead = Math.min(length, fileBytes.length - pos, buffer.byteLength - offset);
			const targetView = ArrayBuffer.isView(buffer)
				? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
				: new Uint8Array(buffer);
			targetView.set(fileBytes.subarray(pos, pos + toRead), offset);
			if (position === null || position === undefined) {
				currentPos += toRead;
			}
			return { bytesRead: toRead, buffer };
		},
		async close(): Promise<void> {
			// no-op
		},
		async stat(): Promise<Stats> {
			return stat(norm);
		},
	};
}

const fsPromises = {
	readFile,
	writeFile,
	appendFile,
	stat,
	lstat,
	mkdir,
	readdir,
	rename,
	unlink,
	rm,
	mkdtemp,
	realpath,
	access,
	chmod,
	open,
};

export default fsPromises;
