import { test } from "node:test";
import assert from "node:assert/strict";
import { installTauriPreload } from "../src/client/tauri-preload.ts";

test("Tauri ChatGPT controls use native commands and receive status changes", async () => {
	const target: any = {};
	const calls: { cmd: string; args: any }[] = [];
	const listeners = new Map<string, (event: any) => void>();
	const status = { available: true, pending: false, allowBackgroundUse: true, activeId: null, accounts: [], error: null };
	installTauriPreload({ target, platform: "darwin", invoke: async (cmd, args) => { calls.push({ cmd, args }); return status as any; }, listen: (event, handler) => { listeners.set(event, handler); return () => {}; } });
	assert.equal(target.lh.subscriptionTransport, "desktop");
	assert.deepEqual(await target.lh.chatgpt.status(), status);
	await target.lh.chatgpt.login("account");
	await target.lh.chatgpt.consent(false);
	assert.deepEqual(calls.map((c) => [c.cmd, c.args.op]), [["lh_chatgpt_control", "status"], ["lh_chatgpt_control", "login"], ["lh_chatgpt_control", "consent"]]);
	let changes = 0;
	const unsubscribe = target.lh.chatgpt.onChange(() => changes++);
	listeners.get("lh://chatgpt-state")!({ payload: {} });
	unsubscribe();
	listeners.get("lh://chatgpt-state")!({ payload: {} });
	assert.equal(changes, 1);
});
