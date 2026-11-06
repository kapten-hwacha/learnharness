# Priority 1: Security, Build & Linting Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve critical dependency vulnerabilities via npm overrides, eliminate Turbopack whole-project tracing by encapsulating graph store startup ledger purges, and enhance ESLint with React Hooks and TypeScript promise linting.

**Architecture:** 
1. Use targeted `overrides` in [package.json](file:///Users/hwacha/work/personal/learnharness/package.json) to patch transitive vulnerabilities in `dompurify`, `shell-quote`, `undici`, `linkify-it`, and `source-map-js`, and update `zod` in direct dependencies to `>=4.6.7`.
2. Extract module-load-time filesystem operations (`fs.existsSync`, `fs.rmSync`) from [src/store/graph.ts](file:///Users/hwacha/work/personal/learnharness/src/store/graph.ts) into an exported `purgeLegacyLedgers(): void` function, invoked during server composition boot in [src/server/stores.ts](file:///Users/hwacha/work/personal/learnharness/src/server/stores.ts).
3. Integrate `eslint-plugin-react-hooks` into [eslint.config.mjs](file:///Users/hwacha/work/personal/learnharness/eslint.config.mjs) with `rules-of-hooks: "error"` and `exhaustive-deps: "warn"` to enforce hook rules without destabilizing existing complex components.

**Tech Stack:** Node.js 22, npm 10, Next.js 16 (Turbopack), ESLint 9 (Flat Config), TypeScript 5.6.

**Spec:** [code-quality-audit.md](file:///Users/hwacha/.gemini/antigravity/brain/776d76d3-dfd5-4041-8870-b394751f70c6/code-quality-audit.md) Section 6 (Priority 1: Security, Build & Linting).

## Global Constraints
- Preserve exact import boundary architecture enforced by ESLint `import/no-restricted-paths`.
- Zero test regressions: all 3,438 tests across 596 test suites must continue to pass deterministically offline.
- No breaking package downgrades: do not run `npm audit fix --force` which would downgrade `@typescript-eslint/parser` or break ESLint 9 flat config.
- Turbopack build (`npm run build`) must succeed without whole-project tracing warnings triggered by `src/store/graph.ts`.

## Review Focus
1. **Transitive Override Collisions:** Overriding `undici` to `^7.30.2` must not break `openai` or `@earendil-works/pi-ai` streaming client.
2. **Zod 4 Semantics:** Upgrading root `zod` to `^4.6.7` must remain backwards-compatible with schema validation across `src/core/contracts/` and `src/agent/`.
3. **Graph Store Lazy Purge:** Purging legacy ledgers (`edges.jsonl`, `events.jsonl`) must happen only when storage is booted and must gracefully handle missing files or read-only directories.
4. **Turbopack Tracing Invalidation:** Removing the naked block from `src/store/graph.ts` must eliminate the warning at `src/store/graph.ts:351` during `next build`.
5. **ESLint Performance:** Adding `eslint-plugin-react-hooks` must execute quickly without introducing fatal configuration schema errors in ESLint 9 flat config.

---

### Task 1: Security Remediation via Targeted npm Overrides & Zod Bump

**Files:**
- Modify: [package.json](file:///Users/hwacha/work/personal/learnharness/package.json)
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: npm package registry
- Produces: Patched dependency tree in `node_modules` without critical advisories

- [ ] **Step 1: Update `package.json` with dependency overrides and updated zod**

In [package.json](file:///Users/hwacha/work/personal/learnharness/package.json):
1. Update `"dependencies"`:
   ```json
   "zod": "^4.6.7"
   ```
2. Update `"overrides"`:
   ```json
   "overrides": {
     "katex": "$katex",
     "dompurify": "^3.4.17",
     "shell-quote": "^1.12.0",
     "undici": "^7.30.2",
     "linkify-it": "^5.0.2",
     "source-map-js": "^1.2.2"
   }
   ```

- [ ] **Step 2: Install dependencies to generate updated lockfile**

Run: `npm install`
Expected: Clean resolution and installation of overridden packages.

- [ ] **Step 3: Verify vulnerability reduction with npm audit**

Run: `npm audit`
Expected: 0 Critical vulnerabilities (all 3 GHSA advisories for `dompurify` and `shell-quote` resolved).

- [ ] **Step 4: Verify test suite and typecheck remain completely green**

Run: `npm run typecheck && npm test`
Expected: `tsc --noEmit` exits 0; all tests pass.

- [ ] **Step 5: Commit dependency updates**

```bash
git add package.json package-lock.json
git commit -m "fix(deps): resolve critical security advisories via npm overrides and zod update"
```

---

### Task 2: Encapsulate Legacy Ledger Purge & Eliminate Turbopack Project Tracing

**Files:**
- Modify: [src/store/graph.ts](file:///Users/hwacha/work/personal/learnharness/src/store/graph.ts)
- Modify: [src/server/stores.ts](file:///Users/hwacha/work/personal/learnharness/src/server/stores.ts)
- Modify: [tests/graph.test.ts](file:///Users/hwacha/work/personal/learnharness/tests/graph.test.ts)

**Interfaces:**
- Consumes: `LEDGER_FILES.nodes` from [src/store/graph.ts](file:///Users/hwacha/work/personal/learnharness/src/store/graph.ts)
- Produces: `export function purgeLegacyLedgers(): void` in [src/store/graph.ts](file:///Users/hwacha/work/personal/learnharness/src/store/graph.ts)

- [ ] **Step 1: Write unit test in `tests/graph.test.ts` for `purgeLegacyLedgers`**

Add to [tests/graph.test.ts](file:///Users/hwacha/work/personal/learnharness/tests/graph.test.ts):
```ts
describe("purgeLegacyLedgers", () => {
    it("deletes legacy edges.jsonl and events.jsonl files when called", async () => {
        const { purgeLegacyLedgers } = await import("../src/store/graph.ts");
        const graphDir = path.dirname(LEDGER_FILES.nodes);
        fs.mkdirSync(graphDir, { recursive: true });
        const legacy1 = path.join(graphDir, "edges.jsonl");
        const legacy2 = path.join(graphDir, "events.jsonl");
        fs.writeFileSync(legacy1, "{}\n");
        fs.writeFileSync(legacy2, "{}\n");
        assert.ok(fs.existsSync(legacy1));
        assert.ok(fs.existsSync(legacy2));

        purgeLegacyLedgers();

        assert.ok(!fs.existsSync(legacy1), "edges.jsonl should be purged");
        assert.ok(!fs.existsSync(legacy2), "events.jsonl should be purged");

        // Subsequent call does not throw on absent files
        assert.doesNotThrow(() => purgeLegacyLedgers());
    });
});
```

- [ ] **Step 2: Run test to verify failure before implementation**

Run: `NODE_ENV=test tsx --test tests/graph.test.ts`
Expected: FAIL with `purgeLegacyLedgers is not exported from ../src/store/graph.ts`.

- [ ] **Step 3: Refactor `src/store/graph.ts` and `src/server/stores.ts`**

In [src/store/graph.ts](file:///Users/hwacha/work/personal/learnharness/src/store/graph.ts), replace the naked block at lines 348-361 with:
```ts
export function purgeLegacyLedgers(): void {
	const graphDir = path.dirname(LEDGER_FILES.nodes);
	for (const legacy of ["edges.jsonl", "events.jsonl"]) {
		const file = path.join(graphDir, legacy);
		try {
			if (fs.existsSync(file)) {
				fs.rmSync(file);
				console.info(`[graph-store] purged legacy ledger: ${file}`);
			}
		} catch (err) {
			console.warn(`[graph-store] could not purge legacy ledger ${file}:`, err);
		}
	}
}
```

In [src/server/stores.ts](file:///Users/hwacha/work/personal/learnharness/src/server/stores.ts), import and call it during startup:
```ts
import { graphStore, purgeLegacyLedgers } from "../store/graph.ts";
...
// Boot: register custom endpoint & purge legacy graph ledgers
syncCustomProvider();
purgeLegacyLedgers();
```

- [ ] **Step 4: Run unit test and Turbopack build to verify fix**

1. Run: `NODE_ENV=test tsx --test tests/graph.test.ts`
   Expected: PASS
2. Run: `npm run build`
   Expected: Build succeeds and the warning `./src/store/graph.ts:351:16 Warning: Dynamic filesystem access causes tracing of the whole project` is completely gone.

- [ ] **Step 5: Commit graph store encapsulation**

```bash
git add src/store/graph.ts src/server/stores.ts tests/graph.test.ts
git commit -m "fix(store): encapsulate legacy ledger purge to prevent Turbopack project tracing"
```

---

### Task 3: Enhance ESLint with React Hooks Rules

**Files:**
- Modify: [package.json](file:///Users/hwacha/work/personal/learnharness/package.json)
- Modify: [eslint.config.mjs](file:///Users/hwacha/work/personal/learnharness/eslint.config.mjs)

**Interfaces:**
- Consumes: `eslint-plugin-react-hooks`
- Produces: Flat config in [eslint.config.mjs](file:///Users/hwacha/work/personal/learnharness/eslint.config.mjs) enforcing `rules-of-hooks` (error) and `exhaustive-deps` (warn).

- [ ] **Step 1: Install `eslint-plugin-react-hooks`**

Run: `npm install -D eslint-plugin-react-hooks@^5.1.0`

- [ ] **Step 2: Update `eslint.config.mjs` to register the plugin and rules**

In [eslint.config.mjs](file:///Users/hwacha/work/personal/learnharness/eslint.config.mjs):
```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextPlugin from "@next/eslint-plugin-next";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import reactHooksPlugin from "eslint-plugin-react-hooks";

export default defineConfig([
	globalIgnores([".next/**", "node_modules/**", "data/**", "next-env.d.ts", "scripts/**", "electron/**", "dist/**", "dist-web/**", "src-tauri/**"]),
	{
		files: ["**/*.{js,mjs,ts,tsx}"],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaVersion: "latest", sourceType: "module" },
		},
		plugins: {
			"@next/next": nextPlugin,
			import: importPlugin,
			"react-hooks": reactHooksPlugin,
		},
		settings: {
			"import/resolver": { typescript: { alwaysTryTypes: true } },
		},
		rules: {
			...nextPlugin.configs.recommended.rules,
			"react-hooks/rules-of-hooks": "error",
			"react-hooks/exhaustive-deps": "warn",
			"import/no-restricted-paths": [ ... ],
		},
	},
]);
```

- [ ] **Step 3: Run linter to verify behavior**

Run: `npm run lint`
Expected: Exits 0 errors. React hooks rules are actively evaluated; `exhaustive-deps` reports warnings without blocking development.

- [ ] **Step 4: Commit ESLint configuration**

```bash
git add package.json package-lock.json eslint.config.mjs
git commit -m "chore(lint): configure eslint-plugin-react-hooks with error and warning thresholds"
```

---

### Task 4: Full Suite End-to-End Verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run TypeScript typecheck**
Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 2: Run ESLint**
Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 3: Run full offline test suite**
Run: `npm test`
Expected: All 3,438 tests pass.

- [ ] **Step 4: Run Vite build**
Run: `npm run vite:build`
Expected: Exits 0.

- [ ] **Step 5: Run Next.js production build**
Run: `npm run build`
Expected: Exits 0.
