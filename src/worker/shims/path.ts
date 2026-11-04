export const sep = "/";
export const delimiter = ":";

export function isAbsolute(p: string): boolean {
	return p.startsWith("/");
}

export function normalize(p: string): string {
	if (typeof p !== "string" || p.length === 0) return ".";

	const isAbs = p.startsWith("/");
	const hasTrailingSlash = p.endsWith("/") && p !== "/";

	const rawSegments = p.split("/").filter((seg) => seg.length > 0 && seg !== ".");
	const resolvedSegments: string[] = [];

	for (const seg of rawSegments) {
		if (seg === "..") {
			if (resolvedSegments.length > 0 && resolvedSegments[resolvedSegments.length - 1] !== "..") {
				resolvedSegments.pop();
			} else if (!isAbs) {
				resolvedSegments.push("..");
			}
		} else {
			resolvedSegments.push(seg);
		}
	}

	let result = (isAbs ? "/" : "") + resolvedSegments.join("/");
	if (result.length === 0) {
		result = isAbs ? "/" : ".";
	} else if (hasTrailingSlash && !result.endsWith("/")) {
		result += "/";
	}

	return result;
}

export function join(...paths: string[]): string {
	const nonEmp = paths.filter((p) => typeof p === "string" && p.length > 0);
	if (nonEmp.length === 0) return ".";
	return normalize(nonEmp.join("/"));
}

export function resolve(...paths: string[]): string {
	let resolved = "";
	let resolvedAbsolute = false;

	for (let i = paths.length - 1; i >= 0 && !resolvedAbsolute; i--) {
		const p = paths[i];
		if (!p || typeof p !== "string") continue;
		resolved = p + (resolved ? "/" + resolved : "");
		resolvedAbsolute = p.startsWith("/");
	}

	if (!resolvedAbsolute) {
		resolved = "/" + resolved;
	}

	let norm = normalize(resolved);
	if (norm.length > 1 && norm.endsWith("/")) {
		norm = norm.slice(0, -1);
	}
	return norm;
}

export function dirname(p: string): string {
	if (typeof p !== "string" || p.length === 0) return ".";
	const isAbs = p.startsWith("/");
	const segments = p.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) return isAbs ? "/" : ".";
	segments.pop();
	if (segments.length === 0) return isAbs ? "/" : ".";
	return (isAbs ? "/" : "") + segments.join("/");
}

export function basename(p: string, ext?: string): string {
	if (typeof p !== "string" || p.length === 0) return "";
	const segments = p.split("/").filter((s) => s.length > 0);
	const base = segments.length > 0 ? segments[segments.length - 1]! : "";
	if (ext && base.endsWith(ext)) {
		return base.slice(0, -ext.length);
	}
	return base;
}

export function extname(p: string): string {
	const base = basename(p);
	const dotIdx = base.lastIndexOf(".");
	if (dotIdx <= 0) return "";
	return base.slice(dotIdx);
}

export function relative(from: string, to: string): string {
	const fromAbs = resolve(from);
	const toAbs = resolve(to);
	if (fromAbs === toAbs) return "";

	const fromSegs = fromAbs.split("/").filter((s) => s.length > 0);
	const toSegs = toAbs.split("/").filter((s) => s.length > 0);

	let common = 0;
	while (common < fromSegs.length && common < toSegs.length && fromSegs[common] === toSegs[common]) {
		common++;
	}

	const up = fromSegs.slice(common).map(() => "..");
	const down = toSegs.slice(common);
	return [...up, ...down].join("/") || ".";
}

export interface ParsedPath {
	root: string;
	dir: string;
	base: string;
	ext: string;
	name: string;
}

export interface FormatInputPathObject {
	root?: string;
	dir?: string;
	base?: string;
	ext?: string;
	name?: string;
}

export function parse(p: string): ParsedPath {
	const isAbs = p.startsWith("/");
	const base = basename(p);
	const ext = extname(base);
	const name = base.slice(0, base.length - ext.length);
	const dir = dirname(p);
	return {
		root: isAbs ? "/" : "",
		dir: dir === "/" && !isAbs ? "" : dir,
		base,
		ext,
		name,
	};
}

export function format(pathObject: FormatInputPathObject): string {
	const dir = pathObject.dir || pathObject.root || "";
	const base = pathObject.base || (pathObject.name || "") + (pathObject.ext || "");
	if (!dir) return base;
	return dir.endsWith("/") ? dir + base : dir + "/" + base;
}

export const posix = {
	sep,
	delimiter,
	isAbsolute,
	normalize,
	join,
	resolve,
	dirname,
	basename,
	extname,
	relative,
	parse,
	format,
	get posix() {
		return posix;
	},
};

export default posix;
