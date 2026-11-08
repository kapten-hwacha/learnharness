# Rust SQLite Storage & Persistence Engine — Design Specification

**Date:** 2026-11-08  
**Status:** Approved  
**Topic:** Replace the Web Worker virtual filesystem (`src/worker/shims/fs.ts`), write-behind IPC bridge (`lh_fs_hydrate` / `lh_fs_sync`), and raw JSON/JSONL file stores with a structured Rust SQLite engine (`rusqlite`), native FTS5 full-text search, and indexed FSRS/graph tables.

---

## 1. Context & Problem Statement

Previously, persistence in the Tauri desktop/iOS architecture relied on a fragile three-hop virtual filesystem emulation (`memfs` in `src/worker/shims/fs.ts`):
1. On Worker boot, `lh_fs_hydrate` read the entire `data/` directory and `auth.json` from disk, Base64-encoded every file, and hydrated an in-memory `Map<string, Uint8Array>` inside the Web Worker.
2. Every store write (`fs.writeFileSync`, `fs.appendFileSync`, `fs.renameSync`) mutated the Worker's in-memory map synchronously and queued an asynchronous Base64 `FsMutationOp` (`lh_fs_sync`) over `MessagePort` → main thread → Tauri IPC → Rust `fs_bridge::apply_op`.
3. `listChats()` and `readPracticeHistory()` (`GET /api/review`) parsed the full JSON transcripts of every session ever created just to compute sidebar summaries, teach seed ratings, and FSRS due dates.
4. Dev mode vs. production path boundaries had to be synchronized across `config.ts`, `src/worker/shims/fs.ts`, and `src-tauri/src/fs_bridge.rs`.

### Architectural Decisions (Locked in Design Q&A)
1. **Asynchronous `src/core/ports.ts` end-to-end:** All storage port interfaces (`ChatStore`, `GraphStore`, `JobStore`, `SettingsStore`, `StudyStore`, `SourceOrganizationStore`, `PromptOverrideStore`, `AuthStore`) become `Promise`-based (`async`) so the Worker calls structured Rust SQLite Tauri commands on demand with zero Worker-side storage cache.
2. **Tauri is the sole application runtime:**
   - **Production / Dev App (`tauri dev` / `tauri build`):** `src/store/*` adapters invoke Rust Tauri commands (`lh_*`) backed by `rusqlite` (`bundled`, WAL mode).
   - **Rust Tests (`cargo test`):** Exercise the real SQLite schema, migrations, atomic transactions, FTS5 ranking, FSRS indexing, and external path security guards directly.
   - **TypeScript Tests (`npm test` via `tsx --test`):** Use a fast, deterministic in-memory implementation of the async `Stores` (`src/store/memory.ts`) without temp-dir filesystem churn, plus unit tests for the Tauri IPC store adapters.
3. **100% Removal of `memfs` (`src/worker/shims/fs.ts` & `fs-promises.ts`):**
   - Static markdown assets (`src/agent/system-prompt.md`, `src/agent/prompts/**/*.md`, `src/agent/skills/*/SKILL.md`) are loaded via a build-time/universal asset bundle (`src/agent/bundled-assets.ts`).
   - Profiler state (`profiler-state.json`) moves into SQLite (`kv_documents`).
   - Learner external file tools (`read`, `ls`, `find`, `grep`, `pdf_read`, `learner_image`, `quaderno`) and opt-in debug recorders (`provider-events.ts`, `background-capture.ts`) route through explicit, path-guarded Rust Tauri commands.
4. **Automatic First-Boot Migration & `auth.json` Isolation:**
   - On startup, if `learnharness.db` is at `PRAGMA user_version == 0` and legacy `data/` JSON/JSONL files exist on disk, Rust atomically migrates them into SQLite in a single transaction and sets `PRAGMA user_version = 1`.
   - `auth.json` (and `*-credentials.json`) remain isolated `0600` files in `user_data_dir`, accessed exclusively through `lh_auth_read` / `lh_auth_write` Tauri commands.
5. **Materialized FSRS + Practice Records + Chat Metadata + FTS5:**
   - `chats` stores indexed metadata columns (`kind`, `updated_at`, `message_count`, `phase`, `pending_question`, `pending_problem`, `seed_rating`) alongside `messages_json` and a separate `chat_image_snapshots` table.
   - `practice_records` and `fsrs_cards` (indexed on `due_at_ms`) are persisted on chat/graph writes so `/api/review` and `listChats()` never parse session transcripts.
   - FTS5 virtual tables (`chats_fts` and `nodes_fts`) index session titles, transcript text, and proposition names/statements/aliases, surfaced both on the storage ports (`searchChats`, `searchNodes`) and in the sidebar search UI (`components/sidebar.tsx`).

---

## 2. Rust SQLite Architecture (`src-tauri/src/storage/`)

### 2.1 Dependencies & Connection Management
- Add `rusqlite = { version = "0.32", features = ["bundled"] }` to `src-tauri/Cargo.toml`.
- Managed Tauri state: `pub struct DbState(pub Arc<Mutex<rusqlite::Connection>>);` plus resolved `AppDirs { data_dir: PathBuf, auth_file: PathBuf, user_data_dir: PathBuf, db_path: PathBuf }`.
- Connection initialization pragmas:
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  ```

### 2.2 Module Layout in `src-tauri/src/`
- `src-tauri/src/storage/mod.rs`: `DbState`, `init_storage(app)`, connection helper, `lh_runtime_init`.
- `src-tauri/src/storage/schema.rs`: DDL creation (`CREATE TABLE IF NOT EXISTS ...`, FTS5 virtual tables, indexes) and `PRAGMA user_version` management.
- `src-tauri/src/storage/migrate.rs`: One-time importer from legacy `<data_dir>` JSON/JSONL files into SQLite when `user_version == 0`.
- `src-tauri/src/storage/chats.rs`: `lh_save_chat`, `lh_load_chat`, `lh_list_chats`, `lh_save_chat_image`, `lh_delete_chat`, `lh_search_chats`.
- `src-tauri/src/storage/graph.rs`: `lh_graph_*` ledger/source/position commands, `lh_search_nodes`, `lh_read_practice_history`, `lh_upsert_fsrs_cards`, `lh_read_fsrs_cards`.
- `src-tauri/src/storage/jobs.rs`: `lh_job_save`, `lh_job_get`, `lh_job_list`, `lh_job_find_by_tool_call`, `lh_job_delete_for_chat`.
- `src-tauri/src/storage/kv.rs`: `lh_kv_get`, `lh_kv_set`, `lh_study_read_intervals`, `lh_study_append_intervals`, `lh_prompt_override_*`, `lh_auth_read`, `lh_auth_write`.
- `src-tauri/src/fs_bridge.rs`: Retains **only** external learner file commands (`lh_fs_read_external`, `lh_fs_stat_external`, `lh_fs_list_external_dir`, `lh_fs_walk_external`, `lh_quaderno_write_pdf`, `lh_quaderno_list_pdfs`, `lh_debug_write`) and path-security validators (`validate_external_read_path`). `lh_fs_hydrate` and `lh_fs_sync` are removed.

### 2.3 SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS chats (
    id                  TEXT PRIMARY KEY,
    version             INTEGER NOT NULL,
    title               TEXT NOT NULL,
    kind                TEXT NOT NULL DEFAULT 'teach',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    message_count       INTEGER NOT NULL DEFAULT 0,
    phase               TEXT NOT NULL DEFAULT 'probe',
    pending_question    INTEGER NOT NULL DEFAULT 0,
    pending_problem     INTEGER NOT NULL DEFAULT 0,
    seed_rating         INTEGER NOT NULL DEFAULT 3,
    messages_json       TEXT NOT NULL DEFAULT '[]',
    tree_json           TEXT,
    settings_json       TEXT,
    turns_json          TEXT,
    extractions_json    TEXT,
    clarifications_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_kind ON chats(kind);

CREATE TABLE IF NOT EXISTS chat_image_snapshots (
    chat_id      TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    snapshot_id  TEXT NOT NULL,
    mime_type    TEXT NOT NULL,
    data_base64  TEXT NOT NULL,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    PRIMARY KEY (chat_id, snapshot_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(
    chat_id UNINDEXED,
    title,
    transcript_text,
    tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS practice_records (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    at_ms        INTEGER NOT NULL,
    targets_json TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    rung         TEXT,
    miss_class   TEXT,
    missed_json  TEXT,
    rating       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_practice_records_chat ON practice_records(chat_id);
CREATE INDEX IF NOT EXISTS idx_practice_records_at ON practice_records(at_ms ASC);

CREATE TABLE IF NOT EXISTS fsrs_cards (
    node_id        TEXT PRIMARY KEY,
    stability      REAL,
    difficulty     REAL,
    last_review_ms INTEGER,
    reviews        INTEGER NOT NULL DEFAULT 0,
    due_at_ms      REAL NOT NULL,
    lane           TEXT NOT NULL,
    seed_rating    INTEGER NOT NULL DEFAULT 3,
    stage          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fsrs_cards_due_at ON fsrs_cards(due_at_ms ASC);

CREATE TABLE IF NOT EXISTS graph_nodes (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL,
    name            TEXT NOT NULL,
    statement       TEXT NOT NULL,
    aliases_json    TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    provenance_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_id ON graph_nodes(id);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    node_id UNINDEXED,
    name,
    statement,
    aliases_text,
    tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS graph_chains (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL,
    premises_json   TEXT NOT NULL,
    conclusion      TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_chains_conclusion ON graph_chains(conclusion);

CREATE TABLE IF NOT EXISTS graph_checkpoints (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id   TEXT NOT NULL,
    folded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_checkpoints_chat ON graph_checkpoints(chat_id);

CREATE TABLE IF NOT EXISTS graph_coverage (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id   TEXT NOT NULL,
    fp        TEXT NOT NULL,
    tokens    INTEGER NOT NULL,
    folded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_coverage_chat ON graph_coverage(chat_id);

CREATE TABLE IF NOT EXISTS graph_regroups (
    seq               INTEGER PRIMARY KEY AUTOINCREMENT,
    id                TEXT NOT NULL,
    node_id           TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    reason            TEXT NOT NULL,
    regrouped_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_sources (
    id               TEXT PRIMARY KEY,
    file_path        TEXT NOT NULL,
    imported_at      TEXT NOT NULL,
    extractions_json TEXT
);

CREATE TABLE IF NOT EXISTS graph_positions (
    node_id TEXT PRIMARY KEY,
    x       REAL NOT NULL,
    y       REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    chat_id      TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    status       TEXT NOT NULL,
    activity     TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    record_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_chat_updated ON jobs(chat_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_chat_tool ON jobs(chat_id, tool_call_id);

CREATE TABLE IF NOT EXISTS study_intervals (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT NOT NULL,
    start_iso  TEXT NOT NULL,
    end_iso    TEXT NOT NULL,
    end_reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_overrides (
    segment_path TEXT PRIMARY KEY,
    content      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv_documents (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
```

---

## 3. TypeScript Port & Store Layer (`src/core/ports.ts` & `src/store/`)

### 3.1 Asynchronous `src/core/ports.ts`
Every port method returns a `Promise` (or `Promise<T> | T` where helpful during transition, pinned to `Promise<T>` on the canonical interfaces):
- `ChatStore`:
  - `createChat(title: string, kind?: "practice"): Promise<ChatRecord>`
  - `getChat(id: string): Promise<ChatRecord | null>`
  - `listChats(): Promise<ChatSummary[]>`
  - `searchChats(query: string, limit?: number): Promise<ChatSearchHit[]>`
  - `saveMessages(id: string, messages: LhMessage[]): Promise<void>`
  - `saveImageSnapshot(id: string, snapshotId: string, image: ImageSnapshot): Promise<void>`
  - `saveTree(id: string, tree: PlanTree): Promise<void>`
  - `appendTurnUsage(id: string, entry: TurnUsage): Promise<void>`
  - `appendExtractionUsage(id: string, entry: ExtractionRunUsage): Promise<void>`
  - `appendClarification(id: string, toolCallId: string, exchange: ClarifyExchange): Promise<ClarifyExchange[]>`
  - `saveSettings(id: string, settings: ChatSettings): Promise<void>`
  - `renameChat(id: string, title: string): Promise<ChatRecord>`
  - `deleteChat(id: string): Promise<boolean>`
- `GraphStore`:
  - All existing methods become `async` (`Promise`-returning).
  - Add `searchNodes(query: string, limit?: number): Promise<NodeSearchHit[]>`.
  - Add `readPracticeHistory(): Promise<PracticeHistory>` and `syncFsrsCards(cards: FsrsCardRow[]): Promise<void>` / `readFsrsCards(): Promise<FsrsCardRow[]>`.
  - Add `revision(): Promise<number>` (replaces `fs.statSync` in `src/server/graph.ts`).
- `JobStore`, `SettingsStore`, `StudyStore`, `SourceOrganizationStore`, `PromptOverrideStore`, `AuthStore`:
  - All methods become `async` (`Promise`-returning).

### 3.2 Tauri IPC vs. In-Memory Test Adapter (`src/store/`)
- When `getTauriInvoke()` is available, `src/store/*` delegates every call to the corresponding `lh_*` Tauri command.
- When `getTauriInvoke()` is null (e.g., `npm test` running under Node `tsx --test`), `src/store/*` delegates to an in-memory backing store (`src/store/memory-backend.ts`) that implements the exact same semantics (including FTS substring/token matching, practice record extraction, and atomic resets via `resetMemoryStores()`).

---

## 4. Static Asset Bundling & External Learner Files

### 4.1 Bundled Prompts & Skills (`src/agent/bundled-assets.ts`)
- Uses Vite's `import.meta.glob` (when present) with a Node `fs` fallback (only when `process.versions.node` is defined in `tsx` tests) to load:
  - `src/agent/system-prompt.md`
  - `src/agent/prompts/{prober,teacher,practice,shared}/*.md`
  - `src/agent/skills/*/SKILL.md`
- Removes all runtime `node:fs` dependencies from `src/agent/prompt-segments.ts` and `src/agent/tools/skill.ts`.

### 4.2 Learner External File Bridge (`src/agent/tools/fs-shared.ts` & `src-tauri/src/fs_bridge.ts`)
- `lh_fs_read_external(path)`: Validates path via `validate_external_read_path` (reading `fileAccess` settings from SQLite `kv_documents` `'settings'` key) and returns file bytes.
- `lh_fs_stat_external(path)`: Validates path and returns `{ isFile, isDirectory, size, mtimeMs }`.
- `lh_fs_list_external_dir(path)`: Validates directory path and returns `Vec<{ name, isFile, isDirectory, size }>`, filtering out sensitive paths.
- `lh_fs_walk_external(root, maxFiles, timeoutMs)`: Performs the bounded depth-first walk in Rust (respecting `EXCLUDED_DIR_NAMES`, `SENSITIVE_HOME_PATHS`, and `fileAccess` policy) so `find` and `grep` work natively in Tauri without `memfs`.

### 4.3 Sidebar Full-Text Search (`GET /api/chats?q=...` & `components/sidebar.tsx`)
- `GET /api/chats` accepts an optional `?q=<query>` parameter.
- When `q` is provided, the server queries `chatStore.searchChats(q)` and `graphStore.searchNodes(q)`, combining title fuzzy matches, FTS5 transcript matches (with snippet), and sessions whose extracted propositions match `q`.
- `components/sidebar.tsx` debounces non-empty `query` fetches against `/api/chats?q=...` while keeping instant local `fuzzyScore` filtering for zero-latency responsiveness.

---

## 5. Verification & Acceptance Criteria
1. `src/worker/shims/fs.ts`, `src/worker/shims/fs-promises.ts`, `src/store/atomic-write.ts`, and `src/store/graph-format.ts` are deleted; `vite.config.ts` has no `node:fs` or `fs` alias.
2. `cargo test --manifest-path src-tauri/Cargo.toml` passes all unit and integration tests for SQLite schema, legacy JSON/JSONL migration, chat/graph/job/study/settings/prompt/auth persistence, FSRS materialization, FTS5 search, and external file security guards.
3. `npm test`, `npm run typecheck`, `npm run lint`, and `npm run vite:build` pass with zero errors.
