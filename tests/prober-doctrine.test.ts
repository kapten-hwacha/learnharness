import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { createProberTools } from "../src/agent/tools.ts";
import type { ChatStore, GraphStore, JobStore } from "../src/core/ports.ts";

const stubJobStore = {
	createJob: (() => ({})) as never,
	getJob: (() => undefined) as never,
	listJobs: (() => []) as never,
	updateJob: (() => {}) as never,
} as unknown as JobStore;

const stubChatStore = {
	listChats: () => [],
	getChat: () => null,
} as unknown as ChatStore;

const stubGraphStore = {
	readNodes: () => [],
	appendNode: () => {},
	readChains: () => [],
	appendChain: () => {},
	readCheckpoints: () => [],
	appendCheckpoint: () => {},
	readCoverage: () => [],
	appendCoverage: () => {},
	readRegroups: () => [],
	appendRegroup: () => {},
	readSources: () => [],
	upsertSource: () => {},
	deleteSources: () => 0,
	appendSourceUsage: () => {},
	readPositions: () => ({}),
	writePositions: () => {},
	rewriteLedgers: () => {},
} as unknown as GraphStore;

describe("prober doctrine prompt instructions", () => {
	it("contains instructions for search_propositions and regroup_propositions in composed prober prompt", () => {
		const proberPrompt = composeInstructions("prober");

		assert.ok(
			proberPrompt.includes("search_propositions"),
			"prober prompt must mention search_propositions tool",
		);
		assert.ok(
			proberPrompt.includes("regroup_propositions"),
			"prober prompt must mention regroup_propositions tool",
		);
		assert.match(
			proberPrompt,
			/search_propositions.*regroup_propositions|regroup_propositions.*search_propositions/s,
			"prober prompt must mention search_propositions and regroup_propositions in context",
		);
		assert.match(
			proberPrompt,
			/other subjects/i,
			"prober prompt must mention looking across other subjects",
		);
		assert.match(
			proberPrompt,
			/regroup/i,
			"prober prompt must mention regrouping propositions",
		);
	});

	it("instructs prober to naturally inform the learner about regrouped concepts in conversational response", () => {
		const proberPrompt = composeInstructions("prober");

		assert.match(
			proberPrompt,
			/(?:mention|inform).*(?:regroup|current subject)|(?:regroup).*(?:mention|inform)/is,
			"prober prompt must instruct prober to mention/inform learner about regrouped concepts",
		);
	});
});

describe("prober tools availability via createProberTools", () => {
	it("exposes search_propositions and regroup_propositions when graphStore is provided", () => {
		const tools = createProberTools({
			chatId: "test_chat",
			chatStore: stubChatStore,
			graphStore: stubGraphStore,
			deliver: () => {},
			jobStore: stubJobStore,
			spawn: () => {},
		});

		assert.ok("search_propositions" in tools, "search_propositions should be present when graphStore is provided");
		assert.ok("regroup_propositions" in tools, "regroup_propositions should be present when graphStore is provided");
		assert.equal(typeof tools.search_propositions?.execute, "function");
		assert.equal(typeof tools.regroup_propositions?.execute, "function");
	});

	it("does not expose search_propositions or regroup_propositions when graphStore is absent", () => {
		const tools = createProberTools({
			chatId: "test_chat",
			chatStore: stubChatStore,
			deliver: () => {},
			jobStore: stubJobStore,
			spawn: () => {},
		});

		assert.equal("search_propositions" in tools, false, "search_propositions should be absent when graphStore is absent");
		assert.equal("regroup_propositions" in tools, false, "regroup_propositions should be absent when graphStore is absent");
	});

	it("respects enabled tool toggles when graphStore is present", () => {
		const toolsWithoutSearch = createProberTools(
			{
				chatId: "test_chat",
				chatStore: stubChatStore,
				graphStore: stubGraphStore,
				deliver: () => {},
				jobStore: stubJobStore,
				spawn: () => {},
			},
			{ search_propositions: false } as Record<string, boolean>,
		);

		assert.equal("search_propositions" in toolsWithoutSearch, false);
		assert.ok("regroup_propositions" in toolsWithoutSearch);

		const toolsWithoutRegroup = createProberTools(
			{
				chatId: "test_chat",
				chatStore: stubChatStore,
				graphStore: stubGraphStore,
				deliver: () => {},
				jobStore: stubJobStore,
				spawn: () => {},
			},
			{ regroup_propositions: false } as Record<string, boolean>,
		);

		assert.ok("search_propositions" in toolsWithoutRegroup);
		assert.equal("regroup_propositions" in toolsWithoutRegroup, false);
	});
});
