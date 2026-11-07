/**
 * Unit tests for Quaderno Companion round-trip PDF bridge and service.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
	parseQuadernoDotEnv,
	sanitizeQuadernoSlug,
	buildQuadernoDocTitle,
	formatQuestionForQuaderno,
	formatPracticeProblemForQuaderno,
	buildColdCompressionSheet,
	cleanTranscribedMarkdown,
	normalizeTranscribedChemistry,
} from "../src/core/quaderno.ts";
import {
	resolveQuadernoConfig,
	buildMinimalPdfBytes,
	getQuadernoStatus,
	executeQuadernoAction,
	isSafePdfUnderSyncRoot,
} from "../src/server/quaderno.ts";
import { sameOriginAuthorized } from "../src/server/desktop-access.ts";

describe("Quaderno Core Helpers", () => {
	it("parseQuadernoDotEnv parses host, port, apiKey, syncDir, and folder", () => {
		const raw = `
# Quaderno daemon configuration
QUADERNO_SERVER_HOST=192.168.1.100
QUADERNO_SERVER_PORT=5001
QUADERNO_API_KEY="secret-api-key-123"
QUADERNO_SYNC_DIR="~/Documents/QuadernoMirror"
QUADERNO_LEARNHARNESS_FOLDER='custom-harness'
OTHER_VAR=ignored
`;
		const parsed = parseQuadernoDotEnv(raw);
		assert.equal(parsed.host, "192.168.1.100");
		assert.equal(parsed.port, "5001");
		assert.equal(parsed.apiKey, "secret-api-key-123");
		assert.equal(parsed.syncDir, "~/Documents/QuadernoMirror");
		assert.equal(parsed.folder, "custom-harness");
	});

	it("parseQuadernoDotEnv returns empty object for empty or comment-only string", () => {
		assert.deepEqual(parseQuadernoDotEnv(""), {});
		assert.deepEqual(parseQuadernoDotEnv("# just a comment\n# another"), {});
	});

	it("sanitizeQuadernoSlug lowercases, replaces non-alnum with hyphens, and truncates to 48 chars", () => {
		assert.equal(
			sanitizeQuadernoSlug("Linear Algebra: Finding Eigenvalues & Eigenvectors (Part 1)"),
			"linear-algebra-finding-eigenvalues-eigenvectors",
		);
		assert.equal(sanitizeQuadernoSlug("!!!"), "problem");
		assert.equal(sanitizeQuadernoSlug(""), "problem");
	});

	it("buildQuadernoDocTitle uses toolCallId suffix when provided", () => {
		const doc = buildQuadernoDocTitle({
			title: "Newton's Second Law",
			toolCallId: "call_a1b2c3d4e5f6",
		});
		assert.equal(doc, "newton-s-second-law-d4e5f6");
	});

	it("buildQuadernoDocTitle uses chatId prefix when no toolCallId provided", () => {
		const doc = buildQuadernoDocTitle({
			title: "Conservation of Energy",
			chatId: "chat_9876543210",
		});
		assert.equal(doc, "conservation-of-energy-chat98");
	});

	it("buildQuadernoDocTitle falls back to slug when neither toolCallId nor chatId provided", () => {
		const doc = buildQuadernoDocTitle({
			title: "Hamiltonian Mechanics",
		});
		assert.equal(doc, "hamiltonian-mechanics");
	});

	it("formatQuestionForQuaderno creates a clean markdown document with derivation section", () => {
		const res = formatQuestionForQuaderno(
			{
				type: "check",
				question: "What is the determinant of a 2x2 identity matrix?",
				context: "Recall the definition: ad - bc.",
				options: [{ label: "0" }, { label: "1" }],
			},
			{ toolCallId: "call_quiz123456" },
		);

		assert.ok(res.title.startsWith("CHECK:"));
		assert.ok(res.docTitle.includes("determinant"));
		assert.ok(res.markdown.includes("# CHECK:"));
		assert.ok(res.markdown.includes("What is the determinant of a 2x2 identity matrix?"));
		assert.ok(res.markdown.includes("## Context"));
		assert.ok(res.markdown.includes("## Options"));
		assert.ok(res.markdown.includes("- [ ] **A)** 0"));
		assert.ok(res.markdown.includes("- [ ] **B)** 1"));
		assert.ok(res.markdown.includes("## Solution / Derivation (Write below on Quaderno)"));
	});

	it("formatPracticeProblemForQuaderno formats statement cleanly", () => {
		const res = formatPracticeProblemForQuaderno(
			{ statement: "Derive Euler's formula e^(ix) = cos(x) + i*sin(x) using Taylor series." },
			{ toolCallId: "call_prob987654" },
		);

		assert.ok(res.docTitle.includes("derive-euler-s-formula"));
		assert.ok(res.markdown.includes("# Practice Problem"));
		assert.ok(res.markdown.includes("Derive Euler's formula"));
		assert.ok(res.markdown.includes("## Solution / Derivation (Write below on Quaderno)"));
	});

	it("buildColdCompressionSheet formats worksheet with propositions and prompts", () => {
		const sheet = buildColdCompressionSheet({
			title: "Maxwell Equations",
			chatId: "chat_maxwell_01",
			claims: ["Gauss's law for electricity", "Gauss's law for magnetism"],
			prompts: ["Derive the wave equation in vacuum", "State Faraday's law in differential form"],
		});

		assert.ok(sheet.docTitle.includes("maxwell-equations-cold-compression"));
		assert.ok(sheet.markdown.includes("# Maxwell Equations — Cold Compression Sheet"));
		assert.ok(sheet.markdown.includes("## Target Propositions"));
		assert.ok(sheet.markdown.includes("1. Gauss's law for electricity"));
		assert.ok(sheet.markdown.includes("## Problems & Derivations"));
		assert.ok(sheet.markdown.includes("1. Derive the wave equation in vacuum"));
		assert.ok(sheet.markdown.includes("## Cold Reconstruction & Derivation (Write below on Quaderno)"));
	});

	it("cleanTranscribedMarkdown strips companion header and redundant single Page 1 heading", () => {
		const raw = [
			"# Linear Independence - Transcribed Notes",
			"",
			"> **Source File**: `linear-independence.pdf`  ",
			"> **Transcribed**: 2026-11-01 19:30:00  ",
			"> **Model**: `gemini-3.8-flash`  ",
			"> **Pages**: 1 of 1  ",
			"",
			"---",
			"",
			"## Page 1",
			"",
			"Assume $c_1 v_1 + c_2 v_2 = 0$.",
			"Taking inner product with $v_1$:",
			"$$\\langle v_1, c_1 v_1 + c_2 v_2 \\rangle = c_1 \\|v_1\\|^2 = 0 \\implies c_1 = 0$$",
			"",
			"---",
		].join("\n");

		const cleaned = cleanTranscribedMarkdown(raw);
		assert.ok(!cleaned.includes("Transcribed Notes"));
		assert.ok(!cleaned.includes("Source File"));
		assert.ok(!cleaned.includes("Page 1"));
		assert.ok(cleaned.startsWith("Assume $c_1 v_1 + c_2 v_2 = 0$."));
		assert.ok(cleaned.includes("c_1 = 0"));
	});

	it("cleanTranscribedMarkdown retains page headers when multiple pages exist", () => {
		const raw = [
			"# Two Page Solution - Transcribed Notes",
			"> **Source File**: `two-page.pdf`  ",
			"> **Pages**: 1, 2 of 2  ",
			"---",
			"",
			"## Page 1",
			"",
			"Step 1: Compute matrix characteristic polynomial.",
			"",
			"---",
			"",
			"## Page 2",
			"",
			"Step 2: Solve for eigenvalues.",
		].join("\n");

		const cleaned = cleanTranscribedMarkdown(raw);
		assert.ok(cleaned.includes("## Page 1"));
		assert.ok(cleaned.includes("## Page 2"));
		assert.ok(cleaned.includes("Step 1: Compute"));
		assert.ok(cleaned.includes("Step 2: Solve"));
	});

	it("cleanTranscribedMarkdown preserves raw text when no companion header is present", () => {
		const raw = "Simple handwritten solution without header: $x = 42$.";
		assert.equal(cleanTranscribedMarkdown(raw), raw);
		assert.equal(cleanTranscribedMarkdown(""), "");
		assert.equal(cleanTranscribedMarkdown("   \n\t  "), "");
	});

	it("normalizeTranscribedChemistry normalizes standalone Unicode chemical formulas in prose", () => {
		const input = "Mix H₂O with SO₄²⁻ and Ca(OH)₂.";
		const output = normalizeTranscribedChemistry(input);
		assert.equal(output, "Mix $\\ce{H2O}$ with $\\ce{SO4^2-}$ and $\\ce{Ca(OH)2}$.");
	});

	it("normalizeTranscribedChemistry normalizes full Unicode reaction equations in prose", () => {
		assert.equal(
			normalizeTranscribedChemistry("Combustion: 2H₂ + O₂ → 2H₂O"),
			"Combustion: $\\ce{2H2 + O2 -> 2H2O}$",
		);
		assert.equal(
			normalizeTranscribedChemistry("Haber process: N₂ + 3H₂ ⇌ 2NH₃"),
			"Haber process: $\\ce{N2 + 3H2 <=> 2NH3}$",
		);
	});

	it("normalizeTranscribedChemistry converts verbose LaTeX chemical runs inside math spans", () => {
		assert.equal(
			normalizeTranscribedChemistry("$\\text{H}_2\\text{O}$"),
			"$\\ce{H2O}$",
		);
		assert.equal(
			normalizeTranscribedChemistry("$\\mathrm{SO}_4^{2-}$"),
			"$\\ce{SO4^2-}$",
		);
		assert.equal(
			normalizeTranscribedChemistry("$\\mathrm{Fe}^{3+}$ and $\\text{NH}_4^+$ and $\\text{CH}_3\\text{COOH}$"),
			"$\\ce{Fe^3+}$ and $\\ce{NH4+}$ and $\\ce{CH3COOH}$",
		);
	});

	it("normalizeTranscribedChemistry preserves ordinary math variables and code blocks", () => {
		const mathInput = "$c_1 v_1 + c_2 v_2 = 0$";
		assert.equal(normalizeTranscribedChemistry(mathInput), mathInput);

		const inlineCode = "Use `H₂O` in the code.";
		assert.equal(normalizeTranscribedChemistry(inlineCode), inlineCode);

		const fencedCode = "```\nconst formula = \"2H₂ + O₂ → 2H₂O\";\n```";
		assert.equal(normalizeTranscribedChemistry(fencedCode), fencedCode);
	});

	it("cleanTranscribedMarkdown applies chemistry normalization to companion transcription", () => {
		const raw = [
			"# Chemistry Notes - Transcribed Notes",
			"> **Source File**: `chem.pdf`",
			"> **Pages**: 1 of 1",
			"---",
			"",
			"## Page 1",
			"",
			"Dissolve SO₄²⁻ in H₂O to yield 2H₂ + O₂ → 2H₂O.",
		].join("\n");

		const cleaned = cleanTranscribedMarkdown(raw);
		assert.equal(cleaned, "Dissolve $\\ce{SO4^2-}$ in $\\ce{H2O}$ to yield $\\ce{2H2 + O2 -> 2H2O}$.");
	});
});

describe("Quaderno Server Implementation", () => {
	it("buildMinimalPdfBytes produces valid PDF 1.4 bytes containing title and lines", () => {
		const bytes = buildMinimalPdfBytes(
			"Test Problem Title",
			"# Section Header\nHere is a mathematical derivation.\n---\nWrite below.\n",
		);

		assert.ok(bytes instanceof Uint8Array);
		const text = Buffer.from(bytes).toString("ascii");
		assert.ok(text.startsWith("%PDF-1.4\n"));
		assert.ok(text.includes("/Type /Catalog"));
		assert.ok(text.includes("/Type /Pages"));
		assert.ok(text.includes("/BaseFont /Helvetica"));
		assert.ok(text.includes("Test Problem Title"));
		assert.ok(text.includes("Here is a mathematical derivation."));
		assert.ok(text.includes("xref\n"));
		assert.ok(text.includes("trailer\n"));
		assert.ok(text.includes("startxref\n"));
		assert.ok(text.trimEnd().endsWith("%%EOF"));
	});

	it("buildMinimalPdfBytes transliterates Unicode chemistry into readable ASCII in PDF stream", () => {
		const bytes = buildMinimalPdfBytes(
			"Chemical Reactions",
			"Reaction: 2H₂ + O₂ ⇌ 2H₂O, SO₄²⁻",
		);
		const text = Buffer.from(bytes).toString("ascii");
		assert.ok(text.includes("2H2 + O2 <=> 2H2O"));
		assert.ok(text.includes("SO4^2-"));
		assert.ok(!text.includes("2H  + O"));
	});

	it("resolveQuadernoConfig resolves defaults and expands tilde", async () => {
		const home = "/Users/testuser";
		const config = await resolveQuadernoConfig({
			homeDir: home,
			dotEnvText: "",
			env: {} as unknown as NodeJS.ProcessEnv,
		});

		assert.equal(config.baseUrl, "http://127.0.0.1:5000");
		assert.equal(config.folder, "learn-harness");
		assert.equal(config.syncDir, path.join(home, "Quaderno"));
		assert.equal(config.apiKey, null);
	});

	it("resolveQuadernoConfig allows env var overrides", async () => {
		const home = "/Users/testuser";
		const config = await resolveQuadernoConfig({
			homeDir: home,
			dotEnvText: "QUADERNO_SERVER_PORT=5005\nQUADERNO_API_KEY=dot-key",
			env: {
				QUADERNO_SERVER_PORT: "6000",
				QUADERNO_API_KEY: "override-key",
				QUADERNO_SYNC_DIR: "~/CustomQuaderno",
				QUADERNO_LEARNHARNESS_FOLDER: "harness-v2",
			} as unknown as NodeJS.ProcessEnv,
		});

		assert.equal(config.baseUrl, "http://127.0.0.1:6000");
		assert.equal(config.apiKey, "override-key");
		assert.equal(config.syncDir, path.join(home, "CustomQuaderno"));
		assert.equal(config.folder, "harness-v2");
	});

	it("getQuadernoStatus handles offline daemon cleanly without throwing", async () => {
		const status = await getQuadernoStatus({
			fetchImpl: async () => {
				throw new Error("Connection refused");
			},
			config: {
				baseUrl: "http://127.0.0.1:5000",
				apiKey: null,
				syncDir: "/tmp/quaderno",
				folder: "learn-harness",
			},
		});

		assert.equal(status.ok, false);
		assert.equal(status.daemonReachable, false);
		assert.equal(status.deviceConnected, false);
	});

	it("getQuadernoStatus returns deviceConnected when daemon responds 200", async () => {
		const status = await getQuadernoStatus({
			fetchImpl: async (url, init) => {
				const headers = init?.headers as Record<string, string>;
				assert.equal(headers?.["X-API-Key"], "test-key");
				return new Response(
					JSON.stringify({
						connected: true,
						activeDocument: { title: "active-doc.pdf", currentPage: 1, totalPages: 5 },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
			config: {
				baseUrl: "http://127.0.0.1:5000",
				apiKey: "test-key",
				syncDir: "/tmp/quaderno",
				folder: "learn-harness",
			},
		});

		assert.equal(status.ok, true);
		assert.equal(status.daemonReachable, true);
		assert.equal(status.deviceConnected, true);
		assert.equal(status.activeDocument?.title, "active-doc.pdf");
	});

	it("executeQuadernoAction: sendProblem creates valid PDF on disk and sends multipart to daemon", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-quaderno-test-"));
		try {
			let capturedUrl = "";
			let capturedFolder = "";
			let capturedTitle = "";
			let capturedApiKey = "";

			const result = await executeQuadernoAction(
				{
					action: "sendProblem",
					title: "Linear Independence Problem",
					markdown: "# Linear Independence\nShow that v1, v2 are independent.\n",
					toolCallId: "call_linindep123",
				},
				{
					config: {
						baseUrl: "http://127.0.0.1:5000",
						apiKey: "test-secret-key",
						syncDir: tmpDir,
						folder: "learn-harness",
					},
					fetchImpl: async (url, init) => {
						capturedUrl = String(url);
						const headers = init?.headers as Record<string, string>;
						capturedApiKey = headers?.["X-API-Key"] ?? "";
						const form = init?.body as FormData;
						capturedFolder = String(form.get("folder"));
						capturedTitle = String(form.get("title"));
						return new Response(JSON.stringify({ ok: true }), { status: 200 });
					},
				},
			);

			assert.equal(result.ok, true);
			assert.equal(result.mode, "daemon");
			assert.ok(result.docTitle?.includes("linear-independence-problem"));
			assert.equal(capturedUrl, "http://127.0.0.1:5000/api/documents/open");
			assert.equal(capturedApiKey, "test-secret-key");
			assert.equal(capturedFolder, "learn-harness");
			assert.equal(capturedTitle, result.docTitle);

			// Verify PDF written to disk
			const pdfPath = path.join(tmpDir, "learn-harness", `${result.docTitle}.pdf`);
			const stat = await fs.stat(pdfPath);
			assert.ok(stat.isFile());
			assert.ok(stat.size > 100);

			const pdfContent = await fs.readFile(pdfPath, "ascii");
			assert.ok(pdfContent.startsWith("%PDF-1.4"));
			assert.ok(pdfContent.includes("Linear Independence"));
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("executeQuadernoAction: sendProblem falls back to mode filesystem when daemon is offline", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-quaderno-test-"));
		try {
			const result = await executeQuadernoAction(
				{
					action: "sendProblem",
					title: "Offline Physics Problem",
					markdown: "# Physics Problem\nCompute trajectory.\n",
					chatId: "chat_offline123",
				},
				{
					config: {
						baseUrl: "http://127.0.0.1:5000",
						apiKey: null,
						syncDir: tmpDir,
						folder: "learn-harness",
					},
					fetchImpl: async () => {
						throw new Error("Daemon unreachable");
					},
				},
			);

			assert.equal(result.ok, true);
			assert.equal(result.mode, "filesystem");
			assert.ok(result.message.includes("Saved PDF to learn-harness/"));

			const pdfPath = path.join(tmpDir, "learn-harness", `${result.docTitle}.pdf`);
			const stat = await fs.stat(pdfPath);
			assert.ok(stat.isFile());
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("executeQuadernoAction: pullPdf triggers /api/sync and returns target PDF as base64", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-quaderno-test-"));
		try {
			const folderDir = path.join(tmpDir, "learn-harness");
			await fs.mkdir(folderDir, { recursive: true });

			const samplePdfBytes = Buffer.from("%PDF-1.4\nAnnotated Solution Bytes\n%%EOF");
			const targetDocTitle = "eigenvalues-problem-456";
			const targetPdfPath = path.join(folderDir, `${targetDocTitle}.pdf`);
			await fs.writeFile(targetPdfPath, samplePdfBytes);

			let syncCalled = false;
			const result = await executeQuadernoAction(
				{
					action: "pullPdf",
					docTitle: targetDocTitle,
				},
				{
					config: {
						baseUrl: "http://127.0.0.1:5000",
						apiKey: "test-api-key",
						syncDir: tmpDir,
						folder: "learn-harness",
					},
					fetchImpl: async (url) => {
						if (String(url).endsWith("/api/sync")) {
							syncCalled = true;
							return new Response(JSON.stringify({ synced: 1 }), { status: 200 });
						}
						return new Response(null, { status: 404 });
					},
				},
			);

			assert.equal(syncCalled, true);
			assert.equal(result.ok, true);
			assert.equal(result.mode, "daemon");
			assert.equal(result.docTitle, targetDocTitle);
			assert.equal(result.attachment?.name, `${targetDocTitle}.pdf`);
			assert.equal(result.attachment?.mimeType, "application/pdf");
			assert.equal(result.attachment?.data, samplePdfBytes.toString("base64"));
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("executeQuadernoAction: pullPdf returns ok: false if no PDF is found", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-quaderno-test-"));
		try {
			const result = await executeQuadernoAction(
				{
					action: "pullPdf",
				},
				{
					config: {
						baseUrl: "http://127.0.0.1:5000",
						apiKey: null,
						syncDir: tmpDir,
						folder: "learn-harness",
					},
					fetchImpl: async () => new Response(null, { status: 500 }),
				},
			);

			assert.equal(result.ok, false);
			assert.ok(result.message.includes("No PDF found"));
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("executeQuadernoAction: pullPdf rejects path traversal outside syncDir", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-quaderno-test-"));
		try {
			const traversal = await executeQuadernoAction(
				{
					action: "pullPdf",
					filePath: "../../etc/passwd",
				},
				{
					config: {
						baseUrl: "http://127.0.0.1:5000",
						apiKey: null,
						syncDir: tmpDir,
						folder: "learn-harness",
					},
					fetchImpl: async () => new Response(null, { status: 500 }),
				},
			);
			assert.equal(traversal.ok, false);
			assert.match(traversal.message, /Invalid filePath/);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("executeQuadernoAction: pullPdf calls /api/documents/transcribe and returns cleaned transcription", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-quaderno-test-"));
		try {
			const folderDir = path.join(tmpDir, "learn-harness");
			await fs.mkdir(folderDir, { recursive: true });

			const samplePdfBytes = Buffer.from("%PDF-1.4\nAnnotated Solution\n%%EOF");
			const targetDocTitle = "taylor-expansion-101";
			const targetPdfPath = path.join(folderDir, `${targetDocTitle}.pdf`);
			await fs.writeFile(targetPdfPath, samplePdfBytes);

			let syncCalled = false;
			let transcribeCalled = false;
			let capturedDocPath = "";
			let capturedApiKey = "";

			const result = await executeQuadernoAction(
				{
					action: "pullPdf",
					docTitle: targetDocTitle,
				},
				{
					config: {
						baseUrl: "http://127.0.0.1:5000",
						apiKey: "test-auth-key",
						syncDir: tmpDir,
						folder: "learn-harness",
					},
					fetchImpl: async (url, init) => {
						const urlStr = String(url);
						if (urlStr.endsWith("/api/sync")) {
							syncCalled = true;
							return new Response(JSON.stringify({ synced: 1 }), { status: 200 });
						}
						if (urlStr.endsWith("/api/documents/transcribe")) {
							transcribeCalled = true;
							const headers = init?.headers as Record<string, string>;
							capturedApiKey = headers?.["X-API-Key"] ?? "";
							const body = init?.body as FormData;
							capturedDocPath = String(body.get("doc_path"));
							const fakeCompanionOutput = [
								"# Taylor Expansion - Transcribed Notes",
								"> **Source File**: `taylor-expansion-101.pdf`  ",
								"> **Model**: `gemini-3.8-flash`  ",
								"---",
								"",
								"## Page 1",
								"",
								"$f(x) = \\sum_{n=0}^\\infty \\frac{f^{(n)}(a)}{n!} (x-a)^n$",
							].join("\n");
							return new Response(
								JSON.stringify({
									status: "success",
									content: fakeCompanionOutput,
								}),
								{ status: 200, headers: { "Content-Type": "application/json" } },
							);
						}
						return new Response(null, { status: 404 });
					},
				},
			);

			assert.equal(syncCalled, true);
			assert.equal(transcribeCalled, true);
			assert.equal(capturedApiKey, "test-auth-key");
			assert.equal(capturedDocPath, targetPdfPath);
			assert.equal(result.ok, true);
			assert.equal(result.mode, "daemon");
			assert.equal(result.transcription, "$f(x) = \\sum_{n=0}^\\infty \\frac{f^{(n)}(a)}{n!} (x-a)^n$");
			assert.ok(result.message.includes("Attached and transcribed"));
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("executeQuadernoAction: pullPdf skips transcription when transcribe is false", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-quaderno-test-"));
		try {
			const folderDir = path.join(tmpDir, "learn-harness");
			await fs.mkdir(folderDir, { recursive: true });

			const samplePdfBytes = Buffer.from("%PDF-1.4\nNo OCR\n%%EOF");
			const targetDocTitle = "no-ocr-doc";
			const targetPdfPath = path.join(folderDir, `${targetDocTitle}.pdf`);
			await fs.writeFile(targetPdfPath, samplePdfBytes);

			let transcribeCalled = false;

			const result = await executeQuadernoAction(
				{
					action: "pullPdf",
					docTitle: targetDocTitle,
					transcribe: false,
				},
				{
					config: {
						baseUrl: "http://127.0.0.1:5000",
						apiKey: "test-auth-key",
						syncDir: tmpDir,
						folder: "learn-harness",
					},
					fetchImpl: async (url) => {
						const urlStr = String(url);
						if (urlStr.endsWith("/api/sync")) {
							return new Response(JSON.stringify({ synced: 1 }), { status: 200 });
						}
						if (urlStr.endsWith("/api/documents/transcribe")) {
							transcribeCalled = true;
							return new Response(JSON.stringify({ status: "success" }), { status: 200 });
						}
						return new Response(null, { status: 404 });
					},
				},
			);

			assert.equal(transcribeCalled, false);
			assert.equal(result.ok, true);
			assert.equal(result.transcription, undefined);
			assert.equal(result.message, `Attached ${targetDocTitle}.pdf from learn-harness/`);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("rejects symlink inside syncDir pointing outside syncDir in isSafePdfUnderSyncRoot and pullPdf", async () => {
		const syncDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-quaderno-sync-"));
		const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-quaderno-outside-"));
		try {
			const outsidePdf = path.join(outsideDir, "secret.pdf");
			await fs.writeFile(outsidePdf, "%PDF-1.4\nSecret Content\n%%EOF");

			// Create symlink inside syncDir pointing to outsidePdf
			const symlinkPath = path.join(syncDir, "symlink-outside.pdf");
			await fs.symlink(outsidePdf, symlinkPath);

			// isSafePdfUnderSyncRoot directly returns false
			assert.equal(isSafePdfUnderSyncRoot(symlinkPath, syncDir), false);

			// pullPdf with filePath pointing to the symlink is rejected
			const result = await executeQuadernoAction(
				{
					action: "pullPdf",
					filePath: symlinkPath,
				},
				{
					config: {
						baseUrl: "http://127.0.0.1:5000",
						apiKey: null,
						syncDir,
						folder: "learn-harness",
					},
					fetchImpl: async () => new Response(null, { status: 500 }),
				},
			);

			assert.equal(result.ok, false);
			assert.match(result.message, /Invalid filePath/);
		} finally {
			await fs.rm(syncDir, { recursive: true, force: true });
			await fs.rm(outsideDir, { recursive: true, force: true });
		}
	});

	it("resolveQuadernoConfig sanitizes root or home syncDir and metadata/invalid baseUrls", async () => {
		const home = "/Users/testuser";

		// Root fallback
		const configRoot = await resolveQuadernoConfig({
			homeDir: home,
			env: { QUADERNO_SYNC_DIR: "/" } as unknown as NodeJS.ProcessEnv,
		});
		assert.equal(configRoot.syncDir, path.join(home, "Quaderno"));

		// Home dir fallback
		const configHome = await resolveQuadernoConfig({
			homeDir: home,
			env: { QUADERNO_SYNC_DIR: "~" } as unknown as NodeJS.ProcessEnv,
		});
		assert.equal(configHome.syncDir, path.join(home, "Quaderno"));

		// 169.254.169.254 SSRF block
		const configMetadataIp = await resolveQuadernoConfig({
			homeDir: home,
			env: { QUADERNO_BASE_URL: "http://169.254.169.254:5000" } as unknown as NodeJS.ProcessEnv,
		});
		assert.equal(configMetadataIp.baseUrl, "http://127.0.0.1:5000");

		// metadata.google.internal SSRF block
		const configMetadataHost = await resolveQuadernoConfig({
			homeDir: home,
			env: { QUADERNO_BASE_URL: "http://metadata.google.internal:5000" } as unknown as NodeJS.ProcessEnv,
		});
		assert.equal(configMetadataHost.baseUrl, "http://127.0.0.1:5000");

		// non-http protocol block
		const configFtp = await resolveQuadernoConfig({
			homeDir: home,
			env: { QUADERNO_BASE_URL: "ftp://127.0.0.1:5000" } as unknown as NodeJS.ProcessEnv,
		});
		assert.equal(configFtp.baseUrl, "http://127.0.0.1:5000");
	});
});

describe("sameOriginAuthorized Unified CSRF Guard", () => {
	it("rejects cross-site, evil origins, and origin: null, but allows same-origin and requests without origin", () => {
		// Rejects evil origin
		assert.equal(
			sameOriginAuthorized(new Headers({ origin: "https://evil.example", host: "localhost:3000" })),
			false,
		);
		assert.equal(
			sameOriginAuthorized(new Headers({ origin: "https://evil.example" }), "http://localhost:3000/api/endpoint"),
			false,
		);

		// Rejects Sec-Fetch-Site: cross-site and same-site
		assert.equal(
			sameOriginAuthorized(new Headers({ "sec-fetch-site": "cross-site" })),
			false,
		);
		assert.equal(
			sameOriginAuthorized(new Headers({ "sec-fetch-site": "same-site" })),
			false,
		);

		// Rejects sandboxed iframe Origin: null
		assert.equal(
			sameOriginAuthorized(new Headers({ origin: "null", host: "localhost:3000" })),
			false,
		);

		// Rejects mismatched host
		assert.equal(
			sameOriginAuthorized(new Headers({ origin: "http://attacker.com", host: "localhost:3000" })),
			false,
		);

		// Allows matching same-origin with Host header
		assert.equal(
			sameOriginAuthorized(new Headers({ origin: "http://localhost:3000", host: "localhost:3000" })),
			true,
		);

		// Allows matching same-origin with x-forwarded-host
		assert.equal(
			sameOriginAuthorized(new Headers({ origin: "http://learnharness.test", "x-forwarded-host": "learnharness.test" })),
			true,
		);

		// Allows matching same-origin with request URL
		assert.equal(
			sameOriginAuthorized(new Headers({ origin: "http://localhost:3000" }), "http://localhost:3000/api/test"),
			true,
		);

		// Allows requests without Origin or Sec-Fetch-Site (e.g. non-browser API clients, unit tests)
		assert.equal(
			sameOriginAuthorized(new Headers({})),
			true,
		);
		assert.equal(
			sameOriginAuthorized(new Headers({ "content-type": "application/json" })),
			true,
		);

		// Allows Sec-Fetch-Site: same-origin and none
		assert.equal(
			sameOriginAuthorized(new Headers({ "sec-fetch-site": "same-origin" })),
			true,
		);
		assert.equal(
			sameOriginAuthorized(new Headers({ "sec-fetch-site": "none" })),
			true,
		);
	});
});
