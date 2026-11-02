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

// ─── Transcribed chemistry normalization ───────────────────────────────────

const CHEMICAL_ELEMENTS = new Set([
	"Ac", "Ag", "Al", "Am", "Ar", "As", "At", "Au", "B", "Ba", "Be", "Bh", "Bi", "Bk", "Br", "C", "Ca", "Cd", "Ce", "Cf",
	"Cl", "Cm", "Cn", "Co", "Cr", "Cs", "Cu", "Db", "Ds", "Dy", "Er", "Es", "Eu", "F", "Fe", "Fl", "Fm", "Fr", "Ga", "Gd",
	"Ge", "H", "He", "Hf", "Hg", "Ho", "Hs", "I", "In", "Ir", "K", "Kr", "La", "Li", "Lr", "Lu", "Lv", "Mc", "Md", "Mg",
	"Mn", "Mo", "Mt", "N", "Na", "Nb", "Nd", "Ne", "Ni", "No", "Np", "O", "Og", "Os", "P", "Pa", "Pb", "Pd", "Pm", "Po",
	"Pr", "Pt", "Pu", "Ra", "Rb", "Re", "Rf", "Rg", "Rh", "Rn", "Ru", "S", "Sb", "Sc", "Se", "Sg", "Si", "Sm", "Sn", "Sr",
	"Ta", "Tb", "Tc", "Te", "Th", "Ti", "Tl", "Tm", "Ts", "U", "V", "W", "Xe", "Y", "Yb", "Zn", "Zr",
]);

const SUB_MAP: Record<string, string> = {
	"₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
	"₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
	"₊": "+", "₋": "-",
};

const SUP_MAP: Record<string, string> = {
	"⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
	"⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
	"⁺": "+", "⁻": "-",
};

function parseLettersIntoElements(str: string): boolean {
	let i = 0;
	while (i < str.length) {
		if (i + 1 < str.length && CHEMICAL_ELEMENTS.has(str.slice(i, i + 2))) {
			i += 2;
		} else if (CHEMICAL_ELEMENTS.has(str.slice(i, i + 1))) {
			i += 1;
		} else {
			return false;
		}
	}
	return i === str.length && str.length > 0;
}

function unicodeFormulaToMhchem(str: string): string {
	let res = str.replace(/[\u2080-\u2089\u208A\u208B]/g, (m) => SUB_MAP[m] || m);
	res = res.replace(/[\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B]+/g, (m, offset, full) => {
		const ascii = m.split("").map((c) => SUP_MAP[c] || c).join("");
		const hasCaret = offset > 0 && full[offset - 1] === "^";
		if (hasCaret) return ascii;
		if (ascii === "+" || ascii === "-") return ascii;
		return `^${ascii}`;
	});
	return res;
}

function isValidChemicalFormula(token: string): boolean {
	const core = token.replace(/^[1-9]\d*/, "");
	if (!/[\u2080-\u2089\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B]/.test(core)) {
		return false;
	}
	const letters = core.replace(/[\(\)0-9\u2080-\u2089\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B]/g, "");
	return letters.length > 0 && parseLettersIntoElements(letters);
}

function isChemTerm(token: string): boolean {
	const core = token.replace(/^[1-9]\d*/, "");
	const letters = core.replace(/[\(\)0-9\u2080-\u2089\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B]/g, "");
	return letters.length > 0 && parseLettersIntoElements(letters);
}

function normalizeInsideCe(ceContent: string): string {
	let s = ceContent.replace(/[\u2080-\u2089\u208A\u208B]/g, (m) => SUB_MAP[m] || m);
	s = s.replace(/[\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B]+/g, (m, offset, full) => {
		const ascii = m.split("").map((c) => SUP_MAP[c] || c).join("");
		const hasCaret = offset > 0 && full[offset - 1] === "^";
		if (hasCaret) return ascii;
		if (ascii === "+" || ascii === "-") return ascii;
		return `^${ascii}`;
	});
	s = s.replace(/[⇌⇋]/g, "<=>");
	s = s.replace(/[⟶→]/g, "->");
	s = s.replace(/[⟵←]/g, "<-");
	s = s.replace(/[⟷↔]/g, "<->");
	return s;
}

const RX_VERBOSE_RUN = /(?:\\(?:text|mathrm)\{[A-Za-z0-9()]+\}(?:_(?:\{?\d+\}?|\d)|\^(?:\{[0-9+-]+\}|[0-9+-]+))*)+/g;

function convertVerboseRun(full: string): string {
	const rxUnit = /\\(?:text|mathrm)\{([A-Za-z0-9()]+)\}(?:_(?:\{?(\d+)\}?|(\d)))?(?:\^(?:\{?([0-9+-]+)\}?))?/g;
	let match: RegExpExecArray | null;
	let combined = "";
	let lettersOnly = "";

	while ((match = rxUnit.exec(full)) !== null) {
		const text = match[1]!;
		const sub = match[2] || match[3];
		const sup = match[4];

		lettersOnly += text.replace(/[^A-Za-z]/g, "");
		combined += text;
		if (sub) combined += sub;
		if (sup) {
			if (sup === "+" || sup === "-") combined += sup;
			else combined += `^${sup}`;
		}
	}

	if (!parseLettersIntoElements(lettersOnly)) return full;
	return `\\ce{${combined}}`;
}

const RX_UNICODE_FORMULA = /(?<![A-Za-z0-9])([1-9]\d*)?((?:[A-Z][a-z]?|\([A-Za-z0-9()]+\)|[0-9\u2080-\u2089\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B])*[₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+[A-Za-z0-9()\u2080-\u2089\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B]*)(?![A-Za-z0-9\u2080-\u2089\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B])/g;

function normalizeProse(prose: string): string {
	const rxReaction = /((?:(?:[1-9]\d*\s*)?[A-Za-z0-9()\u2080-\u2089\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B]+\s*\+\s*)*(?:[1-9]\d*\s*)?[A-Za-z0-9()\u2080-\u2089\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B]+)\s*(⇌|⇋|⟶|→|->|<=>)\s*((?:(?:[1-9]\d*\s*)?[A-Za-z0-9()\u2080-\u2089\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B]+\s*\+\s*)*(?:[1-9]\d*\s*)?[A-Za-z0-9()\u2080-\u2089\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B]+)/g;

	let text = prose.replace(rxReaction, (full, left: string, arrow: string, right: string) => {
		const leftTerms = left.split("+").map((s) => s.trim());
		const rightTerms = right.split("+").map((s) => s.trim());
		if (!leftTerms.every(isChemTerm) || !rightTerms.every(isChemTerm)) return full;
		const hasUnicode = /[\u2080-\u2089\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B⇌⇋⟶→]/.test(full);
		if (!hasUnicode) return full;
		const arrowMap: Record<string, string> = { "⇌": "<=>", "⇋": "<=>", "⟶": "->", "→": "->", "<=>": "<=>", "->": "->" };
		const normArrow = arrowMap[arrow] || "->";
		const normLeft = leftTerms.map(unicodeFormulaToMhchem).join(" + ");
		const normRight = rightTerms.map(unicodeFormulaToMhchem).join(" + ");
		return `$\\ce{${normLeft} ${normArrow} ${normRight}}$`;
	});

	text = text.replace(RX_UNICODE_FORMULA, (match) => {
		if (isValidChemicalFormula(match)) {
			return `$\\ce{${unicodeFormulaToMhchem(match)}}$`;
		}
		return match;
	});

	text = text.replace(/[⇌⇋]/g, "$\\ce{<=>}$");

	return text;
}

function normalizeMath(math: string): string {
	let inner: string;
	let prefix = "";
	let suffix = "";
	if (math.startsWith("$$") && math.endsWith("$$")) {
		prefix = "$$";
		suffix = "$$";
		inner = math.slice(2, -2);
	} else if (math.startsWith("$") && math.endsWith("$")) {
		prefix = "$";
		suffix = "$";
		inner = math.slice(1, -1);
	} else {
		inner = math;
	}

	// 1. Existing \ce{...}
	inner = inner.replace(/\\ce\{([^}]+)\}/g, (_m, body) => `\\ce{${normalizeInsideCe(body)}}`);

	// 2. Verbose LaTeX runs
	inner = inner.replace(RX_VERBOSE_RUN, convertVerboseRun);

	// 3. Unicode chemical tokens inside math
	inner = inner.replace(RX_UNICODE_FORMULA, (m) => {
		if (isValidChemicalFormula(m)) return `\\ce{${unicodeFormulaToMhchem(m)}}`;
		return m;
	});

	// 4. Unicode harpoon in math
	inner = inner.replace(/[⇌⇋]/g, "\\ce{<=>}");

	return prefix + inner + suffix;
}

/**
 * Normalizes transcribed chemistry formulas, reactions, and charges into standard KaTeX mhchem \ce{...} syntax:
 * - Preserves fenced code blocks and inline code spans untouched.
 * - Inside math spans: normalizes Unicode inside \ce{...}, converts verbose \text{...} runs into \ce{...},
 *   converts Unicode chemical tokens to \ce{...}, and never double-wraps in $.
 * - In plain prose: wraps reaction equations in $\ce{...}$, converts standalone Unicode formulas to $\ce{...}$,
 *   and maps standalone harpoons to $\ce{<=>}$.
 * - Never alters ordinary math variables (e.g. x_1, c_1, v_1).
 */
export function normalizeTranscribedChemistry(text: string): string {
	if (!text) return "";
	const codeRegex = /(```[\s\S]*?```|`[^`\r\n]*`)/g;
	const segments: { isCode: boolean; text: string }[] = [];
	let lastIdx = 0;
	let match: RegExpExecArray | null;
	while ((match = codeRegex.exec(text)) !== null) {
		if (match.index > lastIdx) {
			segments.push({ isCode: false, text: text.slice(lastIdx, match.index) });
		}
		segments.push({ isCode: true, text: match[0] });
		lastIdx = match.index + match[0].length;
	}
	if (lastIdx < text.length) {
		segments.push({ isCode: false, text: text.slice(lastIdx) });
	}

	const out: string[] = [];
	const mathRegex = /(\$\$[\s\S]*?\$\$|\$[^\$\r\n]+\$)/g;

	for (const seg of segments) {
		if (seg.isCode) {
			out.push(seg.text);
			continue;
		}
		let segIdx = 0;
		let mMatch: RegExpExecArray | null;
		while ((mMatch = mathRegex.exec(seg.text)) !== null) {
			if (mMatch.index > segIdx) {
				out.push(normalizeProse(seg.text.slice(segIdx, mMatch.index)));
			}
			out.push(normalizeMath(mMatch[0]));
			segIdx = mMatch.index + mMatch[0].length;
		}
		if (segIdx < seg.text.length) {
			out.push(normalizeProse(seg.text.slice(segIdx)));
		}
	}

	return out.join("");
}

/**
 * Cleans the raw transcription markdown returned by quaderno-companion's /api/documents/transcribe.
 * Strips the top metadata blockquote header (> **Source File**..., > **Model**..., ---)
 * and leaves the actual mathematical derivation / notes content.
 * If there is only a single page, strips the redundant "## Page 1" heading.
 * Normalizes chemical formulas and reactions into KaTeX mhchem syntax.
 */
export function cleanTranscribedMarkdown(content: string): string {
	if (!content || !content.trim()) return "";

	let text = content.trim();

	// Check if document starts with companion header: # ... - Transcribed Notes or > **Source File**
	const hrMatch = text.match(/^(?:#\s+[^\r\n]*\r?\n)?(?:\s*>\s*[^\r\n]*\r?\n)+\s*---\r?\n+/);
	if (hrMatch) {
		text = text.slice(hrMatch[0].length).trim();
	}

	// Count occurrences of "## Page <N>"
	const pageMatches = text.match(/^##\s+Page\s+\d+/gm);
	if (pageMatches && pageMatches.length === 1) {
		// Single page: strip the single "## Page N" heading
		text = text.replace(/^##\s+Page\s+\d+\s*\r?\n+/, "").trim();
	}

	// Trim trailing horizontal rules that companion puts at the end of each page
	text = text.replace(/\n*---\s*$/, "").trim();

	return normalizeTranscribedChemistry(text);
}
