import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { listBundledSkills } from "../bundled-assets.ts";

export interface DiscoveredSkill {
	name: string;
	description: string;
	body: string;
}

function parseSkillFile(dirName: string, raw: string): DiscoveredSkill {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!match) {
		return { name: dirName, description: "", body: raw.trim() };
	}
	const [, yaml, body] = match;
	let name = dirName;
	let description = "";
	const lines = yaml!.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const nameMatch = /^name:\s*(.+)$/.exec(line);
		if (nameMatch) {
			name = nameMatch[1]!.trim().replace(/^['"]|['"]$/g, "");
			continue;
		}
		const descMatch = /^description:\s*(.*)$/.exec(line);
		if (descMatch) {
			let desc = descMatch[1]!.trim();
			while (i + 1 < lines.length && /^[ \t]+/.test(lines[i + 1]!)) {
				i++;
				desc += " " + lines[i]!.trim();
			}
			description = desc.replace(/^['"]|['"]$/g, "");
		}
	}
	return { name, description, body: body!.trim() };
}

function discoverSkills(): DiscoveredSkill[] {
	return listBundledSkills().map((s) => parseSkillFile(s.dirName, s.rawContent));
}

const discoveredSkills: DiscoveredSkill[] = discoverSkills();

export function listSkills(): ReadonlyArray<DiscoveredSkill> {
	return discoveredSkills;
}

export const skillInput = Type.Object({
	name: Type.String({ minLength: 1, description: "Skill name to load (e.g. 'chemistry')." }),
});

export type SkillInput = Static<typeof skillInput>;

function buildSkillDescription(skills: ReadonlyArray<DiscoveredSkill>): string {
	const header =
		"Load domain-specific formatting, notation, and tool guidance on demand when a session or learner question involves one of the listed domains (load once when entering the domain).\n\nAvailable skills:\n";
	const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
	return header + list;
}

const baseExecute = serverExecute("skill", skillInput, async ({ name }) => {
	const normalized = name.trim().toLowerCase();
	const match = discoveredSkills.find((s) => s.name.toLowerCase() === normalized);
	if (!match) {
		throw new Error(
			`Unknown skill "${name}". Available skills: ${discoveredSkills.map((s) => s.name).join(", ")}`,
		);
	}
	return match.body;
});

export const skillTool: AgentTool<typeof skillInput> = {
	name: "skill",
	label: "skill",
	description: buildSkillDescription(discoveredSkills),
	parameters: skillInput,
	execute: async (toolCallId, input, signal) => {
		try {
			return await baseExecute(toolCallId, input, signal);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: message }],
				isError: true,
				details: { error: message },
			};
		}
	},
};
