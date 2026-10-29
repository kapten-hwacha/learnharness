/**
 * Pure browser-safe helpers for the Quaderno companion and round-trip PDF bridge.
 * No `node:*` imports.
 */

import {
	DEFAULT_QUADERNO_BASE_URL,
	DEFAULT_QUADERNO_FOLDER,
	type QuadernoConfig,
	type QuadernoStatus,
	type QuadernoActionRequest,
	type QuadernoActionResult,
	type QuadernoAttachmentPayload,
} from "./contracts/quaderno.ts";

export {
	DEFAULT_QUADERNO_BASE_URL,
	DEFAULT_QUADERNO_FOLDER,
	type QuadernoConfig,
	type QuadernoStatus,
	type QuadernoActionRequest,
	type QuadernoActionResult,
	type QuadernoAttachmentPayload,
};

/**
 * Parse a ~/.config/quaderno/.env or key=value string for Quaderno daemon settings.
 * Ignores '#' comments, empty lines, and strips optional quotes.
 */
export function parseQuadernoDotEnv(raw: string): Partial<{
	host: string;
	port: string;
	apiKey: string;
	syncDir: string;
	folder: string;
}> {
	const result: Partial<{
		host: string;
		port: string;
		apiKey: string;
		syncDir: string;
		folder: string;
	}> = {};

	const lines = raw.split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let val = trimmed.slice(eqIdx + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		if (key === "QUADERNO_SERVER_HOST") result.host = val;
		else if (key === "QUADERNO_SERVER_PORT") result.port = val;
		else if (key === "QUADERNO_API_KEY") result.apiKey = val;
		else if (key === "QUADERNO_SYNC_DIR") result.syncDir = val;
		else if (key === "QUADERNO_LEARNHARNESS_FOLDER") result.folder = val;
	}

	return result;
}

/**
 * Sanitizes a title into a safe filename slug:
 * lowercases, replaces non-alphanumeric runs with '-', trims leading/trailing '-',
 * slices to max 48 characters, and defaults to "problem" if empty.
 */
export function sanitizeQuadernoSlug(raw: string): string {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/, "");
	return slug.length > 0 ? slug : "problem";
}

/**
 * Produces a deterministic filename stem without extension so sending a problem
 * and later clicking "Attach from Quaderno" resolves the exact same PDF inside `learn-harness/`.
 *
 * If `toolCallId` is provided, takes the last 6 alphanumeric chars of `toolCallId` (lowercased).
 * Else if `chatId` is provided, takes the first 6 alphanumeric chars of `chatId` (lowercased).
 * Else returns the sanitized title slug.
 */
export function buildQuadernoDocTitle(input: {
	title: string;
	chatId?: string;
	toolCallId?: string;
}): string {
	const base = sanitizeQuadernoSlug(input.title);

	if (input.toolCallId) {
		const alnum = input.toolCallId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
		const suffix = alnum.slice(-6);
		if (suffix.length > 0) return `${base}-${suffix}`;
	}

	if (input.chatId) {
		const alnum = input.chatId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
		const suffix = alnum.slice(0, 6);
		if (suffix.length > 0) return `${base}-${suffix}`;
	}

	return base;
}

/**
 * Formats a question for Quaderno export as a clean Markdown document with a derivation area.
 */
export function formatQuestionForQuaderno(
	question: {
		type?: string;
		question: string;
		context?: string;
		options?: readonly { label: string; value?: string }[];
	},
	opts?: { chatId?: string; toolCallId?: string },
): { docTitle: string; title: string; markdown: string } {
	const typeLabel = question.type ? question.type.toUpperCase() : "QUESTION";
	const title = `${typeLabel}: ${question.question.slice(0, 60).trim()}`;
	const docTitle = buildQuadernoDocTitle({
		title: question.question.slice(0, 48),
		chatId: opts?.chatId,
		toolCallId: opts?.toolCallId,
	});

	const lines: string[] = [`# ${title}`, "", question.question];

	if (question.context && question.context.trim()) {
		lines.push("", "## Context", "", question.context.trim());
	}

	if (question.options && question.options.length > 0) {
		lines.push("", "## Options", "");
		question.options.forEach((opt, idx) => {
			const letter = String.fromCharCode(65 + idx);
			lines.push(`- [ ] **${letter})** ${opt.label}`);
		});
	}

	lines.push(
		"",
		"---",
		"",
		"## Solution / Derivation (Write below on Quaderno)",
		"",
	);

	return {
		docTitle,
		title,
		markdown: lines.join("\n"),
	};
}

/**
 * Formats an active practice problem for Quaderno export.
 */
export function formatPracticeProblemForQuaderno(
	problem: { statement: string },
	opts?: { chatId?: string; toolCallId?: string },
): { docTitle: string; title: string; markdown: string } {
	const statement = String(problem.statement ?? "");
	const title = `Practice Problem: ${statement.slice(0, 60).trim()}`;
	const docTitle = buildQuadernoDocTitle({
		title: statement.slice(0, 48),
		chatId: opts?.chatId,
		toolCallId: opts?.toolCallId,
	});

	const markdown = [
		"# Practice Problem",
		"",
		statement.trim(),
		"",
		"---",
		"",
		"## Solution / Derivation (Write below on Quaderno)",
		"",
	].join("\n");

	return {
		docTitle,
		title,
		markdown,
	};
}

/**
 * Builds a cold compression worksheet for offline memory recall and reconstruction on the Quaderno.
 */
export function buildColdCompressionSheet(input: {
	title: string;
	chatId?: string;
	mode?: "teach" | "practice";
	prompts: readonly string[];
	claims?: readonly string[];
}): { docTitle: string; title: string; markdown: string } {
	const title = `${input.title} — Cold Compression Sheet`;
	const docTitle = buildQuadernoDocTitle({
		title: `${input.title}-cold-compression`,
		chatId: input.chatId,
	});

	const lines: string[] = [
		`# ${title}`,
		"",
		"Complete this sheet from memory without looking at notes or derivations.",
	];

	if (input.claims && input.claims.length > 0) {
		lines.push("", "## Target Propositions", "");
		input.claims.forEach((claim, i) => {
			lines.push(`${i + 1}. ${claim}`);
		});
	}

	if (input.prompts && input.prompts.length > 0) {
		lines.push("", "## Problems & Derivations", "");
		input.prompts.forEach((prompt, i) => {
			lines.push(`${i + 1}. ${prompt}`);
		});
	}

	lines.push(
		"",
		"---",
		"",
		"## Cold Reconstruction & Derivation (Write below on Quaderno)",
		"",
	);

	return {
		docTitle,
		title,
		markdown: lines.join("\n"),
	};
}
