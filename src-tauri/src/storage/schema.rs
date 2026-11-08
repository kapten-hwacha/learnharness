use rusqlite::Connection;

pub const SCHEMA_DDL: &str = r#"
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

CREATE TABLE IF NOT EXISTS graph_events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    event_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_materials (
    id           TEXT PRIMARY KEY,
    content_json TEXT NOT NULL
);
"#;

pub fn init_schema(conn: &mut Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA_DDL)
        .map_err(|e| format!("Failed to initialize SQLite schema: {e}"))
}
