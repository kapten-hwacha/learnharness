# Rust SQLite Storage & Persistence Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the Web Worker virtual filesystem (`src/worker/shims/fs.ts`) and write-behind IPC bridge (`lh_fs_hydrate` / `lh_fs_sync`), replacing all JSON/JSONL file persistence with a Rust SQLite engine (`rusqlite` with FTS5 and indexed FSRS/graph tables) behind async `src/core/ports.ts` interfaces.

**Architecture:**
1. **Rust SQLite Core (`src-tauri/src/storage/`):** Embed SQLite (`rusqlite` with `bundled` feature, WAL mode) inside Tauri managed state (`DbState`). Implement atomic transactions for chats (with separated `chat_image_snapshots`, `practice_records`, and `chats_fts`), knowledge graph ledgers (with `nodes_fts` and `fsrs_cards` indexed on `due_at_ms`), jobs, study intervals, prompt overrides, and singleton KV documents (`settings`, `render_settings`, `source_organization`, `study_open`, `profiler_state`), plus a first-boot auto-migrator from legacy `data/` JSON/JSONL files.
2. **Async Hexagonal Ports & Dual Backend (`src/core/ports.ts` & `src/store/`):** Convert `ChatStore`, `GraphStore`, `JobStore`, `SettingsStore`, `StudyStore`, `SourceOrganizationStore`, `PromptOverrideStore`, and `AuthStore` to `Promise`-based (`async`) contracts. In Tauri, `src/store/*` invokes `lh_*` commands directly; in `npm test` (`tsx --test`), `src/store/*` delegates to a deterministic in-memory backend (`src/store/memory-backend.ts`).
3. **Zero-MemFS Worker & Bundled Assets (`src/agent/`, `src/worker/`, `src-tauri/src/fs_bridge.rs`):** Bundle static prompt and skill markdown files via `src/agent/bundled-assets.ts`, route external learner file tools (`read`, `ls`, `find`, `grep`, `quaderno`) and debug recorders through explicit Rust commands, wire sidebar FTS5 search (`GET /api/chats?q=...`), and delete `src/worker/shims/fs.ts` and `src/worker/shims/fs-promises.ts`.

**Tech Stack:** Rust (`rusqlite 0.32` with `bundled` / FTS5, `tauri 2`, `serde`, `serde_json`), TypeScript 5.6, React 19, Vite 6.

**Spec:** [2026-11-08-rust-sqlite-storage-design.md](file:///Users/hwacha/work/personal/learnharness/docs/superpowers/specs/2026-11-08-rust-sqlite-storage-design.md)

## Global Constraints

- **Disjoint File Ownership:** Each task below specifies its exact **Owned Files**. Concurrent `flash` subagents MUST NOT edit files outside their task's owned list.
- **Model Escalation Rule:** Default to `flash` subagents for mechanical tasks (Tasks 1–3, 5, 7); use `pro` (or escalate after 2 failed attempts) for cross-cutting async port propagation (Tasks 4, 6).
- **Linter & Formatter Gate:** Every Rust task MUST run `cargo fmt --manifest-path src-tauri/Cargo.toml` and `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`. Every TypeScript task MUST run `npm run typecheck` and `npm run lint`.
- **Atomic Commits:** Create a separate atomic git commit (`git add <exact-files> && git commit --only <exact-files> -m "..."`) per completed task. Never use `git add .` or `git add -A`.
- **Security Invariant:** `auth.json` and `*-credentials.json` must always be written with mode `0600` on Unix. `validate_external_read_path` must continue blocking `SENSITIVE_HOME_PATHS`, `.env*`, and `auth.json`, reading `fileAccess` restrictions from SQLite `kv_documents` (`key = 'settings'`).

## Review Focus

1. **Downgrade Schema Guard (`version > CURRENT_CHAT_VERSION`):** `lh_load_chat` and `chatStore.getChat` must still return `null` (refusing to read or overwrite) if a chat row carries a `version` higher than `CURRENT_CHAT_VERSION`.
2. **Silence Law on `ChatStore` Events:** `createChat`, `renameChat`, and `deleteChat` emit `"chats-changed"`, whereas `saveMessages`, `saveTree`, `saveSettings`, `appendTurnUsage`, `appendExtractionUsage`, and `appendClarification` MUST NOT emit `"chats-changed"` or bump `updatedAt` (except `saveMessages`, which bumps `updatedAt`).
3. **Idempotent Usage Appends:** `appendTurnUsage` (by `entry.id`), `appendExtractionUsage` (by `entry.startedAt`), and `appendSourceUsage` (by `entry.startedAt`) must remain strictly idempotent on replay.
4. **FTS5 Query Sanitization:** User search strings containing FTS5 syntax characters (`"`, `*`, `^`, `:`, `-`, `OR`, `AND`, parentheses) must be escaped into safe prefix-quoted tokens in Rust before running `MATCH` so arbitrary user input never triggers a SQLite FTS5 syntax error.
5. **First-Boot Migration Idempotency:** If a legacy `data/` directory contains corrupt JSON lines in `nodes.jsonl` or `intervals.jsonl`, the migrator must skip corrupt lines (matching prior JSONL reader behavior) and commit valid records atomically, setting `PRAGMA user_version = 1` so migration never re-runs.

---

### Task 1: Rust SQLite Foundation, Schema & Legacy `data/` Auto-Migrator

**Owned Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/storage/mod.rs`
- Create: `src-tauri/src/storage/schema.rs`
- Create: `src-tauri/src/storage/migrate.rs`

**Interfaces:**
- Consumes: `resolve_app_dirs` from `src-tauri/src/fs_bridge.rs`
- Produces:
  - `pub struct DbState { pub conn: Arc<Mutex<rusqlite::Connection>>, pub data_dir: PathBuf, pub auth_file: PathBuf, pub user_data_dir: PathBuf }`
  - `pub fn open_and_init_db(db_path: &Path, data_dir: &Path, auth_file: &Path, user_data_dir: &Path) -> Result<DbState, String>`
  - `pub fn sanitize_fts5_query(raw: &str) -> Option<String>`

- [ ] **Step 1: Add `rusqlite` dependency to `src-tauri/Cargo.toml`**

Add under `[dependencies]` in `src-tauri/Cargo.toml`:
```toml
rusqlite = { version = "0.32", features = ["bundled"] }
```

- [ ] **Step 2: Write failing Rust tests in `src-tauri/src/storage/mod.rs` for schema init, FTS5 query sanitization, and legacy `data/` migration**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn initializes_schema_and_sets_user_version_1() {
        let tmp = std::env::temp_dir().join(format!("lh_sql_init_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let db_path = tmp.join("learnharness.db");
        let data_dir = tmp.join("data");
        let auth_file = tmp.join("auth.json");
        let state = open_and_init_db(&db_path, &data_dir, &auth_file, &tmp).unwrap();
        let conn = state.conn.lock().unwrap();
        let ver: i32 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(ver, 1);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn migrates_legacy_chats_graph_settings_and_study_on_first_boot() {
        let tmp = std::env::temp_dir().join(format!("lh_sql_mig_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let data_dir = tmp.join("data");
        fs::create_dir_all(data_dir.join("chats")).unwrap();
        fs::create_dir_all(data_dir.join("graph")).unwrap();
        fs::create_dir_all(data_dir.join("study")).unwrap();

        fs::write(
            data_dir.join("chats/chat_1.json"),
            r#"{"id":"chat_1","version":1,"title":"Test Chat","createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z","messages":[]}"#,
        ).unwrap();
        fs::write(
            data_dir.join("graph/nodes.jsonl"),
            "{\"id\":\"n1\",\"name\":\"Node 1\",\"statement\":\"Stmt 1\",\"aliases\":[\"a1\"],\"createdAt\":\"2026-10-01T00:00:00Z\",\"provenance\":[{\"chatId\":\"chat_1\",\"messageId\":\"m1\"}]}\ncorrupt_line\n",
        ).unwrap();
        fs::write(
            data_dir.join("settings.json"),
            r#"{"version":1,"general":{"autoUpdate":false}}"#,
        ).unwrap();

        let db_path = tmp.join("learnharness.db");
        let auth_file = tmp.join("auth.json");
        let state = open_and_init_db(&db_path, &data_dir, &auth_file, &tmp).unwrap();
        let conn = state.conn.lock().unwrap();

        let chat_title: String = conn
            .query_row("SELECT title FROM chats WHERE id = 'chat_1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(chat_title, "Test Chat");

        let node_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM graph_nodes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(node_count, 1);

        let settings_raw: String = conn
            .query_row("SELECT value_json FROM kv_documents WHERE key = 'settings'", [], |r| r.get(0))
            .unwrap();
        assert!(settings_raw.contains("autoUpdate"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn sanitizes_fts5_queries_safely() {
        assert_eq!(sanitize_fts5_query("hello world"), Some("\"hello\"* \"world\"*".to_string()));
        assert_eq!(sanitize_fts5_query("foo\"bar: (baz) -qux"), Some("\"foobar\"* \"baz\"* \"qux\"*".to_string()));
        assert_eq!(sanitize_fts5_query("   "), None);
    }
}
```

- [ ] **Step 3: Implement `schema.rs`, `migrate.rs`, and `mod.rs`**

Implement the DDL from Spec §2.3 in `src-tauri/src/storage/schema.rs` and the legacy importer in `src-tauri/src/storage/migrate.rs` (importing `chats/*.json`, `graph/{nodes,chains,sessions,coverage,regroups}.jsonl`, `graph/{sources,positions,render-settings,source-organization}.json`, `jobs/*.json`, `study/{intervals.jsonl,open.json}`, `prompts/**/*.md`, `settings.json`, and `profiler-state.json`).

- [ ] **Step 4: Run Rust tests and linters**

Run:
```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml storage::tests
```
Expected: PASS with 0 warnings.

- [ ] **Step 5: Commit atomically**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/storage/mod.rs src-tauri/src/storage/schema.rs src-tauri/src/storage/migrate.rs
git commit --only src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/storage/mod.rs src-tauri/src/storage/schema.rs src-tauri/src/storage/migrate.rs -m "feat(storage): add rusqlite schema and first-boot legacy data migrator"
```

---

### Task 2: Rust Tauri Commands for Chats, Graph, FSRS, Jobs, KV, Study, Prompts & Auth

**Owned Files:**
- Create: `src-tauri/src/storage/chats.rs`
- Create: `src-tauri/src/storage/graph.rs`
- Create: `src-tauri/src/storage/jobs.rs`
- Create: `src-tauri/src/storage/kv.rs`
- Modify: `src-tauri/src/storage/mod.rs`
- Modify: `src-tauri/src/fs_bridge.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `DbState`, `sanitize_fts5_query` from `src-tauri/src/storage/mod.rs`
- Produces Tauri commands registered in `src-tauri/src/lib.rs`:
  - Runtime: `lh_runtime_init`
  - Chats: `lh_save_chat`, `lh_load_chat`, `lh_list_chats`, `lh_save_chat_image`, `lh_delete_chat`, `lh_search_chats`
  - Graph & FSRS: `lh_graph_append_node`, `lh_graph_read_nodes`, `lh_graph_append_chain`, `lh_graph_read_chains`, `lh_graph_append_checkpoint`, `lh_graph_read_checkpoints`, `lh_graph_append_coverage`, `lh_graph_read_coverage`, `lh_graph_append_regroup`, `lh_graph_read_regroups`, `lh_graph_upsert_source`, `lh_graph_read_sources`, `lh_graph_delete_sources`, `lh_graph_append_source_usage`, `lh_graph_read_positions`, `lh_graph_write_positions`, `lh_graph_rewrite_ledgers`, `lh_graph_revision`, `lh_search_nodes`, `lh_read_practice_history`, `lh_upsert_fsrs_cards`, `lh_read_fsrs_cards`
  - Jobs: `lh_job_save`, `lh_job_get`, `lh_job_list`, `lh_job_find_by_tool_call`, `lh_job_delete_for_chat`
  - KV / Study / Prompts / Auth: `lh_kv_get`, `lh_kv_set`, `lh_study_read_intervals`, `lh_study_append_intervals`, `lh_prompt_override_list`, `lh_prompt_override_read`, `lh_prompt_override_write`, `lh_prompt_override_delete`, `lh_auth_read`, `lh_auth_write`
  - External Learner FS & Debug (`fs_bridge.rs`): `lh_fs_read_external`, `lh_fs_stat_external`, `lh_fs_list_external_dir`, `lh_fs_walk_external`, `lh_quaderno_write_pdf`, `lh_quaderno_list_pdfs`, `lh_debug_write` (removing `lh_fs_hydrate` and `lh_fs_sync`).

- [ ] **Step 1: Write failing Rust unit tests in `chats.rs`, `graph.rs`, `jobs.rs`, `kv.rs`, and `fs_bridge.rs`**

Test cases to include:
- `chats::tests::crud_and_fts_search_and_image_snapshots`: verifies `save_chat`, `list_chats` (ordered by `updated_at DESC`), `save_chat_image` (idempotent snapshot attach), `search_chats` (FTS5 match on title and transcript), and cascading delete of `chat_image_snapshots` + `practice_records` + `chats_fts` on `delete_chat`.
- `graph::tests::ledgers_fts_and_fsrs_cards`: verifies append order (`seq ASC`), `rewrite_ledgers` atomic replacement, `search_nodes` FTS5 ranking, `read_practice_history`, and `upsert_fsrs_cards` / `read_fsrs_cards` ordered by `due_at_ms ASC`.
- `jobs::tests::job_crud_and_tool_call_lookup`: verifies `job_save`, `job_list`, `job_find_by_tool_call`, and `job_delete_for_chat`.
- `kv::tests::kv_study_prompts_and_auth_0600`: verifies `kv_get`/`kv_set`, `study_append_intervals`, `prompt_override_*`, and `auth_write` creating `0600` file permissions on Unix.
- `fs_bridge::tests::external_walk_and_db_settings_policy`: verifies `validate_external_read_path` reading restricted `fileAccess` folders from SQLite `kv_documents` (`'settings'`) and `lh_fs_walk_external` skipping `SENSITIVE_HOME_PATHS` and `.env`.

- [ ] **Step 2: Implement `chats.rs`, `graph.rs`, `jobs.rs`, `kv.rs`, and update `fs_bridge.rs` + `lib.rs`**

Ensure every mutating operation runs inside a `rusqlite::Transaction` (`conn.transaction()`). Update `src-tauri/src/lib.rs` to initialize `DbState` in `.setup(|app| ...)` and register all commands in `tauri::generate_handler![]`.

- [ ] **Step 3: Run Rust tests, formatter, and clippy**

Run:
```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: All Rust unit tests pass with 0 warnings.

- [ ] **Step 4: Commit atomically**

```bash
git add src-tauri/src/storage/ src-tauri/src/fs_bridge.rs src-tauri/src/lib.rs
git commit --only src-tauri/src/storage/mod.rs src-tauri/src/storage/chats.rs src-tauri/src/storage/graph.rs src-tauri/src/storage/jobs.rs src-tauri/src/storage/kv.rs src-tauri/src/fs_bridge.rs src-tauri/src/lib.rs -m "feat(tauri): implement SQLite storage commands and external learner fs bridge"
```

---

### Task 3: Bundled Static Assets (`prompts` & `skills`) & External Learner FS Client Bridge

**Owned Files:**
- Create: `src/agent/bundled-assets.ts`
- Modify: `src/agent/prompt-segments.ts`
- Modify: `src/agent/tools/skill.ts`
- Modify: `src/worker/host-bridge.ts`
- Create: `tests/bundled-assets.test.ts`
- Modify: `tests/tauri-host-bridge.test.ts`

**Interfaces:**
- Produces in `src/agent/bundled-assets.ts`:
  - `readBundledSystemPrompt(): string`
  - `listBundledPromptFragments(agent: "prober" | "teacher" | "practice" | "shared"): Array<{ filename: string; content: string }>`
  - `listBundledSkills(): Array<{ dirName: string; content: string }>`
- Produces in `src/worker/host-bridge.ts`:
  - Updated `HostBridge` interface removing `hydrateFs` and `syncFs`, adding `initRuntime(): Promise<{ homeDir: string; authVars: Record<string, string> }>`, `statExternalFile(absPath: string)`, `listExternalDir(absPath: string)`, `walkExternalDir(root: string, maxFiles?: number, timeoutMs?: number)`, `writeDebugLog(kind: string, filename: string, content: string, append: boolean)`.

- [ ] **Step 1: Write failing tests in `tests/bundled-assets.test.ts` and `tests/tauri-host-bridge.test.ts`**

Verify that `readBundledSystemPrompt()`, `listBundledPromptFragments()`, and `listBundledSkills()` return all expected prompt segments and skills without touching `memfs`, and that `createTauriHostBridge` maps `initRuntime`, `readExternalFile`, `statExternalFile`, `listExternalDir`, and `walkExternalDir` to their `lh_*` commands.

- [ ] **Step 2: Implement `src/agent/bundled-assets.ts` and update `prompt-segments.ts`, `skill.ts`, and `host-bridge.ts`**

Use Vite's `import.meta.glob` when available, with a Node `node:fs` fallback for `tsx` test execution. Note: `readPromptOverride` in `src/agent/prompt-segments.ts` becomes async (or reads via `promptOverrides.readOverride`).

- [ ] **Step 3: Run tests and lint**

Run:
```bash
npx tsx --test tests/bundled-assets.test.ts tests/tauri-host-bridge.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit atomically**

```bash
git add src/agent/bundled-assets.ts src/agent/prompt-segments.ts src/agent/tools/skill.ts src/worker/host-bridge.ts tests/bundled-assets.test.ts tests/tauri-host-bridge.test.ts
git commit --only src/agent/bundled-assets.ts src/agent/prompt-segments.ts src/agent/tools/skill.ts src/worker/host-bridge.ts tests/bundled-assets.test.ts tests/tauri-host-bridge.test.ts -m "feat(agent): bundle prompt and skill markdown assets and update HostBridge contract"
```

---

### Task 4: Async `src/core/ports.ts`, Tauri IPC Store Adapters & In-Memory Test Backend

**Owned Files:**
- Modify: `src/core/ports.ts`
- Modify: `src/core/contracts/chats.ts`
- Modify: `src/core/contracts/graph.ts`
- Create: `src/store/memory-backend.ts`
- Modify: `src/store/chats.ts`
- Modify: `src/store/graph.ts`
- Modify: `src/store/jobs.ts`
- Modify: `src/store/settings.ts`
- Modify: `src/store/study.ts`
- Modify: `src/store/source-organization.ts`
- Modify: `src/store/prompt-overrides.ts`
- Modify: `src/store/render-settings.ts`
- Modify: `src/store/auth.ts`
- Delete: `src/store/atomic-write.ts`
- Delete: `src/store/graph-format.ts`

**Interfaces:**
- Produces in `src/core/ports.ts`:
  - Async `ChatStore` (including `searchChats(query: string, limit?: number): Promise<ChatSearchHit[]>`), `GraphStore` (including `searchNodes(query: string, limit?: number): Promise<NodeSearchHit[]>`, `readPracticeHistory(): Promise<PracticeHistory>`, `syncFsrsCards(cards: FsrsCardRow[]): Promise<void>`, `readFsrsCards(): Promise<FsrsCardRow[]>`, `revision(): Promise<number>`), `JobStore`, `SettingsStore`, `StudyStore`, `SourceOrganizationStore`, `PromptOverrideStore`, `AuthStore`.
- Produces in `src/store/memory-backend.ts`:
  - `resetMemoryStores(): void` and the in-memory store implementations used automatically when `getTauriInvoke()` is `null` (Node test runner).

- [ ] **Step 1: Update `src/core/ports.ts` and contracts (`ChatSearchHit`, `NodeSearchHit`, `FsrsCardRow`)**

Update all port methods in `src/core/ports.ts` to return `Promise<...>`.

- [ ] **Step 2: Implement `src/store/memory-backend.ts` and rewrite `src/store/*.ts` to dispatch to `getTauriInvoke()` or `memory-backend.ts`**

Each store module in `src/store/*.ts`:
- Has **zero** `import ... from "node:fs"` imports.
- Calls `getTauriInvoke()` when present (`lh_save_chat`, `lh_load_chat`, `lh_list_chats`, etc.) and falls back to `memory-backend.ts` in Node tests.
- Preserves all domain invariants (`CURRENT_CHAT_VERSION` check, `emit("chats-changed", {})` Silence Law, SHA-256 `saveImageSnapshot` check, `emit("jobs-changed", ...)`, `emit("sources-changed", {})`, `sanitizeUserSettings`, `sanitizeRenderSettings`).
- Delete `src/store/atomic-write.ts` and `src/store/graph-format.ts`.

- [ ] **Step 3: Verify store unit tests**

Run:
```bash
npx tsx --test tests/chat-store-events.test.ts tests/settings-store.test.ts tests/study-store.test.ts tests/auth-store.test.ts tests/regroups-store.test.ts
```
(Update those 5 store tests in place if needed to `await` the store calls.)

- [ ] **Step 4: Commit atomically**

```bash
git add src/core/ports.ts src/core/contracts/chats.ts src/core/contracts/graph.ts src/store/
git commit -m "feat(store): convert storage ports to async Tauri IPC adapters with in-memory test backend"
```

---

### Task 5: Propagate Async Storage Across `src/core/`, `src/server/`, `src/agent/`, and `app/api/`

**Owned Files:**
- Modify: `src/core/graph.ts`
- Modify: `src/core/graph-deletion.ts`
- Modify: `src/core/layout-settle.ts`
- Modify: `src/server/*.ts` (`stores.ts`, `chats.ts`, `chat-handler.ts`, `turn-service.ts`, `compaction.ts`, `clarify.ts`, `dismissal-park.ts`, `graph.ts`, `commit-positions.ts`, `source-deletion.ts`, `source-organization.ts`, `jobs.ts`, `keys.ts`, `model-catalog.ts`, `observability.ts`, `profiler.ts`, `review.ts`, `search.ts`, `settings-body.ts`, `study.ts`, `file-access.ts`, `claude-code-config.ts`, `cliproxy-config.ts`, `custom-provider.ts`, `custom-provider-auth.ts`, `quaderno.ts`)
- Modify: `src/agent/tools.ts`, `src/agent/tools/*.ts` (`probe.ts`, `practice.ts`, `plan.ts`, `jobs.ts`, `graph.ts`, `show-image.ts`, `read.ts`, `ls.ts`, `find.ts`, `grep.ts`, `pdf-read.ts`, `learner-image.ts`, `file-access.ts`, `fs-shared.ts`)
- Modify: `src/agent/subagents/*.ts` (`extraction.ts`, `runner.ts`, `pdf-ops.ts`, `pdf-reader.ts`)
- Modify: `src/agent/provider-events.ts`, `src/agent/background-capture.ts`, `src/agent/teacher-agent.ts`
- Modify: `app/api/**/route.ts`

**Interfaces:**
- Consumes: Async `Stores` from `src/core/ports.ts` and `src/server/stores.ts`
- Produces: Fully async server services, route handlers, and agent tool executors with zero `node:fs` usage in the Worker path.

- [ ] **Step 1: Update `src/core/{graph,graph-deletion,layout-settle}.ts` to `async`/`await` store reads and writes**

`getGraph`, `graphSnapshot`, `prepareAuditorReview`, `mergeFindings`, `deleteChatTraces`, `deleteSourcesTraces`, `deleteNodeTraces`, and `settleGraphLayout` become `async` functions awaiting `graphStore` and `chatStore`.

- [ ] **Step 2: Update `src/server/*.ts` and `app/api/**/route.ts` to `await` store and `effectiveSettings()` calls**

- `effectiveSettings()` in `src/server/stores.ts` becomes `export async function effectiveSettings(): Promise<EffectiveSettings>`.
- `readReview()` in `src/server/review.ts` uses `stores.graphStore.readPracticeHistory()` and syncs materialized `fsrs_cards` via `stores.graphStore.syncFsrsCards(...)` without loading full chat transcripts.
- `readProfilerState()` / `writeProfilerState()` in `src/server/profiler.ts` use `lh_kv_get("profiler_state")` / `lh_kv_set("profiler_state", ...)` instead of `node:fs`.
- `provider-events.ts` and `background-capture.ts` use `getHostBridge().writeDebugLog(...)` when in Tauri, falling back to `node:fs` only in Node tests.
- Learner file tools (`fs-shared.ts`, `read.ts`, `ls.ts`, `find.ts`, `grep.ts`, `quaderno.ts`) use `getHostBridge()` external file commands when running in Tauri Worker.

- [ ] **Step 3: Update `GET /api/chats` (`app/api/chats/route.ts`) and `components/sidebar.tsx` for FTS5 search (`?q=...`)**

- In `app/api/chats/route.ts`, if `url.searchParams.get("q")` is non-empty, call `stores.chatStore.searchChats(q)` and `stores.graphStore.searchNodes(q)` to include sessions matching on title, transcript snippet, or proposition statement/name/alias.
- In `components/sidebar.tsx`, fetch `/api/chats?q=${encodeURIComponent(q)}` (debounced 150ms) when `query.trim()` is non-empty and display the matched snippet or proposition under the session title when present.

- [ ] **Step 4: Run typecheck and linter**

Run:
```bash
npm run typecheck
npm run lint
```
Expected: 0 errors.

- [ ] **Step 5: Commit atomically**

```bash
git add src/core/ src/server/ src/agent/ app/api/ components/sidebar.tsx
git commit -m "feat(server): wire async SQLite stores, FSRS materialization, and FTS5 sidebar search"
```

---

### Task 6: Delete `memfs` (`src/worker/shims/fs.ts`), Clean Up Worker Boot & Vite Config, and Update Test Suite

**Owned Files:**
- Delete: `src/worker/shims/fs.ts`
- Delete: `src/worker/shims/fs-promises.ts`
- Modify: `src/worker/entry.ts`
- Modify: `src/worker/vite-dev-bridge.ts`
- Modify: `vite.config.ts`
- Modify: `tests/**/*.test.ts` and `tests/**/*.test.tsx`

**Interfaces:**
- Consumes: `HostBridge.initRuntime()` in `src/worker/entry.ts`
- Produces: Worker boot with zero `hydrateMemfs` / `flushFsQueue`, `vite.config.ts` with no `node:fs` shim alias, and all TypeScript tests updated to `await` async store operations and reset via `resetMemoryStores()`.

- [ ] **Step 1: Delete `src/worker/shims/fs.ts` and `src/worker/shims/fs-promises.ts` and update `src/worker/entry.ts` & `vite.config.ts`**

- In `src/worker/entry.ts`:
  - Remove `hydrateMemfs`, `ensureParentDirs`, `getInternalFiles`, `normalizeFsPath` imports.
  - In `ensureWorkerBooted()`, call `const init = await bridge.initRuntime(); setWorkerHomeDir(init.homeDir);` and initialize auth/custom provider.
- In `vite.config.ts`:
  - Remove the 4 alias lines mapping `node:fs`, `fs`, `node:fs/promises`, `fs/promises` to `src/worker/shims/fs*.ts`.
  - Remove the obsolete `profiler-review-compat` plugin if no longer needed.
- In `src/worker/vite-dev-bridge.ts`:
  - Remove `/__lh_dev/fs-hydrate` and `/__lh_dev/fs-sync`.

- [ ] **Step 2: Update `tests/*.test.ts` and `tests/*.test.tsx` for async store calls and `resetMemoryStores()`**

Update test files that call `chatStore`, `graphStore`, `jobStore`, `settingsStore`, `studyStore`, `sourceOrganizationStore`, `promptOverrides`, `authStore`, `effectiveSettings`, `getGraph`, `graphSnapshot`, `readReview`, etc., to `await` the returned promises, and delete obsolete tests that only tested `atomic-write.ts` or `lh_fs_hydrate`/`lh_fs_sync`.

- [ ] **Step 3: Run full verification suite (`cargo test`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run vite:build`)**

Run:
```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run typecheck
npm run lint
npm test
npm run vite:build
```
Expected: All Rust and TypeScript tests pass, 0 typecheck/lint/clippy errors, and `npm run vite:build` succeeds with `src/worker/shims/fs.ts` completely gone.

- [ ] **Step 4: Commit atomically**

```bash
git add -u src/worker/ vite.config.ts tests/
git commit -m "refactor(worker): remove memfs and write-behind fs bridge and update test suite for async stores"
```
