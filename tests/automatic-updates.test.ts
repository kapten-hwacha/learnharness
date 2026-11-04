import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reduceUpdate, type UpdateState } from "../src/core/update-state.ts";
import { installTauriPreload } from "../src/client/tauri-preload.ts";

describe("Tauri automatic updates", () => {
	it("reduceUpdate downloaded is sticky", () => {
		const downloaded: UpdateState = {
			status: "downloaded",
			version: "0.4.2",
			revision: 3,
		};

		const afterChecking = reduceUpdate(downloaded, { type: "checking" });
		assert.equal(afterChecking.status, "downloaded");
		assert.equal(afterChecking.version, "0.4.2");
		assert.equal(afterChecking.revision, 3);

		const afterError = reduceUpdate(downloaded, { type: "error" });
		assert.equal(afterError.status, "downloaded");
		assert.equal(afterError.version, "0.4.2");
		assert.equal(afterError.revision, 3);
	});

	it("revision increments on each accepted change", () => {
		const initial: UpdateState = {
			status: "idle",
			version: null,
			revision: 0,
		};

		const s1 = reduceUpdate(initial, { type: "checking" });
		assert.equal(s1.status, "checking");
		assert.equal(s1.revision, 1);

		const s2 = reduceUpdate(s1, { type: "downloading", version: "0.5.0" });
		assert.equal(s2.status, "downloading");
		assert.equal(s2.version, "0.5.0");
		assert.equal(s2.revision, 2);

		const s3 = reduceUpdate(s2, { type: "downloaded", version: "0.5.0" });
		assert.equal(s3.status, "downloaded");
		assert.equal(s3.revision, 3);

		// Redundant change produces same revision
		const s4 = reduceUpdate(s3, { type: "checking" });
		assert.equal(s4.revision, 3);
	});

	it("disabled stays disabled", () => {
		const disabled: UpdateState = {
			status: "disabled",
			version: null,
			revision: 0,
		};

		const s1 = reduceUpdate(disabled, { type: "checking" });
		assert.equal(s1.status, "disabled");
		assert.equal(s1.revision, 0);

		const s2 = reduceUpdate(disabled, { type: "downloading", version: "1.0.0" });
		assert.equal(s2.status, "disabled");
		assert.equal(s2.revision, 0);
	});

	it("lh.checkForUpdates invokes lh_update_check; installUpdate invokes lh_update_install; getUpdateState invokes lh_update_get", async () => {
		const invoked: string[] = [];
		const mockState: UpdateState = {
			status: "idle",
			version: null,
			revision: 0,
		};

		const target = {
			addEventListener() {},
			removeEventListener() {},
		} as any;

		installTauriPreload({
			invoke: async <T>(cmd: string) => {
				invoked.push(cmd);
				if (cmd === "lh_update_get") return mockState as unknown as T;
				return undefined as unknown as T;
			},
			listen: async () => () => {},
			platform: "darwin",
			target,
		});

		await target.lh.checkForUpdates();
		assert.equal(invoked[0], "lh_update_check");

		await target.lh.installUpdate();
		assert.equal(invoked[1], "lh_update_install");

		const state = await target.lh.getUpdateState();
		assert.equal(invoked[2], "lh_update_get");
		assert.deepEqual(state, mockState);
	});

	it("onUpdateStatus receives lh://update-status payloads and unsubscribes", () => {
		let registeredCallback: ((event: { payload: UpdateState }) => void) | undefined;
		let unlistenCalled = false;

		const target = {
			addEventListener() {},
			removeEventListener() {},
		} as any;

		installTauriPreload({
			invoke: async <T>() => undefined as unknown as T,
			listen: (event, cb) => {
				if (event === "lh://update-status") {
					registeredCallback = cb as any;
				}
				return () => {
					unlistenCalled = true;
				};
			},
			platform: "darwin",
			target,
		});

		const received: UpdateState[] = [];
		const unsub = target.lh.onUpdateStatus((s: UpdateState) => {
			received.push(s);
		});

		assert.ok(registeredCallback);
		const testState: UpdateState = { status: "checking", version: null, revision: 1 };
		registeredCallback({ payload: testState });

		assert.deepEqual(received, [testState]);

		unsub();
		assert.equal(unlistenCalled, true);
	});
});
