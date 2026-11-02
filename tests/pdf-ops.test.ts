/**
 * pdf-ops (sources v0) — the pdfjs text layer against a committed fixture
 * (tests/fixtures/sample-3page.pdf: 3 pages, distinct subjects, "force" on
 * page 2 only). The render path (headless Chrome) is covered by the
 * pdf-reader loop tests via the headlessOverride fake.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parsePageSpec, pdfExtract, pdfInfo, pdfProbe, pdfSearch } from "../src/agent/subagents/pdf-ops.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");

describe("pdf-ops — the pdfjs text layer", () => {
	it("pdfInfo triages every page (count, text lengths, image counts, math density)", async () => {
		const info = await pdfInfo(FIXTURE);
		assert.equal(info.page_count, 3);
		assert.equal(info.pages.length, 3);
		assert.equal(info.pages[0]!.page, 1);
		assert.ok(info.pages.every((p) => p.text_length > 0));
		assert.ok(info.mean_text_length > 0);
		// fixture has no images
		assert.ok(info.pages.every((p) => p.image_count === 0));
	});

	it("pdfExtract heads pages and honors the spec", async () => {
		const two = await pdfExtract(FIXTURE, "1-2");
		assert.match(two, /^--- Page 1 ---/);
		assert.match(two, /--- Page 2 ---/);
		assert.ok(!two.includes("--- Page 3 ---"), "page 3 not requested");
		assert.match(two, /Calculus/);
		const picks = await pdfExtract(FIXTURE, "1,3");
		assert.match(picks, /--- Page 1 ---/);
		assert.ok(!picks.includes("--- Page 2 ---"));
		assert.match(picks, /Chemistry/);
	});

	it("pdfSearch finds hits with page/line + context, literal and regex", async () => {
		const lit = await pdfSearch(FIXTURE, "force", { literal: true });
		assert.equal(lit.hits.length, 1);
		assert.equal(lit.hits[0]!.page, 2);
		assert.match(lit.hits[0]!.context, />>> /);
		// regex with case-insensitivity
		const re = await pdfSearch(FIXTURE, "H2O|water");
		assert.equal(re.hits.length, 1);
		assert.equal(re.hits[0]!.page, 3);
		// no-hit silence
		const none = await pdfSearch(FIXTURE, "zymurgy", { literal: true });
		assert.equal(none.hits.length, 0);
		// invalid regex throws the skill's error shape
		await assert.rejects(() => pdfSearch(FIXTURE, "([unclosed"), /Invalid regex/);
	});

	it("pdfExtract and pdfSearch see lines and separate words, not one glued string per page", async () => {
		const file = path.join(os.tmpdir(), `pdf-ops-lines-${process.pid}.pdf`);
		fs.writeFileSync(file, tinyPdf([{
			runs: [
				{ text: "Week 3 lecture", x: 72, y: 700, size: 20 },
				{ text: "Plants make sugar.", x: 72, y: 660 },
				{ text: "Animals eat plants.", x: 72, y: 600 },
			],
		}]));
		try {
			assert.equal(await pdfExtract(file, "1"), "--- Page 1 ---\n# Week 3 lecture\n\nPlants make sugar.\n\nAnimals eat plants.");
			const { hits } = await pdfSearch(file, "Animals", { literal: true, contextLines: 0 });
			assert.equal(hits.length, 1);
			assert.equal(hits[0]!.context, ">>> Animals eat plants.");
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("search retains repeated numeric margin statements and extraction preserves word breaks", async () => {
		const file = path.join(os.tmpdir(), `pdf-ops-preserved-${process.pid}.pdf`);
		fs.writeFileSync(file, tinyPdf([5, 10].map((dose) => ({ runs: [
			{ text: `Dose ${dose} mg`, x: 72, y: 730 },
			{ text: "A cognitive-", x: 72, y: 600 },
			{ text: "behavioral example", x: 72, y: 588 },
			{ text: "Dose 5 mg", x: 72, y: 500 },
		] }))));
		try {
			const text = await pdfExtract(file, "all");
			assert.match(text, /Dose 10 mg/);
			assert.match(text, /cognitive-\n\nbehavioral example/);
			const { hits } = await pdfSearch(file, "Dose 5 mg", { literal: true, contextLines: 0 });
			assert.deepEqual(hits.map((hit) => hit.page), [1, 1, 2]);
			assert.ok(hits.every((hit) => hit.context === ">>> Dose 5 mg"));
			assert.match(await pdfExtract(file, "1"), /Dose 5 mg/);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("a heterogeneous-font page has identical search lines and selected/full extraction order", async () => {
		const file = path.join(os.tmpdir(), `pdf-ops-selection-${process.pid}.pdf`);
		fs.writeFileSync(file, tinyPdf([
			{ runs: Array.from({ length: 6 }, (_, i) => ({ text: `Ordinary prose line ${i} dominates the document's font statistics.`, x: 72, y: 700 - i * 12 })) },
			{ runs: [
				{ text: "Baseline", x: 72, y: 600, size: 24 },
				{ text: "Caveat", x: 72, y: 560, size: 24 },
				{ text: "Experimental conditions", x: 72, y: 720, size: 44 },
			] },
		]));
		try {
			const selected = await pdfExtract(file, "2");
			const full = await pdfExtract(file, "all");
			assert.equal(selected, `--- Page 2 ---\n${full.split("--- Page 2 ---\n")[1]}`);
			const { hits, pageTexts } = await pdfSearch(file, "Baseline", { literal: true, contextLines: 0 });
			assert.equal(hits.length, 1);
			assert.equal(hits[0]!.page, 2);
			assert.equal(hits[0]!.line, 3);
			assert.equal(selected.split("\n").slice(1)[hits[0]!.line - 1], "Baseline");
			assert.equal(selected, `--- Page 2 ---\n${pageTexts.get(2)}`);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("pdfProbe accepts the fixture and rejects garbage", async () => {
		await pdfProbe(FIXTURE); // resolves
		const garbage = path.join(import.meta.dirname, "fixtures", "not-a-pdf.txt");
		await assert.rejects(() => pdfProbe(garbage));
	});

	it("parsePageSpec: all / ranges / lists / clamping", () => {
		assert.deepEqual(parsePageSpec("all", 3), [1, 2, 3]);
		assert.deepEqual(parsePageSpec("1-5", 3), [1, 2, 3]);
		assert.deepEqual(parsePageSpec("1,3,7", 3), [1, 3]);
		assert.deepEqual(parsePageSpec("3", 3), [3]);
		assert.deepEqual(parsePageSpec(" 2 , 1 ", 3), [1, 2]);
	});

	it("pdfInfo detects positive math density for Unicode chemical formulas and equilibrium arrows", async () => {
		const toUnicode = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Tiny def /CMapType 2 def
1 begincodespacerange <00> <FF> endcodespacerange
5 beginbfchar
<71> <2082>
<72> <21CC>
<73> <2084>
<74> <00B2>
<75> <207B>
endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end`;

		// "2Hq + Oq r 2HqO, SOstu" maps via ToUnicode to "2H₂ + O₂ ⇌ 2H₂O, SO₄²⁻"
		const textStr = "2Hq + Oq r 2HqO, SOstu";
		const content = `BT /F1 12 Tf 50 700 Td (${textStr}) Tj ET`;
		const streamLen = content.length;
		const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 5 0 R >> endobj
5 0 obj << /Length ${toUnicode.length} >> stream
${toUnicode}
endstream endobj
6 0 obj << /Length ${streamLen} >> stream
${content}
endstream endobj
xref
0 7
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000330 00000 n 
0000000550 00000 n 
trailer << /Size 7 /Root 1 0 R >>
startxref
700
%%EOF`;

		const tmpFile = path.join(os.tmpdir(), `pdf-ops-chem-${process.pid}.pdf`);
		fs.writeFileSync(tmpFile, Buffer.from(pdf));
		try {
			const info = await pdfInfo(tmpFile);
			assert.equal(info.page_count, 1);
			assert.ok(info.pages[0]!.math_density > 0, `expected math_density > 0, got ${info.pages[0]!.math_density}`);
		} finally {
			fs.rmSync(tmpFile, { force: true });
		}
	});
});