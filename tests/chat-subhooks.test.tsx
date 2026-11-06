import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import React, { act } from "react";
import { parseHTML } from "linkedom";
import { useChatTitleRename } from "../components/chat-hooks/use-chat-title-rename.ts";
import { useChatAbortDialog, type AbortMode } from "../components/chat-hooks/use-chat-abort-dialog.ts";

describe("chat sub-hooks", () => {
	const originalWindow = (globalThis as Record<string, unknown>).window;
	const originalDoc = (globalThis as Record<string, unknown>).document;
	const originalCustomEvent = (globalThis as Record<string, unknown>).CustomEvent;
	const originalEvent = (globalThis as Record<string, unknown>).Event;

	let dom: ReturnType<typeof parseHTML>;

	beforeEach(() => {
		dom = parseHTML("<html><body><div id=\"root\"></div></body></html>");
		(globalThis as Record<string, unknown>).window = dom.window;
		(globalThis as Record<string, unknown>).document = dom.document;
		(globalThis as Record<string, unknown>).CustomEvent = dom.window.CustomEvent;
		(globalThis as Record<string, unknown>).Event = dom.window.Event;
		(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		(globalThis as Record<string, unknown>).window = originalWindow;
		(globalThis as Record<string, unknown>).document = originalDoc;
		(globalThis as Record<string, unknown>).CustomEvent = originalCustomEvent;
		(globalThis as Record<string, unknown>).Event = originalEvent;
	});

	it("useChatTitleRename starts, drafts and commits title", async () => {
		const { createRoot } = await import("react-dom/client");
		let api: ReturnType<typeof useChatTitleRename> | null = null;
		let committedTitle = "";

		function TestComponent() {
			api = useChatTitleRename({
				chatId: "chat-123",
				title: "Initial Title",
				onRenamed: (t) => { committedTitle = t; },
			});
			return <div id="test-view">{api.titleText}</div>;
		}

		const rootEl = dom.document.getElementById("root")!;
		const root = createRoot(rootEl as unknown as HTMLElement);

		await act(async () => {
			root.render(<TestComponent />);
		});

		const getApi = () => api!;
		assert.ok(getApi());
		assert.equal(getApi().titleText, "Initial Title");
		assert.equal(getApi().renaming, false);

		// Start rename
		await act(async () => {
			getApi().startRename();
		});
		assert.equal(getApi().renaming, true);
		assert.equal(getApi().titleDraft, "Initial Title");

		// Change draft
		await act(async () => {
			getApi().setTitleDraft("Brand New Title");
		});
		assert.equal(getApi().titleDraft, "Brand New Title");

		// Cancel rename
		await act(async () => {
			getApi().cancelRename();
		});
		assert.equal(getApi().renaming, false);

		await act(async () => {
			root.unmount();
		});
	});

	it("useChatAbortDialog tracks dialog state and invokes confirm", async () => {
		const { createRoot } = await import("react-dom/client");
		let api: ReturnType<typeof useChatAbortDialog> | null = null;
		let confirmedMode: AbortMode | null = null;

		function TestComponent() {
			api = useChatAbortDialog({
				onConfirmAbort: (mode) => { confirmedMode = mode; },
			});
			return <div id="test-abort">{api.abortAsk ?? "none"}</div>;
		}

		const rootEl = dom.document.getElementById("root")!;
		const root = createRoot(rootEl as unknown as HTMLElement);

		await act(async () => {
			root.render(<TestComponent />);
		});

		const getApi = () => api!;
		assert.ok(getApi());
		assert.equal(getApi().abortAsk, null);

		// Open abort dialog for question
		await act(async () => {
			getApi().setAbortAsk("question");
		});
		assert.equal(getApi().abortAsk, "question");

		// Confirm abort
		await act(async () => {
			getApi().confirmAbort("question");
		});
		assert.equal(confirmedMode, "question");
		assert.equal(getApi().abortAsk, null);

		// Open and cancel
		await act(async () => {
			getApi().setAbortAsk("turn");
		});
		assert.equal(getApi().abortAsk, "turn");
		await act(async () => {
			getApi().cancelAbort();
		});
		assert.equal(getApi().abortAsk, null);

		await act(async () => {
			root.unmount();
		});
	});
});
