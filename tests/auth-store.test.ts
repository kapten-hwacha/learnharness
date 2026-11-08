/**
 * The AuthStore adapter: flat {VAR: value} auth.json map.
 * Tested against in-memory backend in Node test runner.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { authStore } from "../src/store/auth.ts";
import { resetMemoryStores, setRawMemoryAuth } from "../src/store/memory-backend.ts";

beforeEach(() => {
	resetMemoryStores();
});

describe("AuthStore adapter", () => {
	it("absent file = {} (the documented first-boot state), never throws", async () => {
		assert.deepEqual(await authStore.authVars(), {});
	});

	it("set → read round-trip; trim is the CALLER's (server's) job, verbatim here", async () => {
		await authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-abc");
		assert.equal((await authStore.authVars()).OPENROUTER_API_KEY, "sk-or-v1-abc");
	});

	it("set preserves unknown vars verbatim (forward-compat)", async () => {
		setRawMemoryAuth(JSON.stringify({ FUTURE_PLANS_TOKEN: "opaque-xyz", KEEP: "me" }));
		await authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-new");
		const vars = await authStore.authVars();
		assert.equal(vars.FUTURE_PLANS_TOKEN, "opaque-xyz");
		assert.equal(vars.KEEP, "me");
		assert.equal(vars.OPENROUTER_API_KEY, "sk-or-v1-new");
	});

	it("corrupt/non-object file = {} — never throws, looks like first boot", async () => {
		setRawMemoryAuth("{not json");
		assert.deepEqual(await authStore.authVars(), {});
		setRawMemoryAuth(JSON.stringify(["an", "array"]));
		assert.deepEqual(await authStore.authVars(), {});
		setRawMemoryAuth(JSON.stringify({ OK: "fine", bad: 42 }));
		assert.deepEqual(await authStore.authVars(), { OK: "fine" }, "non-string values drop");
	});

	it("delete removes just that var; absent delete = silent no-op", async () => {
		setRawMemoryAuth(JSON.stringify({ A: "1", B: "2" }));
		await authStore.deleteAuthVar("A");
		assert.deepEqual(await authStore.authVars(), { B: "2" });
		await authStore.deleteAuthVar("NOT_THERE");
		assert.deepEqual(await authStore.authVars(), { B: "2" });
	});
});
