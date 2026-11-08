import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	getBundledPrompt,
	listBundledPromptFiles,
	listBundledPromptFragments,
	listBundledSkills,
	readBundledSystemPrompt,
} from "../src/agent/bundled-assets.ts";
import {
	allSegmentPaths,
	clearPromptOverrideCache,
	effectivePromptSegments,
	promptOverrideCache,
	readPromptOverride,
	replacePromptOverrideCache,
	setPromptOverrideCacheEntry,
} from "../src/agent/prompt-segments.ts";
import { listSkills } from "../src/agent/tools/skill.ts";

describe("Bundled Static Assets", () => {
	it("readBundledSystemPrompt() returns non-empty base system prompt", () => {
		const prompt = readBundledSystemPrompt();
		assert.ok(typeof prompt === "string" && prompt.length > 50);
		assert.ok(prompt.includes("LearnHarness") || prompt.includes("teacher") || prompt.length > 0);
	});

	it("getBundledPrompt() reads system-prompt and fragment paths", () => {
		const sysPrompt = getBundledPrompt("system-prompt.md");
		assert.ok(sysPrompt && sysPrompt.length > 0);

		const teacherMethod = getBundledPrompt("teacher/05-method.md");
		assert.ok(teacherMethod && teacherMethod.length > 0);

		const proberDoctrine = getBundledPrompt("prober/10-probe-doctrine.md");
		assert.ok(proberDoctrine && proberDoctrine.length > 0);

		const sharedVoice = getBundledPrompt("shared/10-voice.md");
		assert.ok(sharedVoice && sharedVoice.length > 0);

		const practiceBase = getBundledPrompt("practice/00-base.md");
		assert.ok(practiceBase && practiceBase.length > 0);

		assert.equal(getBundledPrompt("nonexistent/foo.md"), null);
	});

	it("listBundledPromptFiles() returns sorted markdown fragment filenames", () => {
		const teacherFiles = listBundledPromptFiles("teacher");
		assert.ok(teacherFiles.length >= 5);
		assert.ok(teacherFiles.includes("05-method.md"));
		assert.ok(teacherFiles.includes("10-planning.md"));
		// verify sorted
		const sorted = [...teacherFiles].sort();
		assert.deepEqual(teacherFiles, sorted);

		const proberFiles = listBundledPromptFiles("prober");
		assert.ok(proberFiles.includes("10-probe-doctrine.md"));

		const sharedFiles = listBundledPromptFiles("shared");
		assert.ok(sharedFiles.includes("10-voice.md"));
		assert.ok(sharedFiles.includes("40-formatting.md"));

		const practiceFiles = listBundledPromptFiles("practice");
		assert.ok(practiceFiles.includes("00-base.md"));
	});

	it("listBundledPromptFragments() returns array of { filename, content }", () => {
		const fragments = listBundledPromptFragments("teacher");
		assert.ok(fragments.length >= 5);
		const method = fragments.find((f) => f.filename === "05-method.md");
		assert.ok(method && method.content.length > 0);
	});

	it("listBundledSkills() returns discovered skills with dirName, rawContent, and content", () => {
		const skills = listBundledSkills();
		assert.ok(skills.length >= 1);
		const chem = skills.find((s) => s.dirName === "chemistry");
		assert.ok(chem);
		assert.ok(chem.rawContent.length > 0);
		assert.equal(chem.rawContent, chem.content);
		assert.ok(chem.rawContent.includes("name: chemistry"));
	});

	it("listSkills() integrates with bundled assets", () => {
		const skills = listSkills();
		assert.ok(skills.length >= 1);
		const chem = skills.find((s) => s.name === "chemistry");
		assert.ok(chem);
		assert.ok(chem.description.length > 0);
		assert.ok(chem.body.length > 0);
	});

	it("allSegmentPaths() lists all prompt segments across agents", () => {
		const paths = allSegmentPaths();
		assert.ok(paths.includes("system-prompt.md"));
		assert.ok(paths.includes("teacher/05-method.md"));
		assert.ok(paths.includes("prober/10-probe-doctrine.md"));
		assert.ok(paths.includes("shared/10-voice.md"));
		assert.ok(paths.includes("practice/00-base.md"));
	});

	it("effectivePromptSegments() populates sourceText from bundled assets", () => {
		const segments = effectivePromptSegments("teacher", {});
		assert.ok(segments.length >= 5);
		const base = segments.find((s) => s.path === "system-prompt.md");
		assert.ok(base && base.sourceText.length > 0);
		const method = segments.find((s) => s.path === "teacher/05-method.md");
		assert.ok(method && method.sourceText.length > 0);
	});

	it("promptOverrideCache manages in-memory prompt overrides", () => {
		clearPromptOverrideCache();
		assert.equal(promptOverrideCache.size, 0);

		setPromptOverrideCacheEntry("teacher/05-method.md", "Custom method override");
		assert.equal(readPromptOverride("teacher/05-method.md"), "Custom method override");

		setPromptOverrideCacheEntry("teacher/05-method.md", null);
		// In node mode without on-disk override, setting null results in null
		assert.equal(readPromptOverride("teacher/05-method.md"), null);

		replacePromptOverrideCache({
			"shared/10-voice.md": "Custom voice override",
		});
		assert.equal(readPromptOverride("shared/10-voice.md"), "Custom voice override");
		clearPromptOverrideCache();
	});
});
