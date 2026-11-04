import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import Link, {
	notFound,
	redirect,
	resetClientRouterForTest,
	useParams,
	usePathname,
	useRouter,
	useSearchParams,
} from "../src/client/router.tsx";

describe("src/client/router.tsx (next/navigation + next/link compatibility)", () => {
	it("resolves pathname, searchParams, and route params from current location and updates on router.push / replace", () => {
		resetClientRouterForTest("/chat/abc-123?prompt=hello", "/chat/:id");
		let pathname = "";
		let prompt: string | null = null;
		let params: Record<string, string> = {};
		let router!: ReturnType<typeof useRouter>;

		function Probe() {
			pathname = usePathname();
			prompt = useSearchParams().get("prompt");
			params = useParams();
			router = useRouter();
			return <Link href="/chat/new?mode=practice">New Practice</Link>;
		}

		const html = renderToStaticMarkup(<Probe />);
		assert.equal(pathname, "/chat/abc-123");
		assert.equal(prompt, "hello");
		assert.deepEqual(params, { id: "abc-123" });
		assert.match(html, /href="\/chat\/new\?mode=practice"/);

		router.push("/?settings=general");
		renderToStaticMarkup(<Probe />);
		assert.equal(pathname, "/");
		assert.equal(prompt, null);
	});

	it("supports replace, back, forward, refresh, and prefetch on RouterInstance", () => {
		resetClientRouterForTest("/chat/first");
		let pathname = "";
		let router!: ReturnType<typeof useRouter>;

		function Probe() {
			pathname = usePathname();
			router = useRouter();
			return null;
		}

		renderToStaticMarkup(<Probe />);
		assert.equal(pathname, "/chat/first");

		router.replace("/chat/second");
		renderToStaticMarkup(<Probe />);
		assert.equal(pathname, "/chat/second");

		// router methods execute without throwing
		router.back();
		router.forward();
		router.refresh();
		router.prefetch("/chat/prefetch-target");
	});

	it("throws expected errors on redirect() and notFound()", () => {
		assert.throws(
			() => redirect("/target-path"),
			(err: unknown) => {
				return err instanceof Error && err.message.includes("/target-path");
			},
		);

		assert.throws(
			() => notFound(),
			(err: unknown) => {
				return err instanceof Error && err.message.includes("NEXT_NOT_FOUND");
			},
		);
	});

	it("extracts route params from dynamic patterns including [param] and default routes", () => {
		resetClientRouterForTest("/chat/session-789", "/chat/[id]");
		let params: Record<string, string> = {};

		function Probe() {
			params = useParams();
			return null;
		}

		renderToStaticMarkup(<Probe />);
		assert.deepEqual(params, { id: "session-789" });

		// Reset without pattern falls back to default known routes (/chat/:id)
		resetClientRouterForTest("/chat/fallback-456");
		renderToStaticMarkup(<Probe />);
		assert.deepEqual(params, { id: "fallback-456" });

		// Non-matching path returns empty object
		resetClientRouterForTest("/chat/new");
		renderToStaticMarkup(<Probe />);
		assert.deepEqual(params, {});
	});

	it("handles Link click events, modifier keys, target, replace, and preventDefault", () => {
		resetClientRouterForTest("/chat/start");
		let currentPathname = "";
		let clicked = false;

		function Probe() {
			currentPathname = usePathname();
			return null;
		}

		renderToStaticMarkup(<Probe />);
		assert.equal(currentPathname, "/chat/start");

		// Plain left click triggers push navigation
		const linkElement = Link({ href: "/chat/plain-click" });
		let prevented = false;
		let plainDefaultPrevented = false;
		const plainEvent = {
			button: 0,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			get defaultPrevented() {
				return plainDefaultPrevented;
			},
			preventDefault() {
				prevented = true;
				plainDefaultPrevented = true;
			},
		} as unknown as React.MouseEvent<HTMLAnchorElement>;

		linkElement.props.onClick(plainEvent);
		assert.equal(prevented, true);
		renderToStaticMarkup(<Probe />);
		assert.equal(currentPathname, "/chat/plain-click");

		// Replace click triggers replace navigation
		const replaceElement = Link({ href: "/chat/replace-click", replace: true });
		let replacePrevented = false;
		let replaceDefaultPrevented = false;
		const replaceEvent = {
			button: 0,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			get defaultPrevented() {
				return replaceDefaultPrevented;
			},
			preventDefault() {
				replacePrevented = true;
				replaceDefaultPrevented = true;
			},
		} as unknown as React.MouseEvent<HTMLAnchorElement>;

		replaceElement.props.onClick(replaceEvent);
		assert.equal(replacePrevented, true);
		renderToStaticMarkup(<Probe />);
		assert.equal(currentPathname, "/chat/replace-click");

		// Modified click (Cmd/Meta) must NOT prevent default or navigate
		const metaEvent = {
			button: 0,
			metaKey: true,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			defaultPrevented: false,
			preventDefault() {
				assert.fail("Modified click should not preventDefault");
			},
		} as unknown as React.MouseEvent<HTMLAnchorElement>;

		linkElement.props.onClick(metaEvent);
		assert.equal(currentPathname, "/chat/replace-click");

		// Secondary click (button 1) must NOT prevent default or navigate
		const middleClickEvent = {
			button: 1,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			defaultPrevented: false,
			preventDefault() {
				assert.fail("Middle click should not preventDefault");
			},
		} as unknown as React.MouseEvent<HTMLAnchorElement>;

		linkElement.props.onClick(middleClickEvent);
		assert.equal(currentPathname, "/chat/replace-click");

		// Target="_blank" must NOT prevent default or navigate
		const targetBlankElement = Link({ href: "/external", target: "_blank" });
		const targetBlankEvent = {
			button: 0,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			defaultPrevented: false,
			preventDefault() {
				assert.fail("Target link should not preventDefault");
			},
		} as unknown as React.MouseEvent<HTMLAnchorElement>;

		targetBlankElement.props.onClick(targetBlankEvent);
		assert.equal(currentPathname, "/chat/replace-click");

		// User onClick can prevent default and stop router navigation
		const preventedElement = Link({
			href: "/should-not-reach",
			onClick: (e) => {
				clicked = true;
				e.preventDefault();
			},
		});
		let customPrevented = false;
		let customDefaultPrevented = false;
		const customEvent = {
			button: 0,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			get defaultPrevented() {
				return customDefaultPrevented;
			},
			preventDefault() {
				customPrevented = true;
				customDefaultPrevented = true;
			},
		} as unknown as React.MouseEvent<HTMLAnchorElement>;

		preventedElement.props.onClick(customEvent);
		assert.equal(clicked, true);
		assert.equal(customPrevented, true);
		assert.equal(currentPathname, "/chat/replace-click");
	});

	it("synchronizes with window.history and popstate events in DOM environment", () => {
		const dom = parseHTML("<html><body></body></html>");
		const originalWindow = (globalThis as Record<string, unknown>).window;
		const originalDoc = (globalThis as Record<string, unknown>).document;

		const pushedUrls: string[] = [];
		const replacedUrls: string[] = [];
		const listeners = new Map<string, Array<(event: unknown) => void>>();

		const fakeWindow = {
			location: {
				pathname: "/initial",
				search: "",
				hash: "",
			},
			history: {
				pushState(_data: unknown, _unused: string, url: string) {
					pushedUrls.push(url);
					fakeWindow.location.pathname = url;
				},
				replaceState(_data: unknown, _unused: string, url: string) {
					replacedUrls.push(url);
					fakeWindow.location.pathname = url;
				},
				back() {},
				forward() {},
			},
			addEventListener(type: string, listener: (event: unknown) => void) {
				const arr = listeners.get(type) ?? [];
				arr.push(listener);
				listeners.set(type, arr);
			},
			removeEventListener(type: string, listener: (event: unknown) => void) {
				const arr = listeners.get(type) ?? [];
				listeners.set(
					type,
					arr.filter((l) => l !== listener),
				);
			},
			scrollTo(_x: number, _y: number) {},
		};

		try {
			(globalThis as Record<string, unknown>).window = fakeWindow;
			(globalThis as Record<string, unknown>).document = dom.document;

			resetClientRouterForTest("/dom/start");

			let currentPath = "";
			function Probe() {
				currentPath = usePathname();
				return null;
			}

			renderToStaticMarkup(<Probe />);
			assert.equal(currentPath, "/dom/start");

			const router = useRouter();
			router.push("/dom/pushed");
			renderToStaticMarkup(<Probe />);
			assert.equal(currentPath, "/dom/pushed");
			assert.deepEqual(pushedUrls, ["/dom/pushed"]);

			router.replace("/dom/replaced");
			renderToStaticMarkup(<Probe />);
			assert.equal(currentPath, "/dom/replaced");
			assert.ok(replacedUrls.includes("/dom/replaced"));

			// Dispatch popstate event to simulate browser back/forward
			fakeWindow.location.pathname = "/dom/popped";
			const popstateListeners = listeners.get("popstate") ?? [];
			for (const listener of popstateListeners) {
				listener({ type: "popstate" });
			}

			renderToStaticMarkup(<Probe />);
			assert.equal(currentPath, "/dom/popped");
		} finally {
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
		}
	});

	it("intercepts click on DOM-mounted Link element", async () => {
		const dom = parseHTML("<html><body><div id=\"root\"></div></body></html>");
		const originalWindow = (globalThis as Record<string, unknown>).window;
		const originalDoc = (globalThis as Record<string, unknown>).document;
		const originalActEnv = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;

		try {
			(globalThis as Record<string, unknown>).window = dom.window;
			(globalThis as Record<string, unknown>).document = dom.document;
			(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

			const { createRoot } = await import("react-dom/client");
			const { act } = await import("react");

			resetClientRouterForTest("/dom/link-start");

			const container = dom.document.getElementById("root")!;
			const root = createRoot(container as unknown as HTMLElement);

			function App() {
				const pathname = usePathname();
				return (
					<div>
						<span data-testid="path">{pathname}</span>
						<Link href="/dom/link-destination">Go</Link>
					</div>
				);
			}

			await act(async () => {
				root.render(<App />);
			});

			const pathSpan = container.querySelector('[data-testid="path"]')!;
			assert.equal(pathSpan.textContent, "/dom/link-start");

			const anchor = container.querySelector("a")!;
			assert.equal(anchor.getAttribute("href"), "/dom/link-destination");

			// Dispatch a click event on the anchor
			const clickEvent = new dom.window.Event("click", {
				bubbles: true,
				cancelable: true,
			});
			Object.assign(clickEvent, {
				button: 0,
				metaKey: false,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
			});

			await act(async () => {
				anchor.dispatchEvent(clickEvent);
			});

			assert.equal(clickEvent.defaultPrevented, true);
			assert.equal(pathSpan.textContent, "/dom/link-destination");

			await act(async () => {
				root.unmount();
			});
		} finally {
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
		}
	});
});
