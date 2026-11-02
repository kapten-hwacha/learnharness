import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ChainTableBody, ChainTableOverlay } from "../components/chain-table.tsx";
import type { ChainSort } from "../components/chain-table.tsx";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import { ServerEventsProvider } from "../components/server-events.tsx";

function createNode(
	id: string,
	name: string,
	statement: string,
	chatId: string | null,
): GraphNode {
	return {
		id,
		name,
		statement,
		aliases: [],
		state: "new",
		createdAt: "2026-11-02T10:00:00.000Z",
		provenance: chatId === null ? [] : [{ chatId, messageId: `m_${id}` }],
	} as unknown as GraphNode;
}

const NODES: GraphNode[] = [
	createNode("p1", "Matrix Multiplication", "Matrix multiplication statement.", "chat_ml"),
	createNode("c1", "Linear Transformation", "Linear transformation statement.", "chat_ml"),
	createNode("p2", "Vector Space", "Vector space statement.", "chat_la"),
	createNode("c2", "Basis", "Basis statement.", "chat_la"),
];

const CHAINS: GraphChain[] = [
	{
		id: "c1",
		premises: ["p1"],
		conclusion: "c1",
		provenance: [],
		createdAt: "2026-11-02T10:00:00.000Z",
	},
	{
		id: "c2",
		premises: ["p2"],
		conclusion: "c2",
		provenance: [],
		createdAt: "2026-11-02T10:00:00.000Z",
	},
];

const SESSIONS: Record<string, string> = {
	chat_ml: "Machine Learning Foundations",
	chat_la: "Linear Algebra",
};

const BASE = {
	nodes: NODES,
	chains: CHAINS,
	sessions: SESSIONS,
	fileSources: {},
	query: "",
	onQuery: () => {},
	sort: { col: "name", dir: 1 } as ChainSort,
	onSort: () => {},
	selection: new Set<string>(),
	selectedSources: new Set<string>(),
	selectMode: false,
	expandedClusters: new Set<string>(["chat_ml", "chat_la"]),
	expandedChains: new Set<string>(["c1", "c2"]),
	onToggleCluster: () => {},
	onToggleChain: () => {},
	onToggleNodes: () => {},
	onClear: () => {},
	onDelete: () => {},
	onClose: () => {},
};

function renderBody(props: Partial<React.ComponentProps<typeof ChainTableBody>> = {}) {
	return renderToStaticMarkup(React.createElement(ChainTableBody, { ...BASE, ...props }));
}

describe("ChainTableBody — cross-subject regrouping", () => {
	it("without regroups, chain groups under its conclusion's birth session", () => {
		const html = renderBody();
		const dom = parseHTML(html);

		const mlGroup = dom.document.querySelector('[data-testid="cluster-group-chat_ml"]');
		assert.ok(mlGroup, "ML cluster group exists");
		assert.ok(mlGroup.querySelector('[data-testid="chain-row-c1"]'), "chain c1 is in ML cluster");
		assert.ok(!mlGroup.querySelector('[data-testid="chain-row-c2"]'), "chain c2 is not in ML cluster");

		const laGroup = dom.document.querySelector('[data-testid="cluster-group-chat_la"]');
		assert.ok(laGroup, "LA cluster group exists");
		assert.ok(laGroup.querySelector('[data-testid="chain-row-c2"]'), "chain c2 is in LA cluster");
		assert.ok(!laGroup.querySelector('[data-testid="chain-row-c1"]'), "chain c1 is not in LA cluster");
	});

	it("with regroups, regrouped conclusion moves the chain and its nodes to the target cluster", () => {
		const regroups = { c1: "chat_la" };
		const html = renderBody({ regroups });
		const dom = parseHTML(html);

		const laGroup = dom.document.querySelector('[data-testid="cluster-group-chat_la"]');
		assert.ok(laGroup, "LA cluster group exists");
		// Both c1 and c2 should now be in the Linear Algebra cluster
		assert.ok(laGroup.querySelector('[data-testid="chain-row-c1"]'), "regrouped chain c1 is now in LA cluster");
		assert.ok(laGroup.querySelector('[data-testid="chain-row-c2"]'), "chain c2 remains in LA cluster");

		// ML cluster should not have chain c1 anymore
		const mlGroup = dom.document.querySelector('[data-testid="cluster-group-chat_ml"]');
		assert.ok(!mlGroup?.querySelector('[data-testid="chain-row-c1"]'), "chain c1 is no longer in ML cluster");
	});

	it("regrouped cluster includes all chain member node IDs in nodeIds count", () => {
		const regroups = { c1: "chat_la" };
		const html = renderBody({ regroups });
		const dom = parseHTML(html);

		// LA group had 2 nodes (p2, c2). With c1 (p1, c1) regrouped into it, it should have 4 nodes (p1, c1, p2, c2).
		const laGroup = dom.document.querySelector('[data-testid="cluster-group-chat_la"]');
		assert.ok(laGroup);
		const countSpan = laGroup.querySelector(".w-14.text-right");
		assert.equal(countSpan?.textContent?.trim(), "4");
	});

	it("chain stays in birth session if only a premise was regrouped (conclusion-determines-cluster law)", () => {
		// If only premise p1 was regrouped to chat_la, c1's conclusion is still c1 (birth chat_ml).
		const regroups = { p1: "chat_la" };
		const html = renderBody({ regroups });
		const dom = parseHTML(html);

		const mlGroup = dom.document.querySelector('[data-testid="cluster-group-chat_ml"]');
		assert.ok(mlGroup?.querySelector('[data-testid="chain-row-c1"]'), "c1 stays in ML cluster");
	});

	it("ChainTableOverlay forwards regroups to ChainTableBody", () => {
		const overlayHtml = renderToStaticMarkup(
			React.createElement(ServerEventsProvider, {
				children: React.createElement(ChainTableOverlay, {
					open: true,
					nodes: NODES,
					chains: CHAINS,
					sessions: SESSIONS,
					fileSources: {},
					regroups: { c1: "chat_la" },
					onClose: () => {},
				}),
			}),
		);
		const dom = parseHTML(overlayHtml);
		const laGroup = dom.document.querySelector('[data-testid="cluster-group-chat_la"]');
		assert.ok(laGroup, "LA cluster group exists in overlay");
		// Since clusters start collapsed in overlay by default, verify the cluster exists and has 4 nodes
		const countSpan = laGroup.querySelector(".w-14.text-right");
		assert.equal(countSpan?.textContent?.trim(), "4");
	});
});
