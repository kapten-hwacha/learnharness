import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listSkills, skillTool } from "../src/agent/tools/skill.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

describe("skill tool and skill discovery", () => {
	it("listSkills() discovers 'chemistry' with non-empty description and body", () => {
		const skills = listSkills();
		assert.ok(skills.length >= 1, "at least one skill discovered");
		const chem = skills.find((s) => s.name === "chemistry");
		assert.ok(chem, "chemistry skill must be discovered");
		assert.ok(chem.description.length > 0, "chemistry description is non-empty");
		assert.ok(chem.body.length > 0, "chemistry body is non-empty");
		assert.ok(chem.body.includes("\\ce{"), "chemistry body contains KaTeX mhchem \\ce{");
		assert.ok(chem.body.includes("\\pu{"), "chemistry body contains KaTeX mhchem \\pu{");
	});

	it("skillTool.description lists 'chemistry'", () => {
		assert.ok(skillTool.description.includes("chemistry"), "tool description mentions chemistry");
		assert.ok(skillTool.description.includes("Available skills:"), "tool description has Available skills section");
	});

	it("skillTool.execute returns chemistry skill markdown for 'chemistry' and case-insensitive 'Chemistry'", async () => {
		for (const name of ["chemistry", "Chemistry", "  CHEMISTRY  "]) {
			const res = await skillTool.execute!("tc", { name });
			assert.equal(res.isError, undefined, "not an error");
			const first = res.content[0];
			assert.ok(first && first.type === "text", "has text content");
			assert.ok(first.text.includes("\\ce{"), "contains \\ce{");
			assert.ok(first.text.includes("\\pu{"), "contains \\pu{");
			assert.ok(first.text.includes("## Chemistry"), "contains Chemistry heading");
		}
	});

	it("skillTool.execute returns an isError: true result listing available skills for an unknown skill name", async () => {
		const res = await skillTool.execute!("tc", { name: "quantum-mechanics" });
		assert.equal(res.isError, true, "isError must be true for unknown skill");
		const first = res.content[0];
		assert.ok(first && first.type === "text", "has text content");
		assert.ok(first.text.includes('Unknown skill "quantum-mechanics"'), "mentions unknown skill name");
		assert.ok(first.text.includes("chemistry"), "lists chemistry among available skills");
	});

	it("composeInstructions does not contain mhchem or \\ce{ in teacher, prober, or practice base prompts", () => {
		for (const role of ["teacher", "prober", "practice"] as const) {
			const prompt = composeInstructions(role);
			assert.ok(!prompt.includes("mhchem"), `${role} base prompt must not contain 'mhchem'`);
			assert.ok(!prompt.includes("\\ce{"), `${role} base prompt must not contain '\\ce{'`);
			assert.ok(!prompt.includes("\\pu{"), `${role} base prompt must not contain '\\pu{'`);
		}
	});
});
