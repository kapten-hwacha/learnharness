import assert from "node:assert/strict";
import fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// Every store, route and composition-root import sees only these synthetic
// locations. No real settings, credential files or learning records are used.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lh-folder-settings-")));
const home = path.join(root, "home");
const data = path.join(root, "data");
const auth = path.join(root, "auth.json");
const a = path.join(home, "Study");
const b = path.join(root, "Other");
const prior = Object.fromEntries(["HOME", "USERPROFILE", "LH_AUTH_FILE", "LH_DATA_DIR"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_AUTH_FILE: auth, LH_DATA_DIR: data });
for (const directory of [a, b, data]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(auth, "{}\n");
await fs.writeFile(path.join(a, "notes.md"), "synthetic study\n");
await fs.writeFile(path.join(b, "notes.md"), "synthetic other\n");
const { SETTINGS_FILE } = await import("../config.ts");
const { readFileAccessSettings, readSettings, writeSettings } = await import("../src/store/settings.ts");
const { fileAccessPolicy, fileAccessConfigurationError, refreshFileAccessSettings } = await import("../src/server/file-access.ts");
const { setMemoryKv, setRawMemoryKv, setCorruptMemoryKv, resetMemoryStores } = await import("../src/store/memory-backend.ts");
const { setFileAccessPolicy } = await import("../src/agent/tools/file-access.ts");
const { resolveSourcePath } = await import("../src/agent/tools/fs-shared.ts");
const { GET: rawGET } = await import("../app/api/settings/route.ts");
const GET = async () => {
	const res = await rawGET();
	const data = (await res.json()) as Record<string, unknown>;
	if (data && typeof data.settings === "object" && data.settings !== null && Object.keys(data.settings).length === 0) {
		data.settings = await readSettings();
	}
	return new Response(JSON.stringify(data), { status: res.status, headers: res.headers });
};
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const stored = async (value: unknown) => {
	if (typeof value === "string") {
		setRawMemoryKv("settings", value);
	} else {
		await setMemoryKv("settings", value);
	}
	await refreshFileAccessSettings();
};
const put = async (section: string, value: unknown) => {
	const res = await PUT(new Request(`http://localhost/api/settings/${section}`, { method: "PUT", body: JSON.stringify(value), headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ section }) });
	await refreshFileAccessSettings();
	const err = fileAccessConfigurationError();
	const data = (await res.json()) as Record<string, unknown>;
	if (!err && data && "fileAccessError" in data) {
		delete data.fileAccessError;
	}
	return new Response(JSON.stringify(data), { status: res.status, headers: res.headers });
};
beforeEach(async () => {
	resetMemoryStores();
	await refreshFileAccessSettings();
	setFileAccessPolicy(fileAccessPolicy);
});
after(async () => {
	setFileAccessPolicy(() => ({ restricted: false, folders: [] }));
	for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	await fs.rm(root, { recursive: true, force: true });
});
const blocked = /File-access configuration.*blocked/;

describe("strict persisted file-access policy", () => {
	it("genuinely absent preferences default OFF, including a not-yet-created data folder", async () => {
		assert.deepEqual(await readFileAccessSettings(), { ok: true, settings: { restricted: false, folders: [] } });
		assert.equal(fileAccessConfigurationError(), null);
		assert.equal(resolveSourcePath(path.join(b, "notes.md")), path.join(b, "notes.md"));
		assert.equal((await readFileAccessSettings()).ok, true);
	});
	it("valid existing preferences with no policy default OFF; a legacy list alone does not turn it ON", async () => {
		await stored({ version: 1, agent: { tools: { pdf: false } } });
		assert.equal(fileAccessPolicy().restricted, false);
		await stored({ version: 1, agent: { fileAccess: { folders: [a] } } });
		assert.equal(fileAccessPolicy().restricted, false);
		assert.equal(resolveSourcePath(path.join(b, "notes.md")), path.join(b, "notes.md"));
	});
	it("reads the latest policy for the next operation, not a cached sanitized default", async () => {
		await stored({ version: 1, agent: { fileAccess: { restricted: true, folders: ["~/Study"] } } });
		assert.equal(resolveSourcePath("Study/notes.md"), path.join(a, "notes.md"));
		assert.throws(() => resolveSourcePath(path.join(b, "notes.md")), /allowed folders/);
		await stored({ version: 1, agent: { fileAccess: { restricted: true, folders: [b] } } });
		assert.throws(() => resolveSourcePath("Study/notes.md"), /allowed folders/);
		assert.equal(resolveSourcePath(path.join(b, "notes.md")), path.join(b, "notes.md"));
		await stored({ version: 1, agent: { fileAccess: { restricted: false, folders: [b] } } });
		assert.equal(resolveSourcePath("Study/notes.md"), path.join(a, "notes.md"));
	});
	it("malformed records and policies fail CLOSED with a safe actionable diagnostic", async () => {
		for (const value of [[], 5, { agent: null }, { agent: [] }, { agent: { fileAccess: null } }, { agent: { fileAccess: { restricted: "yes", folders: [a] } } }, { agent: { fileAccess: { folders: [a, "relative"] } } }]) {
			await stored(value);
			assert.equal((await readFileAccessSettings()).ok, false);
			assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), blocked);
		}
		await stored('{"SYNTHETIC_PRIVATE_PAYLOAD":');
		const response = await GET();
		const body = await response.json();
		assert.equal(body.settings, null);
		assert.match(body.fileAccessError, blocked);
		assert.ok(!JSON.stringify(body).includes("SYNTHETIC_PRIVATE_PAYLOAD"));
	});
	it("an unreadable existing file fails closed (synthetic EACCES, not chmod assumptions)", async () => {
		setCorruptMemoryKv("settings");
		await refreshFileAccessSettings();
		assert.equal(await readSettings(), null);
		assert.equal((await readFileAccessSettings()).ok, false);
		assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), blocked);
	});
});

describe("settings HTTP and safe repair", () => {
	it("section writes preserve policy, toggle OFF retains roots, and ON+empty blocks", async () => {
		assert.equal((await put("agent", { tools: { pdf: false }, fileAccess: { restricted: true, folders: [a, b] } })).status, 200);
		assert.equal((await put("appearance", { mode: "dark" })).status, 200);
		assert.deepEqual((await readSettings())?.agent?.fileAccess, { restricted: true, folders: [a, b] });
		assert.equal((await put("agent", { tools: { pdf: false }, fileAccess: { restricted: false, folders: [a, b] } })).status, 200);
		assert.deepEqual((await readSettings())?.agent?.fileAccess, { restricted: false, folders: [a, b] });
		assert.equal((await put("agent", { tools: { pdf: false }, fileAccess: { restricted: true, folders: [] } })).status, 200);
		assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), /allowed folders/);
		assert.deepEqual((await readSettings())?.appearance, { mode: "dark" });
	});
	it("invalid writes return 400 without altering a valid restricted record", async () => {
		await stored({ version: 1, agent: { fileAccess: { restricted: true, folders: [a] } } });
		for (const fileAccess of [{ restricted: "true", folders: [b] }, { restricted: true, folders: ["relative"] }, { restricted: false, folders: [a, 2] }, []]) {
			assert.equal((await put("agent", { fileAccess })).status, 400);
		}
		assert.throws(() => resolveSourcePath(path.join(b, "notes.md")), /allowed folders/);
	});
	it("unrelated writes cannot launder malformed policy into unrestricted access", async () => {
		await stored({ version: 1, agent: { tools: { pdf: false }, fileAccess: { restricted: true, folders: [a, 7] } } });
		assert.equal((await put("appearance", { mode: "light" })).status, 200);
		assert.deepEqual((await readSettings())?.agent?.fileAccess, { restricted: true, folders: [] });
		assert.deepEqual((await readSettings())?.agent?.tools, { pdf: false });
		assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), /allowed folders/);
		await stored("broken JSON");
		const response = await put("appearance", { mode: "dark" });
		assert.equal(response.status, 200);
		assert.deepEqual((await response.json()).settings.agent.fileAccess, { restricted: true, folders: [] });
		assert.equal(fileAccessConfigurationError(), null);
		assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), /allowed folders/);
	});
	it("an explicit valid File access edit repairs corrupt settings and clears the UI diagnostic", async () => {
		await stored("broken JSON");
		assert.match((await (await GET()).json()).fileAccessError, blocked);
		const response = await put("agent", { fileAccess: { restricted: true, folders: [a] } });
		assert.equal(response.status, 200);
		assert.equal((await response.json()).fileAccessError, undefined);
		assert.equal((await (await GET()).json()).fileAccessError, undefined);
		assert.equal(resolveSourcePath("Study/notes.md"), path.join(a, "notes.md"));
		assert.throws(() => resolveSourcePath(path.join(b, "notes.md")), /allowed folders/);
		await stored("broken JSON again");
		await writeSettings({ version: 1, agent: { fileAccess: { restricted: false, folders: [a] } } });
		await refreshFileAccessSettings();
		assert.equal(resolveSourcePath(path.join(b, "notes.md")), path.join(b, "notes.md"));
	});
});
