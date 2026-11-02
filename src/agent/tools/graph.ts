import { Type } from "typebox";
import { randomBytes, randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { getGraph, graphSessionIndex, graphSessionPropositions } from "../../core/graph.ts";
import type { ChatStore, GraphStore } from "../../core/ports.ts";
import type { SettingsStore } from "../../core/ports.ts";
import { practiceRecordsFromChat, reviewState, teachSessionSeedRating } from "../../core/review.ts";
import type { GraphRegroup, PracticeHistory, PracticeRecord } from "../../core/contracts.ts";
import { effectiveSessionOf } from "../../core/session-clusters.ts";
import { createPropositionCandidateSearch, propositionCandidateBatch, type CandidateBatch, type CandidateProposition, type CandidateRequest } from "../../core/proposition-candidates.ts";

/**
 * THE PROBER'S GRAPH TOOLS (wave 7, owner-locked 2026-09-23): context
 * injection is dead — zero configuration beyond chat models. The prober
 * reads the learner's persistent knowledge map through two tools instead,
 * replacing the old injected block with on-demand eyes.
 *
 * Names + levels + dating ONLY — no statement text, no session contents
 * (owner ruling: the map's ORGANIZATION is the prober's business, its
 * prose is not). The data comes from Platform's pure core seams
 * (graphSessionIndex / graphSessionPropositions) over the same ports the
 * snapshot reads, so the prober and the learner's graph view can never
 * disagree.
 *
 * Registered on the prober ONLY when the settings gate opens
 * (graphToolsEnabled — the graph master switch AND the agent.graphTools
 * toggle); the composition root decides, the factory just receives the
 * store (absent = the gate is closed, no map tools — tests drive this).
 */

/** What the graph tools close over: the stores the session views read. */
export interface GraphToolContext {
	chatStore: ChatStore;
	graphStore: GraphStore;
	chatId?: string;
	settingsStore?: SettingsStore;
	history?: () => PracticeHistory;
	now?: () => number;
}

const listSessionsInput = Type.Object({});

const listPropositionsInput = Type.Object({
	session: Type.String({
		minLength: 1,
		description: "The session's id exactly as list_sessions reported it (a chat id or a notes source id)",
	}),
});

const searchPropositionsInput = Type.Object({
	query: Type.String({ minLength: 1, description: "Keywords or topic concepts to search for across existing knowledge graph propositions" }),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, default: 10, description: "Maximum candidate propositions to return" })),
});

const regroupPropositionsInput = Type.Object({
	nodeIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "IDs of existing propositions (n_...) to regroup under the current session" }),
	reason: Type.String({ minLength: 1, description: "Why these propositions align better with the current subject than their previous subject" }),
});

export function proberGraphTools(ctx: GraphToolContext): Record<string, AgentTool<any>> {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };
	const history = (): PracticeHistory => {
		const records: PracticeRecord[] = [];
		const teachChatIds = new Set<string>();
		const teachRatings = new Map<string, ReturnType<typeof teachSessionSeedRating>>();
		for (const summary of ctx.chatStore.listChats()) {
			const chat = ctx.chatStore.getChat(summary.id);
			if (!chat) continue;
			if (summary.kind === "practice") records.push(...practiceRecordsFromChat(summary.id, chat.messages));
			else { teachChatIds.add(summary.id); teachRatings.set(summary.id, teachSessionSeedRating(chat.messages)); }
		}
		return { records, teachChatIds, teachRatings };
	};
	return {
		list_sessions: {
			name: "list_sessions",
			label: "list_sessions",
			description:
				"List the sessions of the learner's persistent knowledge graph — every chat or imported-notes file that ever contributed a proposition, most recent first. The map is organized into birth-session clusters (propositions grouped by the session they were first learned in), and session names are those clusters' labels. " +
				"Each line: the session's name, kind (chat/file), how many propositions were born in it, its dates, and its id — use that id with list_propositions. " +
				"Reading this first shows what he has already covered and when, before you probe anything.",
			parameters: listSessionsInput,
			execute: serverExecute("list_sessions", listSessionsInput, async (): Promise<string> => {
				const sessions = graphSessionIndex(deps);
				if (sessions.length === 0) return "The knowledge graph is empty — no session has contributed propositions yet.";
				const lines = sessions.map((s, i) =>
					`${i + 1}. ${s.name} (${s.kind}, ${s.propositions} proposition${s.propositions === 1 ? "" : "s"}, ` +
					`born ${s.createdAt ?? "unknown date"}${s.updatedAt ? `, last active ${s.updatedAt}` : ""}) — id: ${s.id}`,
				);
				return `${sessions.length} session(s) in the knowledge graph, most recent first:\n${lines.join("\n")}`;
			}),
		},
		list_propositions: {
			name: "list_propositions",
			label: "list_propositions",
			description:
				"List the propositions BORN in one knowledge-graph session — what was covered there. " +
				"Names only — no statement text, no session contents (owner ruling 2026-09-23: the map's ORGANIZATION is your business, its prose is not).",
			parameters: listPropositionsInput,
			execute: serverExecute("list_propositions", listPropositionsInput, async ({ session }): Promise<string> => {
				const propositions = graphSessionPropositions(deps, session);
				if (propositions.length === 0) {
					return `No propositions born in session "${session}". Call list_sessions for the current ids.`;
				}
					const now = ctx.now?.() ?? Date.now();
					const nodes = getGraph(deps.graphStore).nodes;
					const state = reviewState(ctx.history?.() ?? history(), nodes, now, ctx.settingsStore?.readSettings()?.agent?.desiredRetention ?? 0.9);
					const lines = propositions.map((p) => {
						const review = state.get(p.nodeId);
						if (!review?.lastReview) return `- ${p.name} · ${review?.stage ?? "practiced"} · never practised${review && review.dueAt <= now ? " · due" : ""}`;
						const days = Math.max(0, Math.floor((now - review.lastReview) / 86_400_000));
						return `- ${p.name} · ${review.stage} · last practised ${days}d ago${review.dueAt <= now ? " · due" : ""}`;
					});
				return `${propositions.length} proposition(s) covered in this session:\n${lines.join("\n")}`;
			}),
		},
		search_propositions: {
			name: "search_propositions",
			label: "search_propositions",
			description:
				"Search existing knowledge-graph propositions from other subjects by keywords or topic concepts. " +
				"Use when learning a new subject to discover relevant propositions that were covered in earlier sessions and may belong here.",
			parameters: searchPropositionsInput,
			execute: serverExecute("search_propositions", searchPropositionsInput, async ({ query, limit }): Promise<string> => {
				const nodes = getGraph(deps.graphStore).nodes;
				if (nodes.length === 0) return "The knowledge graph is empty — no propositions exist yet.";

				const rawRegroups = deps.graphStore.readRegroups();
				const regroupMap = new Map<string, string>();
				for (const r of rawRegroups) regroupMap.set(r.nodeId, r.targetSessionId);

				const search = createPropositionCandidateSearch(nodes);
				const hits = search({ id: "query", name: query, statement: query, aliases: [] });

				const filtered = hits.filter((hit) => !ctx.chatId || effectiveSessionOf(hit.node, regroupMap) !== ctx.chatId);
				const maxCandidates = limit ?? 10;
				const candidates = filtered.slice(0, maxCandidates);

				if (candidates.length === 0) {
					return `No propositions matching "${query}" found in other subjects.`;
				}

				const resolveSubjectLabel = (sessionId: string | null): string => {
					if (!sessionId) return "unlabeled";
					const chat = deps.chatStore.getChat(sessionId);
					if (chat?.title) return chat.title;
					const source = deps.graphStore.readSources().find((s) => s.id === sessionId);
					if (source?.filePath) return source.filePath;
					return sessionId;
				};

				const lines = candidates.map((c, i) => {
					const sessionId = effectiveSessionOf(c.node, regroupMap);
					const subject = resolveSubjectLabel(sessionId);
					return `${i + 1}. [${c.node.id}] "${c.node.name}": ${c.node.statement} (Current subject: "${subject}")`;
				});

				return `Found ${candidates.length} candidate proposition(s) from other subjects:\n${lines.join("\n")}`;
			}),
		},
		regroup_propositions: {
			name: "regroup_propositions",
			label: "regroup_propositions",
			description:
				"Regroup existing knowledge-graph propositions into the current session's subject cluster. " +
				"Preserves original birth provenance while moving the propositions to belong to the active subject.",
			parameters: regroupPropositionsInput,
			execute: serverExecute("regroup_propositions", regroupPropositionsInput, async ({ nodeIds, reason }): Promise<string> => {
				if (!ctx.chatId) return "Cannot regroup propositions: active session ID is missing.";

				const nodes = getGraph(deps.graphStore).nodes;
				const knownNodes = new Map(nodes.map((n) => [n.id, n]));

				const rawRegroups = deps.graphStore.readRegroups();
				const regroupMap = new Map<string, string>();
				for (const r of rawRegroups) regroupMap.set(r.nodeId, r.targetSessionId);

				const uniqueNodeIds = [...new Set(nodeIds)];
				const unknownIds: string[] = [];
				const alreadyCurrent: Array<{ id: string; name: string }> = [];
				const regrouped: Array<{ id: string; name: string }> = [];

				for (const nodeId of uniqueNodeIds) {
					const node = knownNodes.get(nodeId);
					if (!node) {
						unknownIds.push(nodeId);
						continue;
					}
					const currentSession = effectiveSessionOf(node, regroupMap);
					if (currentSession === ctx.chatId) {
						alreadyCurrent.push({ id: node.id, name: node.name });
						continue;
					}
					const record: GraphRegroup = {
						id: "rg_" + randomBytes(6).toString("hex"),
						nodeId: node.id,
						targetSessionId: ctx.chatId,
						reason: reason.trim(),
						regroupedAt: new Date().toISOString(),
					};
					deps.graphStore.appendRegroup(record);
					regroupMap.set(node.id, ctx.chatId);
					regrouped.push({ id: node.id, name: node.name });
				}

				const targetTitle = deps.chatStore.getChat(ctx.chatId)?.title ?? ctx.chatId;
				const parts: string[] = [];

				if (regrouped.length > 0) {
					parts.push(`Regrouped ${regrouped.length} proposition(s) to "${targetTitle}":`);
					for (const r of regrouped) {
						parts.push(`- ${r.name} (${r.id})`);
					}
					parts.push(`Reason: ${reason.trim()}`);
				} else {
					parts.push("No propositions regrouped.");
				}

				if (alreadyCurrent.length > 0) {
					parts.push(`Already in "${targetTitle}": ${alreadyCurrent.map((r) => `${r.name} (${r.id})`).join(", ")}`);
				}

				if (unknownIds.length > 0) {
					parts.push(`Unknown proposition ID(s): ${unknownIds.join(", ")}`);
				}

				return parts.join("\n");
			}),
		},
	};
}

// ─── the auditor's graph tools (2026-09-27 relink) ───────────────────────────

/**
 * THE AUDITOR'S TOOLSET — the extraction auditor explores the graph to
 * place new propositions instead of receiving it injected (owner ruling
 * 2026-09-27: a full-graph dump bloats context as the graph grows; the
 * auditor looks up identity candidates itself). Auditor-specific
 * versions, deliberately different from the prober's:
 *
 *   find_candidates   batched, ranked lexical lookup using the proposed
 *                     findings themselves; five candidates per finding,
 *                     explicit pagination, full statements and matched
 *                     aliases, deduplicated within the returned batch.
 *   list_sessions     the birth-session index, no timestamps.
 *   list_propositions full proposition text (optional exploration fallback).
 *
 * No timestamps anywhere: identity work needs content, not chronology.
 * Read-only, pure core seams, same ports the snapshot reads.
 */

export interface AuditorCandidateBatch {
	matches: Array<{ propositionId: string; candidateIds: string[]; nextCursor: string | null }>;
	candidates: CandidateBatch["candidates"];
}

interface CandidateLookup {
	id: string;
	hints?: readonly string[];
	cursor?: string;
}

/** Prepare the first page in code, and keep all continuations bound to this
 * audit's immutable queries. A new search cannot accidentally inherit an old
 * offset. Tokens are opaque, per-audit and stable when a request is repeated;
 * none of this suppresses previously returned records. */
export function prepareAuditorReview(ctx: GraphToolContext, propositions: readonly CandidateProposition[] = []): {
	initialCandidates: AuditorCandidateBatch;
	tools: Record<string, AgentTool<any>>;
} {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };
	const findInput = Type.Object({
		propositions: Type.Array(Type.Object({
			id: Type.String({ minLength: 1, description: "An id from the proposed findings. Its name, statement and aliases are searched automatically." }),
			hints: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
				description: "Optional alternative words or phrases to add to the search. Plain text, not glob patterns.",
			})),
			cursor: Type.Optional(Type.String({ minLength: 1, description: "Continue a previous query with its nextCursor. Do not supply hints with a cursor; its query is already fixed. Omit cursor to start a new search at its first page." })),
		}, { additionalProperties: false }), { minItems: 1, description: "Look up only findings needing a specific additional search. Include each id once." }),
	}, { additionalProperties: false });
	let search: ReturnType<typeof createPropositionCandidateSearch> | undefined;
	const continuations = new Map<string, CandidateRequest>();
	const tokens = new Map<string, string>();
	function lookup(requests: readonly CandidateLookup[]): AuditorCandidateBatch {
		const queries = requests.map((request): CandidateRequest => {
			if (request.cursor === undefined) return { id: request.id, hints: request.hints ? [...request.hints] : undefined };
			if (request.hints !== undefined) throw new Error("A continuation already fixes its query. Omit hints, or omit cursor to start a new search.");
			const query = continuations.get(request.cursor);
			if (!query || query.id !== request.id) throw new Error("Unknown cursor for this finding and audit. Start a fresh lookup without cursor.");
			return query;
		});
		search ??= createPropositionCandidateSearch(getGraph(deps.graphStore).nodes);
		const batch = propositionCandidateBatch(search, propositions, queries);
		return {
			matches: batch.matches.map((match, index) => {
				let nextCursor: string | null = null;
				if (match.nextOffset !== null) {
					const query = { ...queries[index]!, offset: match.nextOffset };
					const key = JSON.stringify([query.id, query.hints ?? [], query.offset]);
					nextCursor = tokens.get(key) ?? randomUUID();
					tokens.set(key, nextCursor);
					continuations.set(nextCursor, query);
				}
				return { propositionId: match.propositionId, candidateIds: match.candidateIds, nextCursor };
			}),
			candidates: batch.candidates,
		};
	}
	const initialCandidates = lookup([...new Set(propositions.map((proposition) => proposition.id))].map((id) => ({ id })));
	const tools: Record<string, AgentTool<any>> = {
		find_candidates: {
			name: "find_candidates",
			label: "find_candidates",
			description:
				"Find existing proposition candidates for a batch of proposed ids, using their full text and optional hints. " +
				"Ranks word overlap across names, statements and aliases, not exact phrases or glob patterns. " +
				"The first page is already in your input. A new search returns five ranked candidates; nextCursor continues that exact query. " +
				"Each candidate's full statement and relevant matched aliases appear once in candidates; matches lists its ids per finding. " +
				"An unmatched finding can remain new; a continuation is an option, not a requirement to keep searching. " +
				"There is no cross-call suppression: repeating a request returns its full page again.",
			parameters: findInput,
			execute: serverExecute("find_candidates", findInput, async (input) => lookup(input.propositions)),
		},
		list_sessions: {
			name: "list_sessions",
			label: "list_sessions",
			description:
				"List the knowledge graph's birth sessions — every chat or imported-notes file that ever contributed a proposition. " +
				"Each line: name, kind, proposition count, id. Use the id with list_propositions to see what a session covered.",
			parameters: Type.Object({}),
			execute: serverExecute("list_sessions", Type.Object({}), async (): Promise<string> => {
				const sessions = graphSessionIndex(deps);
				if (sessions.length === 0) return "The knowledge graph is empty — no session has contributed propositions yet.";
				const lines = sessions.map((s, i) => `${i + 1}. ${s.name} (${s.kind}, ${s.propositions} proposition${s.propositions === 1 ? "" : "s"}) — id: ${s.id}`);
				return `${sessions.length} session(s):\n${lines.join("\n")}`;
			}),
		},
		list_propositions: {
			name: "list_propositions",
			label: "list_propositions",
			description:
				"List the propositions BORN in one session, with FULL statement text — the content-level view for identity work " +
				"(deciding whether a new proposition is really one of these).",
			parameters: listPropositionsInput,
			execute: serverExecute("list_propositions", listPropositionsInput, async ({ session }): Promise<string> => {
				const propositions = graphSessionPropositions(deps, session);
				if (propositions.length === 0) return `No propositions born in session "${session}". Call list_sessions for the current ids.`;
				const nodes = new Map(getGraph(deps.graphStore).nodes.map((n) => [n.id, n]));
				const lines = propositions.map((p) => {
					const node = nodes.get(p.nodeId);
					return `- ${p.nodeId} :: ${p.name}\n  statement: ${node?.statement ?? "(unknown)"}`;
				});
				return `${propositions.length} proposition(s) born in this session:\n${lines.join("\n")}`;
			}),
		},
	};
	return { initialCandidates, tools };
}
