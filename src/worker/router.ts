import * as activityAbort from "../../app/api/activity/abort/route.ts";
import * as activity from "../../app/api/activity/route.ts";
import * as chat from "../../app/api/chat/route.ts";
import * as chatsIdArtifactUi from "../../app/api/chats/[id]/artifact-ui/route.ts";
import * as chatsIdClarify from "../../app/api/chats/[id]/clarify/route.ts";
import * as chatsIdDismiss from "../../app/api/chats/[id]/dismiss/route.ts";
import * as chatsIdMarkdown from "../../app/api/chats/[id]/markdown/route.ts";
import * as chatsIdRoute from "../../app/api/chats/[id]/route.ts";
import * as chatsIdSettings from "../../app/api/chats/[id]/settings/route.ts";
import * as chatsIdSteer from "../../app/api/chats/[id]/steer/route.ts";
import * as chatsIdStream from "../../app/api/chats/[id]/stream/route.ts";
import * as chats from "../../app/api/chats/route.ts";
import * as claudeCode from "../../app/api/claude-code/route.ts";
import * as cliproxy from "../../app/api/cliproxy/route.ts";
import * as customProvider from "../../app/api/custom-provider/route.ts";
import * as events from "../../app/api/events/route.ts";
import * as graphCosts from "../../app/api/graph/costs/route.ts";
import * as graphCoverageExtract from "../../app/api/graph/coverage/extract/route.ts";
import * as graphImport from "../../app/api/graph/import/route.ts";
import * as graphNodesId from "../../app/api/graph/nodes/[id]/route.ts";
import * as graphPositions from "../../app/api/graph/positions/route.ts";
import * as graphRenderSettings from "../../app/api/graph/render-settings/route.ts";
import * as graph from "../../app/api/graph/route.ts";
import * as graphSources from "../../app/api/graph/sources/route.ts";
import * as graphStatus from "../../app/api/graph/status/route.ts";
import * as jobs from "../../app/api/jobs/route.ts";
import * as keysId from "../../app/api/keys/[id]/route.ts";
import * as keys from "../../app/api/keys/route.ts";
import * as models from "../../app/api/models/route.ts";
import * as profiler from "../../app/api/profiler/route.ts";
import * as quaderno from "../../app/api/quaderno/route.ts";
import * as review from "../../app/api/review/route.ts";
import * as search from "../../app/api/search/route.ts";
import * as settingsSection from "../../app/api/settings/[section]/route.ts";
import * as settingsPromptsSegment from "../../app/api/settings/prompts/[...segment]/route.ts";
import * as settingsPrompts from "../../app/api/settings/prompts/route.ts";
import * as settings from "../../app/api/settings/route.ts";
import { mintDictationToken } from "../server/stt-token.ts";
import { keyValue } from "../server/keys.ts";
import { getHostBridge } from "./host-bridge.ts";
import * as study from "../../app/api/study/route.ts";
import * as subscriptionsBrowser from "../../app/api/subscriptions/browser/route.ts";
import * as subscriptions from "../../app/api/subscriptions/route.ts";

type RouteHandler = (req: Request, ctx: { params: Promise<Record<string, string | string[]>> }) => Promise<Response> | Response;
type RouteModule = Record<string, unknown>;

interface RouteEntry {
	match: (pathname: string) => Record<string, string | string[]> | null;
	mod: RouteModule;
}

const exact = (target: string) => (p: string) => (p === target ? {} : null);

const routes: RouteEntry[] = [
	// Activity
	{ match: exact("/api/activity/abort"), mod: activityAbort },
	{ match: exact("/api/activity"), mod: activity },

	// Chat & Chats
	{ match: exact("/api/chat"), mod: chat },
	{
		match: (p) => {
			const m = /^\/api\/chats\/([^/]+)\/artifact-ui$/.exec(p);
			return m ? { id: decodeURIComponent(m[1]!) } : null;
		},
		mod: chatsIdArtifactUi,
	},
	{
		match: (p) => {
			const m = /^\/api\/chats\/([^/]+)\/clarify$/.exec(p);
			return m ? { id: decodeURIComponent(m[1]!) } : null;
		},
		mod: chatsIdClarify,
	},
	{
		match: (p) => {
			const m = /^\/api\/chats\/([^/]+)\/dismiss$/.exec(p);
			return m ? { id: decodeURIComponent(m[1]!) } : null;
		},
		mod: chatsIdDismiss,
	},
	{
		match: (p) => {
			const m = /^\/api\/chats\/([^/]+)\/markdown$/.exec(p);
			return m ? { id: decodeURIComponent(m[1]!) } : null;
		},
		mod: chatsIdMarkdown,
	},
	{
		match: (p) => {
			const m = /^\/api\/chats\/([^/]+)\/settings$/.exec(p);
			return m ? { id: decodeURIComponent(m[1]!) } : null;
		},
		mod: chatsIdSettings,
	},
	{
		match: (p) => {
			const m = /^\/api\/chats\/([^/]+)\/steer$/.exec(p);
			return m ? { id: decodeURIComponent(m[1]!) } : null;
		},
		mod: chatsIdSteer,
	},
	{
		match: (p) => {
			const m = /^\/api\/chats\/([^/]+)\/stream$/.exec(p);
			return m ? { id: decodeURIComponent(m[1]!) } : null;
		},
		mod: chatsIdStream,
	},
	{
		match: (p) => {
			const m = /^\/api\/chats\/([^/]+)$/.exec(p);
			return m ? { id: decodeURIComponent(m[1]!) } : null;
		},
		mod: chatsIdRoute,
	},
	{ match: exact("/api/chats"), mod: chats },

	// Claude Code, CLIProxy, Custom Provider
	{ match: exact("/api/claude-code"), mod: claudeCode },
	{ match: exact("/api/cliproxy"), mod: cliproxy },
	{ match: exact("/api/custom-provider"), mod: customProvider },

	// Events (SSE)
	{ match: exact("/api/events"), mod: events },

	// Graph sub-routes
	{ match: exact("/api/graph/costs"), mod: graphCosts },
	{ match: exact("/api/graph/coverage/extract"), mod: graphCoverageExtract },
	{ match: exact("/api/graph/import"), mod: graphImport },
	{
		match: (p) => {
			const m = /^\/api\/graph\/nodes\/([^/]+)$/.exec(p);
			return m ? { id: decodeURIComponent(m[1]!) } : null;
		},
		mod: graphNodesId,
	},
	{ match: exact("/api/graph/positions"), mod: graphPositions },
	{ match: exact("/api/graph/render-settings"), mod: graphRenderSettings },
	{ match: exact("/api/graph/sources"), mod: graphSources },
	{ match: exact("/api/graph/status"), mod: graphStatus },
	{ match: exact("/api/graph"), mod: graph },

	// Jobs, Keys, Models, Profiler, Quaderno, Review, Search
	{ match: exact("/api/jobs"), mod: jobs },
	{
		match: (p) => {
			const m = /^\/api\/keys\/([^/]+)$/.exec(p);
			return m ? { id: decodeURIComponent(m[1]!) } : null;
		},
		mod: keysId,
	},
	{ match: exact("/api/keys"), mod: keys },
	{ match: exact("/api/models"), mod: models },
	{ match: exact("/api/profiler"), mod: profiler },
	{ match: exact("/api/quaderno"), mod: quaderno },
	{ match: exact("/api/review"), mod: review },
	{ match: exact("/api/search"), mod: search },

	// Settings prompts (MUST be before settingsSection)
	{
		match: (p) => {
			const m = /^\/api\/settings\/prompts\/(.+)$/.exec(p);
			if (!m) return null;
			const rawSegments = m[1]!.split("/");
			return { segment: rawSegments.map(decodeURIComponent) };
		},
		mod: settingsPromptsSegment,
	},
	{ match: exact("/api/settings/prompts"), mod: settingsPrompts },
	// Settings sections
	{
		match: (p) => {
			const m = /^\/api\/settings\/([^/]+)$/.exec(p);
			return m ? { section: decodeURIComponent(m[1]!) } : null;
		},
		mod: settingsSection,
	},
	{ match: exact("/api/settings"), mod: settings },

	// STT Token, Study, Subscriptions
	{ match: exact("/api/stt/token"), mod: { GET: () => mintDictationToken(keyValue("DEEPGRAM_API_KEY"), getHostBridge().nativeFetch) } },
	{ match: exact("/api/study"), mod: study },
	{ match: exact("/api/subscriptions/browser"), mod: subscriptionsBrowser },
	{ match: exact("/api/subscriptions"), mod: subscriptions },
];

export async function dispatchWorkerRequest(req: Request): Promise<Response> {
	const url = new URL(req.url, "http://localhost");
	const pathname = url.pathname.replace(/\/+$/, "") || "/";
	const method = req.method.toUpperCase();

	for (const route of routes) {
		const params = route.match(pathname);
		if (params !== null) {
			const handler = route.mod[method] as RouteHandler | undefined;
			if (typeof handler !== "function") {
				return new Response("Method Not Allowed", {
					status: 405,
					headers: { "Content-Type": "text/plain" },
				});
			}
			return await handler(req, { params: Promise.resolve(params) });
		}
	}

	return new Response("Not Found", {
		status: 404,
		headers: { "Content-Type": "text/plain" },
	});
}
