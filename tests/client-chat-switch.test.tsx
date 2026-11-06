import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import React from "react";
import { parseHTML } from "linkedom";
import { resetClientRouterForTest, useRouter } from "../src/client/router.tsx";
import { RouteSwitch } from "../src/client/route-switch.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { studyTracker } from "../components/study-tracker.ts";

describe("RouteSwitch session isolation & handover (Bug 1 & 3)", () => {
	const originalWindow = (globalThis as Record<string, unknown>).window;
	const originalDoc = (globalThis as Record<string, unknown>).document;
	const originalActEnv = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
	const originalCustomEvent = (globalThis as Record<string, unknown>).CustomEvent;
	const originalEvent = (globalThis as Record<string, unknown>).Event;
	const originalFetch = globalThis.fetch;

	let dom: ReturnType<typeof parseHTML>;

	beforeEach(() => {
		dom = parseHTML("<html><body><div id=\"root\"></div></body></html>");
		const win = dom.window as unknown as Record<string, unknown>;
		win.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
		win.getComputedStyle = () => ({
			getPropertyValue: () => "",
		});
		win.location = {
			pathname: "/chat/chat-alpha",
			search: "",
			hash: "",
		};
		(dom.document as unknown as { hasFocus: () => boolean }).hasFocus = () => true;
		(dom.window.Element.prototype as unknown as { getAnimations: () => unknown[] }).getAnimations = () => [];

		(globalThis as Record<string, unknown>).window = dom.window;
		(globalThis as Record<string, unknown>).document = dom.document;
		(globalThis as Record<string, unknown>).CustomEvent = dom.window.CustomEvent;
		(globalThis as Record<string, unknown>).Event = dom.window.Event;
		(globalThis as Record<string, unknown>).ResizeObserver = win.ResizeObserver;
		(globalThis as Record<string, unknown>).getComputedStyle = win.getComputedStyle;
		(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		try {
			studyTracker().dispose();
		} catch {
			// silent
		}
		globalThis.fetch = originalFetch;
		delete (globalThis as Record<string, unknown>).ResizeObserver;
		delete (globalThis as Record<string, unknown>).getComputedStyle;
		(globalThis as Record<string, unknown>).CustomEvent = originalCustomEvent;
		(globalThis as Record<string, unknown>).Event = originalEvent;
		if (originalWindow !== undefined) {
			(globalThis as Record<string, unknown>).window = originalWindow;
		} else {
			delete (globalThis as Record<string, unknown>).window;
		}
		if (originalDoc !== undefined) {
			(globalThis as Record<string, unknown>).document = originalDoc;
		} else {
			delete (globalThis as Record<string, unknown>).document;
		}
		if (originalActEnv !== undefined) {
			(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
		} else {
			delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
		}
	});

	it("does not leak previous chat data when switching sessions via router.push", async () => {
		const { createRoot } = await import("react-dom/client");
		const { act } = await import("react");

		const chatsDb: Record<string, { id: string; title: string; kind?: "teach" | "practice"; messages: unknown[] }> = {
			"chat-alpha": {
				id: "chat-alpha",
				title: "Alpha Teach Session",
				kind: "teach",
				messages: [{ id: "m_alpha_1", role: "user", content: "Teach me alpha" }],
			},
			"chat-beta": {
				id: "chat-beta",
				title: "Beta Practice Session",
				kind: "practice",
				messages: [{ id: "m_beta_1", role: "user", content: "Practice beta" }],
			},
		};

		let betaResolve: ((value: Response) => void) | null = null;
		const betaPromise = new Promise<Response>((resolve) => {
			betaResolve = resolve;
		});

		globalThis.fetch = async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/settings")) {
				return new Response(JSON.stringify({ settings: { models: { strong: "openrouter:model" } } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/chats/chat-alpha")) {
				return new Response(JSON.stringify(chatsDb["chat-alpha"]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/chats/chat-beta")) {
				return betaPromise;
			}
			if (url.includes("/api/study")) {
				return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (url.includes("/api/jobs")) {
				return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("Not found", { status: 404 });
		};

		resetClientRouterForTest("/chat/chat-alpha", "/chat/:id");

		const container = dom.document.getElementById("root")!;
		const root = createRoot(container as unknown as HTMLElement);

		let router!: ReturnType<typeof useRouter>;
		function Harness() {
			router = useRouter();
			const routerValue = {
				push(href: string) { router.push(href); },
				replace(href: string) { router.replace(href); },
				back() { router.back(); },
				forward() { router.forward(); },
				refresh() { router.refresh(); },
				prefetch() {},
			};
			return (
				<AppRouterContext.Provider value={routerValue as never}>
					<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
						<RouteSwitch />
					</ServerEventsProvider>
				</AppRouterContext.Provider>
			);
		}

		await act(async () => {
			root.render(<Harness />);
		});

		// Wait microtasks for alpha to fetch and render
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});

		// Container should render chat-alpha
		assert.ok(container.textContent?.includes("Alpha Teach Session"), "should show chat-alpha title");
		assert.ok(container.textContent?.includes("Teach me alpha"), "should show chat-alpha message");

		// Now navigate to chat-beta
		await act(async () => {
			router.push("/chat/chat-beta");
		});

		// While chat-beta is still loading, it MUST NOT render chat-alpha's messages or title!
		assert.ok(!container.textContent?.includes("Teach me alpha"), "must NOT show chat-alpha message during beta load");
		assert.ok(!container.textContent?.includes("Beta Practice Session"), "must NOT yet show beta before fetch resolves");
		assert.ok(container.textContent?.includes("Loading session..."), "must show Loading session...");

		// Now resolve chat-beta's fetch
		await act(async () => {
			betaResolve!(
				new Response(JSON.stringify(chatsDb["chat-beta"]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await new Promise((r) => setTimeout(r, 20));
		});

		// Once beta loads, it shows beta's title and beta's messages
		assert.ok(container.textContent?.includes("Beta Practice Session"), "should show chat-beta title");
		assert.ok(container.textContent?.includes("Practice beta"), "should show chat-beta message");
		assert.ok(!container.textContent?.includes("Teach me alpha"), "must NOT contain alpha messages");

		await act(async () => {
			root.unmount();
		});
	});

	it("ensures new session creation does not receive previous chat's messages (Bug 1)", async () => {
		const { createRoot } = await import("react-dom/client");
		const { act } = await import("react");

		const chatsDb: Record<string, { id: string; title: string; kind?: "teach" | "practice"; messages: unknown[] }> = {
			"chat-existing": {
				id: "chat-existing",
				title: "Old Session",
				kind: "teach",
				messages: [{ id: "m_old_1", role: "user", content: "Previous session history" }],
			},
			"chat-fresh": {
				id: "chat-fresh",
				title: "Fresh New Session",
				kind: "teach",
				messages: [], // fresh session has empty messages!
			},
		};

		globalThis.fetch = async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/settings")) {
				return new Response(JSON.stringify({ settings: { models: { strong: "openrouter:model" } } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/chats/chat-existing")) {
				return new Response(JSON.stringify(chatsDb["chat-existing"]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/chats/chat-fresh")) {
				return new Response(JSON.stringify(chatsDb["chat-fresh"]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/study")) {
				return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (url.includes("/api/jobs")) {
				return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("Not found", { status: 404 });
		};

		resetClientRouterForTest("/chat/chat-existing", "/chat/:id");

		const container = dom.document.getElementById("root")!;
		const root = createRoot(container as unknown as HTMLElement);

		let router!: ReturnType<typeof useRouter>;
		function Harness() {
			router = useRouter();
			const routerValue = {
				push(href: string) { router.push(href); },
				replace(href: string) { router.replace(href); },
				back() { router.back(); },
				forward() { router.forward(); },
				refresh() { router.refresh(); },
				prefetch() {},
			};
			return (
				<AppRouterContext.Provider value={routerValue as never}>
					<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
						<RouteSwitch />
					</ServerEventsProvider>
				</AppRouterContext.Provider>
			);
		}

		await act(async () => {
			root.render(<Harness />);
		});

		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});

		assert.ok(container.textContent?.includes("Old Session"), "shows old session");

		// Navigate to /chat/new
		await act(async () => {
			router.push("/chat/new");
		});

		// Now simulate redirect to /chat/chat-fresh
		await act(async () => {
			router.push("/chat/chat-fresh");
		});

		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});

		// The fresh session must NOT have old session's messages
		assert.ok(!container.textContent?.includes("Previous session history"), "fresh session must NOT display old session messages");
		assert.ok(container.textContent?.includes("Fresh New Session"), "fresh session shows its own title");

		await act(async () => {
			root.unmount();
		});
	});

	it("ensures practice session next-problem does not get stuck in thinking loop on error or completion (Bug 2)", async () => {
		const { createRoot } = await import("react-dom/client");
		const { act } = await import("react");

		const concludedPracticeMessages = [
			{
				id: "msg_user_1",
				role: "user",
				content: "practice linear algebra",
				timestamp: 1,
			},
			{
				id: "msg_pose_1",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_problem_1",
						name: "problem",
						arguments: { statement: "State the subspace test.", mode: "recall" },
					},
				],
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				id: "msg_ack_1",
				role: "toolResult",
				toolCallId: "call_problem_1",
				toolName: "problem",
				content: [{ type: "text", text: "Problem posed" }],
				details: null,
				isError: false,
				timestamp: 3,
			},
			{
				id: "msg_user_think_1",
				role: "custom",
				customType: "practice-thinking",
				content: "Your thinking: 0 in S, closed under + and scalar mult",
				details: { text: "0 in S, closed under + and scalar mult", problemCallId: "call_problem_1" },
				timestamp: 4,
			},
			{
				id: "msg_conclude_1",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_conclude_1",
						name: "conclude",
						arguments: { outcome: "solved", verdict: "Full credit." },
					},
				],
				stopReason: "toolUse",
				timestamp: 5,
			},
			{
				id: "msg_ack_conclude_1",
				role: "toolResult",
				toolCallId: "call_conclude_1",
				toolName: "conclude",
				content: [{ type: "text", text: "Problem concluded." }],
				details: null,
				isError: false,
				timestamp: 6,
			},
			{
				id: "msg_assistant_wrap_1",
				role: "assistant",
				content: [{ type: "text", text: "Clean solve. Ready for the next one?" }],
				stopReason: "stop",
				timestamp: 7,
			},
		];

		const chatData = {
			id: "chat-practice",
			title: "Linear Algebra Practice",
			kind: "practice" as const,
			messages: concludedPracticeMessages,
		};

		let chatPostCalled = false;
		globalThis.fetch = async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/settings")) {
				return new Response(JSON.stringify({ settings: { models: { strong: "openrouter:model" } } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/chats/chat-practice/stream")) {
				return new Response('data: {"type":"turn-settled"}\n\n[DONE]\n\n', {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			if (url.includes("/api/chats/chat-practice")) {
				return new Response(JSON.stringify(chatData), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "/api/chat" || url.endsWith("/api/chat")) {
				chatPostCalled = true;
				// Simulate model refusing with 503 key missing
				return new Response(JSON.stringify({ error: "API key missing" }), {
					status: 503,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/study")) {
				return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (url.includes("/api/jobs")) {
				return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("Not found", { status: 404 });
		};

		resetClientRouterForTest("/chat/chat-practice", "/chat/:id");

		const container = dom.document.getElementById("root")!;
		const root = createRoot(container as unknown as HTMLElement);

		let router!: ReturnType<typeof useRouter>;
		function Harness() {
			router = useRouter();
			const routerValue = {
				push(href: string) { router.push(href); },
				replace(href: string) { router.replace(href); },
				back() { router.back(); },
				forward() { router.forward(); },
				refresh() { router.refresh(); },
				prefetch() {},
			};
			return (
				<AppRouterContext.Provider value={routerValue as never}>
					<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
						<RouteSwitch />
					</ServerEventsProvider>
				</AppRouterContext.Provider>
			);
		}

		await act(async () => {
			root.render(<Harness />);
		});

		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});

		assert.ok(container.textContent?.includes("Linear Algebra Practice"), "session loaded");

		// Find the next-problem button in the composer
		const nextBtn = container.querySelector('[data-testid="next-problem-button"]');
		assert.ok(nextBtn, "Next problem button must be rendered in pause between problems");

		// Submit the composer form (representing clicking Next problem or pressing Enter)
		const composerForm = container.querySelector('[data-testid="composer"]');
		assert.ok(composerForm, "Composer form must be rendered");

		await act(async () => {
			composerForm.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		assert.equal(chatPostCalled, true, "POST /api/chat must have been called");
		// The error banner appears, and the THINKING… shimmer must NOT be stuck in a loop
		assert.ok(!container.textContent?.includes("THINKING…"), "thinking shimmer must NOT remain stuck");
		assert.ok(container.textContent?.includes("API key missing") || container.textContent?.includes("Something went wrong"), "error must be displayed");

		await act(async () => {
			root.unmount();
		});
	});
});
