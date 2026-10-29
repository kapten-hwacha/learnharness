/**
 * Quaderno companion round-trip PDF bridge server implementation.
 * Handles local synchronization directory management, minimal PDF generation,
 * status checks, and companion daemon communication.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	DEFAULT_QUADERNO_BASE_URL,
	DEFAULT_QUADERNO_FOLDER,
	type QuadernoConfig,
	type QuadernoStatus,
	type QuadernoActionRequest,
	type QuadernoActionResult,
} from "../core/contracts/quaderno.ts";
import {
	parseQuadernoDotEnv,
	buildQuadernoDocTitle,
} from "../core/quaderno.ts";

/**
 * Resolves Quaderno configuration by reading ~/.config/quaderno/.env (if present)
 * and merging with environment variables.
 */
export async function resolveQuadernoConfig(opts?: {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	dotEnvText?: string;
}): Promise<QuadernoConfig> {
	const env = opts?.env ?? process.env;
	const homeDir = opts?.homeDir ?? os.homedir();

	let dotEnvParsed: Partial<{
		host: string;
		port: string;
		apiKey: string;
		syncDir: string;
		folder: string;
	}> = {};

	if (opts?.dotEnvText !== undefined) {
		dotEnvParsed = parseQuadernoDotEnv(opts.dotEnvText);
	} else {
		const defaultDotEnvPath = path.join(homeDir, ".config", "quaderno", ".env");
		try {
			const content = await fs.promises.readFile(defaultDotEnvPath, "utf-8");
			dotEnvParsed = parseQuadernoDotEnv(content);
		} catch {
			// file not present or unreadable; proceed with defaults
		}
	}

	const host = env.QUADERNO_SERVER_HOST ?? dotEnvParsed.host ?? "127.0.0.1";
	const port = env.QUADERNO_SERVER_PORT ?? dotEnvParsed.port ?? "5000";
	const baseUrl =
		env.QUADERNO_BASE_URL ??
		(env.QUADERNO_SERVER_HOST || env.QUADERNO_SERVER_PORT || dotEnvParsed.host || dotEnvParsed.port
			? `http://${host}:${port}`
			: DEFAULT_QUADERNO_BASE_URL);

	const apiKey = env.QUADERNO_API_KEY ?? dotEnvParsed.apiKey ?? null;

	const rawSyncDir = env.QUADERNO_SYNC_DIR ?? dotEnvParsed.syncDir ?? path.join(homeDir, "Quaderno");
	const syncDir = rawSyncDir.startsWith("~/")
		? path.join(homeDir, rawSyncDir.slice(2))
		: rawSyncDir === "~"
			? homeDir
			: path.resolve(rawSyncDir);

	const folder = env.QUADERNO_LEARNHARNESS_FOLDER ?? dotEnvParsed.folder ?? DEFAULT_QUADERNO_FOLDER;

	return {
		baseUrl,
		apiKey,
		syncDir,
		folder,
	};
}

/**
 * Helper to sanitize markdown text into safe ASCII for standard PDF rendering.
 */
function sanitizePdfText(str: string): string {
	return str
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/[\u2013\u2014]/g, "-")
		.replace(/\u2026/g, "...")
		.replace(/\u2022/g, "*")
		.replace(/[^\x20-\x7E\t\n\r]/g, " ");
}

/**
 * Helper to escape parens and backslashes in PDF string literals.
 */
function escapePdfString(str: string): string {
	return str.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

interface PdfLineItem {
	text: string;
	font: "F1" | "F2";
	size: number;
	leading: number;
}

/**
 * Word wraps a line of text at approximately maxChars characters.
 */
function wrapPdfLine(text: string, maxChars = 75): string[] {
	if (text.length <= maxChars) return [text];
	const words = text.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (!current) {
			current = word;
		} else if (current.length + 1 + word.length <= maxChars) {
			current += ` ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines;
}

/**
 * Builds a valid, self-contained multi-line / multi-page PDF 1.4 document (%PDF-1.4 ... %%EOF)
 * containing the title and formatted markdown text.
 */
export function buildMinimalPdfBytes(title: string, markdown: string): Uint8Array {
	const sanitizedTitle = sanitizePdfText(title);
	const sanitizedMd = sanitizePdfText(markdown);

	// Convert markdown to formatted lines
	const rawLines = sanitizedMd.split(/\r?\n/);
	const lineItems: PdfLineItem[] = [];

	// Add Document Title at top
	lineItems.push({
		text: sanitizedTitle,
		font: "F2",
		size: 14,
		leading: 18,
	});
	lineItems.push({ text: "", font: "F1", size: 10, leading: 12 });

	for (const raw of rawLines) {
		const trimmed = raw.trim();
		if (!trimmed) {
			lineItems.push({ text: "", font: "F1", size: 10, leading: 10 });
			continue;
		}

		if (trimmed.startsWith("# ")) {
			lineItems.push({
				text: trimmed.slice(2).trim(),
				font: "F2",
				size: 13,
				leading: 17,
			});
		} else if (trimmed.startsWith("## ")) {
			lineItems.push({
				text: trimmed.slice(3).trim(),
				font: "F2",
				size: 11,
				leading: 15,
			});
		} else if (trimmed.startsWith("### ")) {
			lineItems.push({
				text: trimmed.slice(4).trim(),
				font: "F2",
				size: 10,
				leading: 14,
			});
		} else if (trimmed === "---" || trimmed === "***") {
			lineItems.push({
				text: "----------------------------------------------------------------------",
				font: "F1",
				size: 9,
				leading: 12,
			});
		} else {
			const wrapped = wrapPdfLine(trimmed, 78);
			for (const w of wrapped) {
				lineItems.push({
					text: w,
					font: "F1",
					size: 10,
					leading: 14,
				});
			}
		}
	}

	// Paginate: 740pt top down to 50pt bottom -> 690pt usable height per page
	const pageList: PdfLineItem[][] = [];
	let currentPage: PdfLineItem[] = [];
	let currentHeight = 0;

	for (const item of lineItems) {
		if (currentHeight + item.leading > 660 && currentPage.length > 0) {
			pageList.push(currentPage);
			currentPage = [];
			currentHeight = 0;
		}
		currentPage.push(item);
		currentHeight += item.leading;
	}
	if (currentPage.length > 0) {
		pageList.push(currentPage);
	}
	if (pageList.length === 0) {
		pageList.push([{ text: sanitizedTitle, font: "F2", size: 14, leading: 18 }]);
	}

	const pageCount = pageList.length;

	// Build PDF object graph:
	// Obj 1: Catalog
	// Obj 2: Pages
	// Obj 3: Font F1 (Helvetica)
	// Obj 4: Font F2 (Helvetica-Bold)
	// For each page i (0-based):
	//   Obj (5 + i*2): Page
	//   Obj (6 + i*2): Contents
	const totalObjects = 4 + pageCount * 2;

	let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
	const offsets: number[] = new Array(totalObjects + 1).fill(0);

	// Obj 1: Catalog
	offsets[1] = Buffer.byteLength(pdf, "ascii");
	pdf += "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";

	// Obj 2: Pages
	const kids = Array.from({ length: pageCount }, (_, i) => `${5 + i * 2} 0 R`).join(" ");
	offsets[2] = Buffer.byteLength(pdf, "ascii");
	pdf += `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`;

	// Obj 3: Font F1
	offsets[3] = Buffer.byteLength(pdf, "ascii");
	pdf += "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";

	// Obj 4: Font F2
	offsets[4] = Buffer.byteLength(pdf, "ascii");
	pdf += "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n";

	// Page & Content objects
	for (let i = 0; i < pageCount; i++) {
		const pageObjId = 5 + i * 2;
		const contentObjId = 6 + i * 2;
		const items = pageList[i]!;

		// Page object
		offsets[pageObjId] = Buffer.byteLength(pdf, "ascii");
		pdf += `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`;

		// Build content stream
		let stream = "BT\n50 740 Td\n";
		let curFont = "";
		let curSize = 0;
		let curLeading = 0;

		for (const item of items) {
			if (item.font !== curFont || item.size !== curSize || item.leading !== curLeading) {
				stream += `/${item.font} ${item.size} Tf\n${item.leading} TL\n`;
				curFont = item.font;
				curSize = item.size;
				curLeading = item.leading;
			}
			if (item.text.length > 0) {
				stream += `(${escapePdfString(item.text)}) Tj\nT*\n`;
			} else {
				stream += "T*\n";
			}
		}
		stream += "ET\n";

		const streamLen = Buffer.byteLength(stream, "ascii");
		offsets[contentObjId] = Buffer.byteLength(pdf, "ascii");
		pdf += `${contentObjId} 0 obj\n<< /Length ${streamLen} >>\nstream\n${stream}endstream\nendobj\n`;
	}

	// Xref table
	const xrefOffset = Buffer.byteLength(pdf, "ascii");
	pdf += `xref\n0 ${totalObjects + 1}\n`;
	pdf += "0000000000 65535 f \n";
	for (let id = 1; id <= totalObjects; id++) {
		const off = offsets[id]!.toString().padStart(10, "0");
		pdf += `${off} 00000 n \n`;
	}

	// Trailer
	pdf += `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

	return Buffer.from(pdf, "ascii");
}

/**
 * Probes the Quaderno companion daemon status and device connection.
 * Never throws; returns `daemonReachable: false` when offline.
 */
export async function getQuadernoStatus(deps?: {
	fetchImpl?: typeof fetch;
	config?: QuadernoConfig;
}): Promise<QuadernoStatus> {
	const config = deps?.config ?? (await resolveQuadernoConfig());
	const fetchImpl = deps?.fetchImpl ?? fetch;

	try {
		const headers: Record<string, string> = {};
		if (config.apiKey) headers["X-API-Key"] = config.apiKey;

		const res = await fetchImpl(`${config.baseUrl}/api/device/status`, {
			headers,
			signal: AbortSignal.timeout(2000),
		});

		if (!res.ok) {
			return {
				ok: false,
				daemonReachable: true,
				deviceConnected: false,
				syncDir: config.syncDir,
				folder: config.folder,
			};
		}

		const data = (await res.json()) as {
			connected?: boolean;
			deviceConnected?: boolean;
			status?: string;
			activeDocument?: QuadernoStatus["activeDocument"];
			active_document?: QuadernoStatus["activeDocument"];
		};

		const deviceConnected = Boolean(data.connected ?? data.deviceConnected ?? (data.status === "connected"));
		const activeDocument = data.activeDocument ?? data.active_document ?? null;

		return {
			ok: true,
			daemonReachable: true,
			deviceConnected,
			syncDir: config.syncDir,
			folder: config.folder,
			activeDocument,
		};
	} catch {
		return {
			ok: false,
			daemonReachable: false,
			deviceConnected: false,
			syncDir: config.syncDir,
			folder: config.folder,
		};
	}
}

/**
 * Executes a Quaderno round-trip bridge action (`sendProblem`, `exportSheet`, or `pullPdf`).
 */
export async function executeQuadernoAction(
	req: QuadernoActionRequest,
	deps?: { fetchImpl?: typeof fetch; config?: QuadernoConfig },
): Promise<QuadernoActionResult> {
	const config = deps?.config ?? (await resolveQuadernoConfig());
	const fetchImpl = deps?.fetchImpl ?? fetch;

	if (req.action === "sendProblem" || req.action === "exportSheet") {
		const rawStem = req.docTitle?.trim().replace(/\.pdf$/i, "");
		const docTitle =
			rawStem && !rawStem.includes("/") && !rawStem.includes("\\") && !rawStem.includes("..")
				? rawStem
				: buildQuadernoDocTitle({
						title: req.title,
						chatId: req.chatId,
						toolCallId: "toolCallId" in req ? req.toolCallId : undefined,
					});

		const folderDir = path.join(config.syncDir, config.folder);
		await fs.promises.mkdir(folderDir, { recursive: true });

		const localPdfPath = path.join(folderDir, `${docTitle}.pdf`);
		const pdfBytes = buildMinimalPdfBytes(req.title, req.markdown);
		await fs.promises.writeFile(localPdfPath, pdfBytes);

		// Daemon upload attempt
		let daemonOk = false;
		try {
			const form = new FormData();
			const fileBlob = new Blob([req.markdown], { type: "text/markdown" });
			form.append("file", fileBlob, `${docTitle}.md`);
			form.append("title", docTitle);
			form.append("folder", config.folder);

			const headers: Record<string, string> = {};
			if (config.apiKey) headers["X-API-Key"] = config.apiKey;

			const res = await fetchImpl(`${config.baseUrl}/api/documents/open`, {
				method: "POST",
				headers,
				body: form,
			});
			daemonOk = res.ok;
		} catch {
			daemonOk = false;
		}

		if (daemonOk) {
			return {
				ok: true,
				mode: "daemon",
				message: `Sent to Quaderno (${config.folder}/${docTitle}.pdf)`,
				docTitle,
				relativePath: `${config.folder}/${docTitle}.pdf`,
				filePath: localPdfPath,
			};
		}

		return {
			ok: true,
			mode: "filesystem",
			message: `Saved PDF to ${config.folder}/${docTitle}.pdf`,
			docTitle,
			relativePath: `${config.folder}/${docTitle}.pdf`,
			filePath: localPdfPath,
		};
	}

	if (req.action === "pullPdf") {
		// 1. Best-effort POST /api/sync
		let syncSucceeded = false;
		try {
			const headers: Record<string, string> = {};
			if (config.apiKey) headers["X-API-Key"] = config.apiKey;
			const syncRes = await fetchImpl(`${config.baseUrl}/api/sync`, {
				method: "POST",
				headers,
			});
			syncSucceeded = syncRes.ok;
		} catch {
			syncSucceeded = false;
		}

		// 2. Locate target PDF file (strictly contained inside config.syncDir)
		const syncRoot = path.resolve(config.syncDir);
		const isSafePdfUnderSyncRoot = (candidatePath: string): boolean => {
			const resolved = path.resolve(candidatePath);
			return (
				resolved.toLowerCase().endsWith(".pdf") &&
				(resolved === syncRoot || resolved.startsWith(syncRoot + path.sep))
			);
		};

		const folderDir = path.join(config.syncDir, config.folder);
		let resolvedPath: string | null = null;

		// Case A: req.filePath provided
		if (req.filePath) {
			const candidate = path.isAbsolute(req.filePath)
				? req.filePath
				: path.join(config.syncDir, req.filePath);
			if (!isSafePdfUnderSyncRoot(candidate)) {
				return {
					ok: false,
					mode: "filesystem",
					message: "Invalid filePath: must be a .pdf file inside the Quaderno sync directory.",
				};
			}
			try {
				const stat = await fs.promises.stat(candidate);
				if (stat.isFile()) {
					resolvedPath = path.resolve(candidate);
				}
			} catch {
				// candidate not found, fall through
			}
		}

		// Case B: req.docTitle provided
		if (!resolvedPath && req.docTitle) {
			const cleanStem = path.basename(req.docTitle.trim()).replace(/\.pdf$/i, "");
			if (cleanStem && cleanStem !== "." && cleanStem !== "..") {
				const targetName = `${cleanStem}.pdf`;
				const candidate = path.join(folderDir, targetName);
				if (isSafePdfUnderSyncRoot(candidate)) {
					try {
						const stat = await fs.promises.stat(candidate);
						if (stat.isFile()) {
							resolvedPath = path.resolve(candidate);
						}
					} catch {
						// not found yet
					}
				}
			}
		}

		// Case C: Newest PDF in folderDir (or syncDir fallback)
		if (!resolvedPath) {
			const searchDirs = [folderDir, config.syncDir];
			for (const dir of searchDirs) {
				try {
					const entries = await fs.promises.readdir(dir);
					const pdfFiles = entries.filter((e) => e.toLowerCase().endsWith(".pdf"));
					if (pdfFiles.length === 0) continue;

					const stats = await Promise.all(
						pdfFiles.map(async (file) => {
							const full = path.join(dir, file);
							const s = await fs.promises.stat(full);
							return { full, mtimeMs: s.mtimeMs };
						}),
					);

					stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
					if (stats[0]) {
						resolvedPath = stats[0].full;
						break;
					}
				} catch {
					// directory might not exist yet
				}
			}
		}

		if (!resolvedPath) {
			return {
				ok: false,
				mode: "filesystem",
				message: `No PDF found in ${config.folder}/. Send a problem to Quaderno first.`,
			};
		}

		// 3. Read file and encode to canonical base64
		const bytes = await fs.promises.readFile(resolvedPath);
		const base64Data = Buffer.from(bytes).toString("base64");
		const fileName = path.basename(resolvedPath);
		const docTitle = fileName.replace(/\.pdf$/i, "");
		const rel = path.relative(config.syncDir, resolvedPath);

		return {
			ok: true,
			mode: syncSucceeded ? "daemon" : "filesystem",
			message: `Attached ${fileName} from ${config.folder}/`,
			docTitle,
			relativePath: rel.startsWith("..") ? fileName : rel,
			filePath: resolvedPath,
			attachment: {
				name: fileName,
				mimeType: "application/pdf",
				data: base64Data,
			},
		};
	}

	return {
		ok: false,
		mode: "filesystem",
		message: "Unknown Quaderno action requested",
	};
}
