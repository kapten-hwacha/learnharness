/**
 * Bundled static assets for prompts and skills.
 *
 * In Vite builds (browser/worker), assets are inlined at compile time via
 * `import.meta.glob(..., { query: "?raw", import: "default", eager: true })`.
 * In Node test/runtime execution where `import.meta.glob` is unavailable,
 * assets are loaded synchronously from disk relative to `import.meta.dirname`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FRAGMENT_RE } from "../core/prompt-segments.ts";

declare global {
	interface ImportMeta {
		glob<T = unknown>(
			pattern: string,
			options?: { query?: string | Record<string, string | boolean>; import?: string; eager?: boolean },
		): Record<string, T>;
	}
}

export interface BundledSkill {
	dirName: string;
	rawContent: string;
	content: string;
}

function extractRaw(mod: unknown): string {
	if (typeof mod === "string") return mod;
	if (mod && typeof (mod as { default?: unknown }).default === "string") {
		return (mod as { default: string }).default;
	}
	return "";
}

let globSystemPrompt: Record<string, unknown> = {};
let globPrompts: Record<string, unknown> = {};
let globSkills: Record<string, unknown> = {};

try {
	globSystemPrompt = import.meta.glob("./system-prompt.md", {
		query: "?raw",
		eager: true,
	});
	globPrompts = import.meta.glob("./prompts/**/*.md", {
		query: "?raw",
		eager: true,
	});
	globSkills = import.meta.glob("./skills/**/SKILL.md", {
		query: "?raw",
		eager: true,
	});
} catch {
	// In Node (tsx --test), import.meta.glob is not a function; fall back to node:fs
}

const isViteGlobBundled = Object.keys(globPrompts).length > 0;

function getBaseDir(): string {
	if (typeof import.meta.dirname === "string") {
		return import.meta.dirname;
	}
	return path.dirname(fileURLToPath(import.meta.url));
}

let bundledSystemPrompt: string = "";
const bundledPrompts = new Map<string, string>();
const bundledSkillsList: BundledSkill[] = [];

if (isViteGlobBundled) {
	// 1. System prompt
	for (const [key, mod] of Object.entries(globSystemPrompt)) {
		if (key.endsWith("system-prompt.md")) {
			const content = extractRaw(mod);
			bundledSystemPrompt = content;
			bundledPrompts.set("system-prompt.md", content);
		}
	}

	// 2. Prompts
	for (const [key, mod] of Object.entries(globPrompts)) {
		const normalized = key.replace(/^\.\/prompts\//, "").replace(/^\.\//, "");
		bundledPrompts.set(normalized, extractRaw(mod));
	}

	// 3. Skills
	const skillsMap = new Map<string, BundledSkill>();
	for (const [key, mod] of Object.entries(globSkills)) {
		// Key matches ./skills/<dirName>/SKILL.md
		const m = /^\.\/skills\/([^/]+)\/SKILL\.md$/.exec(key);
		if (m && m[1]) {
			const dirName = m[1];
			const content = extractRaw(mod);
			skillsMap.set(dirName, {
				dirName,
				rawContent: content,
				content,
			});
		}
	}
	for (const skill of skillsMap.values()) {
		bundledSkillsList.push(skill);
	}
	bundledSkillsList.sort((a, b) => a.dirName.localeCompare(b.dirName));
} else {
	// Node fallback
	const baseDir = getBaseDir();

	// 1. System prompt
	const sysPromptPath = path.join(baseDir, "system-prompt.md");
	if (fs.existsSync(sysPromptPath)) {
		try {
			bundledSystemPrompt = fs.readFileSync(sysPromptPath, "utf-8");
			bundledPrompts.set("system-prompt.md", bundledSystemPrompt);
		} catch {}
	}

	// 2. Prompts
	const promptsDir = path.join(baseDir, "prompts");
	if (fs.existsSync(promptsDir)) {
		try {
			const subdirs = fs.readdirSync(promptsDir, { withFileTypes: true });
			for (const sub of subdirs) {
				if (sub.isDirectory()) {
					const subPath = path.join(promptsDir, sub.name);
					const files = fs.readdirSync(subPath);
					for (const file of files) {
						if (file.endsWith(".md")) {
							const filePath = path.join(subPath, file);
							const content = fs.readFileSync(filePath, "utf-8");
							bundledPrompts.set(`${sub.name}/${file}`, content);
						}
					}
				} else if (sub.isFile() && sub.name.endsWith(".md")) {
					const filePath = path.join(promptsDir, sub.name);
					const content = fs.readFileSync(filePath, "utf-8");
					bundledPrompts.set(sub.name, content);
				}
			}
		} catch {}
	}

	// 3. Skills
	const skillsDir = path.join(baseDir, "skills");
	if (fs.existsSync(skillsDir)) {
		try {
			const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true });
			for (const dirEntry of skillDirs) {
				if (dirEntry.isDirectory()) {
					const skillFile = path.join(skillsDir, dirEntry.name, "SKILL.md");
					if (fs.existsSync(skillFile)) {
						const rawContent = fs.readFileSync(skillFile, "utf-8");
						bundledSkillsList.push({
							dirName: dirEntry.name,
							rawContent,
							content: rawContent,
						});
					}
				}
			}
			bundledSkillsList.sort((a, b) => a.dirName.localeCompare(b.dirName));
		} catch {}
	}
}

/**
 * Returns the raw content of a bundled prompt segment (or null if not found).
 * E.g.: "system-prompt.md", "teacher/05-method.md", "prober/10-probe-doctrine.md", "shared/10-voice.md", "practice/00-base.md".
 */
export function getBundledPrompt(segmentPath: string): string | null {
	const normalized = segmentPath.replace(/^prompts\//, "").replace(/^\.\//, "");
	return bundledPrompts.get(normalized) ?? null;
}

/**
 * Returns the base system prompt text.
 */
export function readBundledSystemPrompt(): string {
	return bundledSystemPrompt || (getBundledPrompt("system-prompt.md") ?? "");
}

/**
 * Returns sorted fragment filenames inside `src/agent/prompts/<subdir>` matching FRAGMENT_RE.
 * E.g.: listBundledPromptFiles("teacher") -> ["05-method.md", "10-planning.md", ...]
 */
export function listBundledPromptFiles(subdir: string): string[] {
	const prefix = `${subdir}/`;
	const files: string[] = [];
	for (const key of bundledPrompts.keys()) {
		if (key.startsWith(prefix)) {
			const filename = key.slice(prefix.length);
			if (!filename.includes("/") && FRAGMENT_RE.test(filename)) {
				files.push(filename);
			}
		}
	}
	return files.sort();
}

/**
 * Returns array of { filename, content } fragments for the given agent/subdir, sorted by filename.
 */
export function listBundledPromptFragments(
	agent: "prober" | "teacher" | "practice" | "shared",
): Array<{ filename: string; content: string }> {
	const files = listBundledPromptFiles(agent);
	return files.map((filename) => ({
		filename,
		content: getBundledPrompt(`${agent}/${filename}`) ?? "",
	}));
}

/**
 * Returns all discovered skills sorted by dirName.
 */
export function listBundledSkills(): BundledSkill[] {
	return [...bundledSkillsList];
}
