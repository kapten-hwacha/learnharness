// Browser-safe node:fs stub for Web Worker runtime

export const existsSync = (..._args: unknown[]): boolean => false;
export const readdirSync = (..._args: unknown[]): string[] => [];
export const readFileSync = (..._args: unknown[]): never => {
	throw new Error("fs is not supported in browser/worker runtime");
};
export const writeFileSync = (..._args: unknown[]): never => {
	throw new Error("fs is not supported in browser/worker runtime");
};
export const mkdirSync = (..._args: unknown[]): never => {
	throw new Error("fs is not supported in browser/worker runtime");
};
export const rmSync = (..._args: unknown[]): never => {
	throw new Error("fs is not supported in browser/worker runtime");
};
export const unlinkSync = (..._args: unknown[]): never => {
	throw new Error("fs is not supported in browser/worker runtime");
};
export const statSync = (..._args: unknown[]): never => {
	throw new Error("fs is not supported in browser/worker runtime");
};
export const lstatSync = (..._args: unknown[]): never => {
	throw new Error("fs is not supported in browser/worker runtime");
};
export const realpathSync = Object.assign((p: string, ..._args: unknown[]): string => p, {
	native: (p: string, ..._args: unknown[]): string => p,
});
export const openSync = (..._args: unknown[]): never => {
	throw new Error("fs is not supported in browser/worker runtime");
};
export const readSync = (..._args: unknown[]): never => {
	throw new Error("fs is not supported in browser/worker runtime");
};
export const closeSync = (..._args: unknown[]): void => {};
export const chmodSync = (..._args: unknown[]): void => {};
export const renameSync = (..._args: unknown[]): never => {
	throw new Error("fs is not supported in browser/worker runtime");
};
export const accessSync = (..._args: unknown[]): never => {
	throw new Error("fs is not supported in browser/worker runtime");
};
export const appendFileSync = (..._args: unknown[]): never => {
	throw new Error("fs is not supported in browser/worker runtime");
};
export const mkdtempSync = (..._args: unknown[]): never => {
	throw new Error("fs is not supported in browser/worker runtime");
};

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

export const readFile = async (..._args: unknown[]): Promise<never> => {
	throw new Error("fs/promises is not supported in browser/worker runtime");
};
export const writeFile = async (..._args: unknown[]): Promise<never> => {
	throw new Error("fs/promises is not supported in browser/worker runtime");
};
export const mkdir = async (..._args: unknown[]): Promise<never> => {
	throw new Error("fs/promises is not supported in browser/worker runtime");
};
export const rm = async (..._args: unknown[]): Promise<never> => {
	throw new Error("fs/promises is not supported in browser/worker runtime");
};
export const stat = async (..._args: unknown[]): Promise<never> => {
	throw new Error("fs/promises is not supported in browser/worker runtime");
};
export const readdir = async (..._args: unknown[]): Promise<string[]> => [];
export const open = async (..._args: unknown[]): Promise<never> => {
	throw new Error("fs/promises is not supported in browser/worker runtime");
};
export const unlink = async (..._args: unknown[]): Promise<never> => {
	throw new Error("fs/promises is not supported in browser/worker runtime");
};
export const rename = async (..._args: unknown[]): Promise<never> => {
	throw new Error("fs/promises is not supported in browser/worker runtime");
};
export const appendFile = async (..._args: unknown[]): Promise<never> => {
	throw new Error("fs/promises is not supported in browser/worker runtime");
};
export const access = async (..._args: unknown[]): Promise<never> => {
	throw new Error("fs/promises is not supported in browser/worker runtime");
};
export const realpath = async (p: string, ..._args: unknown[]): Promise<string> => p;
export const lstat = async (..._args: unknown[]): Promise<never> => {
	throw new Error("fs/promises is not supported in browser/worker runtime");
};
export const chmod = async (..._args: unknown[]): Promise<void> => {};
export const mkdtemp = async (..._args: unknown[]): Promise<never> => {
	throw new Error("fs/promises is not supported in browser/worker runtime");
};

export const promises = {
	readFile,
	writeFile,
	mkdir,
	rm,
	stat,
	readdir,
	open,
	unlink,
	rename,
	appendFile,
	access,
	realpath,
	lstat,
	chmod,
	mkdtemp,
};

const defaultExport = {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	rmSync,
	unlinkSync,
	readdirSync,
	statSync,
	lstatSync,
	realpathSync,
	openSync,
	readSync,
	closeSync,
	chmodSync,
	renameSync,
	accessSync,
	appendFileSync,
	mkdtempSync,
	constants,
	promises,
	readFile,
	writeFile,
	mkdir,
	rm,
	stat,
	readdir,
	open,
	unlink,
	rename,
	appendFile,
	access,
	realpath,
	lstat,
	chmod,
	mkdtemp,
};

export default defaultExport;
