pub mod migrate;
pub mod schema;

use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct DbState {
    pub conn: Arc<Mutex<Connection>>,
    pub data_dir: PathBuf,
    pub auth_file: PathBuf,
    pub user_data_dir: PathBuf,
}

pub fn open_and_init_db(
    db_path: &Path,
    data_dir: &Path,
    auth_file: &Path,
    user_data_dir: &Path,
) -> Result<DbState, String> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create database directory {}: {e}",
                parent.display()
            )
        })?;
    }

    let mut conn = Connection::open(db_path)
        .map_err(|e| format!("Failed to open SQLite database {}: {e}", db_path.display()))?;

    // Spec §2.1 Connection Pragmas
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        "#,
    )
    .map_err(|e| format!("Failed to set database pragmas: {e}"))?;

    schema::init_schema(&mut conn)?;
    migrate::migrate_legacy_data_if_needed(&mut conn, data_dir, auth_file, user_data_dir)?;

    Ok(DbState {
        conn: Arc::new(Mutex::new(conn)),
        data_dir: data_dir.to_path_buf(),
        auth_file: auth_file.to_path_buf(),
        user_data_dir: user_data_dir.to_path_buf(),
    })
}

pub fn init_storage(app: &tauri::AppHandle) -> Result<DbState, String> {
    let (data_dir, auth_file, user_data_dir) = crate::fs_bridge::resolve_app_dirs(app);
    let db_path = user_data_dir.join("learnharness.db");
    open_and_init_db(&db_path, &data_dir, &auth_file, &user_data_dir)
}

pub fn sanitize_fts5_query(raw: &str) -> Option<String> {
    let mut tokens = Vec::new();
    for word in raw.split_whitespace() {
        let clean: String = word.chars().filter(|c| c.is_alphanumeric()).collect();
        if !clean.is_empty() {
            tokens.push(format!("\"{clean}\"*"));
        }
    }
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}

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
        let ver: i32 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
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
        )
        .unwrap();
        fs::write(
            data_dir.join("graph/nodes.jsonl"),
            "{\"id\":\"n1\",\"name\":\"Node 1\",\"statement\":\"Stmt 1\",\"aliases\":[\"a1\"],\"createdAt\":\"2026-10-01T00:00:00Z\",\"provenance\":[{\"chatId\":\"chat_1\",\"messageId\":\"m1\"}]}\ncorrupt_line\n",
        )
        .unwrap();
        fs::write(
            data_dir.join("settings.json"),
            r#"{"version":1,"general":{"autoUpdate":false}}"#,
        )
        .unwrap();

        let db_path = tmp.join("learnharness.db");
        let auth_file = tmp.join("auth.json");
        let state = open_and_init_db(&db_path, &data_dir, &auth_file, &tmp).unwrap();
        let conn = state.conn.lock().unwrap();

        let chat_title: String = conn
            .query_row("SELECT title FROM chats WHERE id = 'chat_1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(chat_title, "Test Chat");

        let node_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM graph_nodes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(node_count, 1);

        let settings_raw: String = conn
            .query_row(
                "SELECT value_json FROM kv_documents WHERE key = 'settings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(settings_raw.contains("autoUpdate"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn sanitizes_fts5_queries_safely() {
        assert_eq!(
            sanitize_fts5_query("hello world"),
            Some("\"hello\"* \"world\"*".to_string())
        );
        assert_eq!(
            sanitize_fts5_query("foo\"bar: (baz) -qux"),
            Some("\"foobar\"* \"baz\"* \"qux\"*".to_string())
        );
        assert_eq!(sanitize_fts5_query("   "), None);
    }

    #[test]
    fn migrates_comprehensive_legacy_store_files() {
        let tmp = std::env::temp_dir().join(format!("lh_sql_mig_comp_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let data_dir = tmp.join("data");
        let user_data_dir = tmp.join("user_data");
        fs::create_dir_all(data_dir.join("chats")).unwrap();
        fs::create_dir_all(data_dir.join("graph")).unwrap();
        fs::create_dir_all(data_dir.join("jobs")).unwrap();
        fs::create_dir_all(data_dir.join("study")).unwrap();
        fs::create_dir_all(data_dir.join("prompts/sub")).unwrap();
        fs::create_dir_all(&user_data_dir).unwrap();

        // 1. Chat with image snapshots and practice records
        fs::write(
            data_dir.join("chats/chat_2.json"),
            r#"{
                "id": "chat_2",
                "version": 1,
                "title": "Quantum Mechanics",
                "kind": "teach",
                "createdAt": "2026-10-01T00:00:00Z",
                "updatedAt": "2026-10-01T01:00:00Z",
                "messages": [
                    {
                        "role": "assistant",
                        "timestamp": 1700000000000,
                        "content": [
                            {
                                "type": "toolCall",
                                "name": "problem",
                                "id": "tc_prob1",
                                "arguments": { "target": ["node_qm_1"] }
                            }
                        ]
                    },
                    {
                        "role": "toolResult",
                        "toolCallId": "tc_prob1",
                        "isError": false,
                        "content": []
                    },
                    {
                        "role": "assistant",
                        "timestamp": 1700000010000,
                        "content": [
                            {
                                "type": "toolCall",
                                "name": "conclude",
                                "id": "tc_conc1",
                                "arguments": {
                                    "outcome": "solved",
                                    "rating": 4
                                }
                            }
                        ]
                    },
                    {
                        "role": "toolResult",
                        "toolCallId": "tc_conc1",
                        "isError": false,
                        "content": []
                    }
                ],
                "imageSnapshots": {
                    "snap1": {
                        "mimeType": "image/png",
                        "data": "aW1hZ2VkYXRh",
                        "width": 800,
                        "height": 600
                    }
                }
            }"#,
        )
        .unwrap();

        // 2. Graph ledgers
        fs::write(
            data_dir.join("graph/nodes.jsonl"),
            "{\"id\":\"node_qm_1\",\"name\":\"Wave Function\",\"statement\":\"Psi represents quantum state\",\"aliases\":[\"psi\"],\"createdAt\":\"2026-10-01T00:00:00Z\",\"provenance\":[{\"chatId\":\"chat_2\",\"messageId\":\"m1\"}]}\n",
        )
        .unwrap();
        fs::write(
            data_dir.join("graph/chains.jsonl"),
            "{\"id\":\"chain_1\",\"premises\":[\"node_qm_1\"],\"conclusion\":\"node_qm_2\",\"provenance\":[{\"chatId\":\"chat_2\",\"messageId\":\"m2\"}],\"createdAt\":\"2026-10-01T00:00:00Z\"}\n",
        )
        .unwrap();
        fs::write(
            data_dir.join("graph/sessions.jsonl"),
            "{\"chatId\":\"chat_2\",\"foldedAt\":\"2026-10-01T00:00:00Z\"}\n",
        )
        .unwrap();
        fs::write(
            data_dir.join("graph/coverage.jsonl"),
            "{\"chatId\":\"chat_2\",\"fp\":\"fp_1\",\"tokens\":42,\"foldedAt\":\"2026-10-01T00:00:00Z\"}\n",
        )
        .unwrap();
        fs::write(
            data_dir.join("graph/regroups.jsonl"),
            "{\"id\":\"r1\",\"nodeId\":\"node_qm_1\",\"targetSessionId\":\"chat_3\",\"reason\":\"reorganized\",\"regroupedAt\":\"2026-10-01T00:00:00Z\"}\n",
        )
        .unwrap();
        fs::write(
            data_dir.join("graph/sources.json"),
            "{\"src_1\":{\"id\":\"src_1\",\"filePath\":\"/path/to/notes.md\",\"importedAt\":\"2026-10-01T00:00:00Z\"}}",
        )
        .unwrap();
        fs::write(
            data_dir.join("graph/positions.json"),
            "{\"node_qm_1\":{\"x\":120.5,\"y\":240.5}}",
        )
        .unwrap();

        // 3. Jobs
        fs::write(
            data_dir.join("jobs/job_1.json"),
            r#"{"id":"job_1","kind":"extractor","chatId":"chat_2","toolCallId":"tc_ext1","status":"completed","activity":"done","createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z"}"#,
        )
        .unwrap();

        // 4. Study intervals & open
        fs::write(
            data_dir.join("study/intervals.jsonl"),
            "{\"v\":1,\"chatId\":\"chat_2\",\"start\":\"2026-10-01T00:00:00Z\",\"end\":\"2026-10-01T01:00:00Z\",\"endReason\":\"stop\"}\n",
        )
        .unwrap();
        fs::write(
            data_dir.join("study/open.json"),
            "{\"v\":1,\"timers\":{\"chat_2\":{\"start\":\"2026-10-01T01:00:00Z\"}}}",
        )
        .unwrap();
        fs::write(data_dir.join("study.json"), "{\"topics\":[\"quantum\"]}").unwrap();

        // 5. Prompts
        fs::write(
            data_dir.join("prompts/system-prompt.md"),
            "# Custom System Prompt",
        )
        .unwrap();
        fs::write(data_dir.join("prompts/sub/custom.md"), "# Sub prompt").unwrap();
        fs::write(
            data_dir.join("prompt-overrides.json"),
            r##"{"extra/override.md":"# Extra"}"##,
        )
        .unwrap();

        // 6. Settings, render-settings, source-organization, profiler-state
        fs::write(data_dir.join("render-settings.json"), r#"{"zoom":1.5}"#).unwrap();
        fs::write(
            data_dir.join("source-organization.json"),
            r#"{"folders":[]}"#,
        )
        .unwrap();
        fs::write(data_dir.join("profiler-state.json"), r#"{"probes":1}"#).unwrap();

        // 7. Auth file and credentials in data_dir
        fs::write(
            data_dir.join("auth.json"),
            r#"{"OPENAI_API_KEY":"sk-test"}"#,
        )
        .unwrap();
        fs::write(
            data_dir.join("custom-credentials.json"),
            r#"{"secret":"val"}"#,
        )
        .unwrap();

        let db_path = user_data_dir.join("learnharness.db");
        let auth_file = user_data_dir.join("auth.json");

        let state = open_and_init_db(&db_path, &data_dir, &auth_file, &user_data_dir).unwrap();
        let conn = state.conn.lock().unwrap();

        // Verify FTS5 chat search
        let fts_chat: String = conn
            .query_row(
                "SELECT chat_id FROM chats_fts WHERE chats_fts MATCH '\"Quantum\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fts_chat, "chat_2");

        // Verify image snapshot
        let img_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chat_image_snapshots WHERE chat_id = 'chat_2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(img_count, 1);

        // Verify practice record
        let outcome: String = conn
            .query_row(
                "SELECT outcome FROM practice_records WHERE chat_id = 'chat_2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(outcome, "solved");

        // Verify FSRS card materialization
        let fsrs_node: String = conn
            .query_row(
                "SELECT node_id FROM fsrs_cards WHERE node_id = 'node_qm_1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fsrs_node, "node_qm_1");

        // Verify node FTS5
        let fts_node: String = conn
            .query_row(
                "SELECT node_id FROM nodes_fts WHERE nodes_fts MATCH '\"Wave\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fts_node, "node_qm_1");

        // Verify chains, checkpoints, coverage, regroups, sources, positions
        let chain_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM graph_chains", [], |r| r.get(0))
            .unwrap();
        assert_eq!(chain_count, 1);
        let cp_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM graph_checkpoints", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cp_count, 1);
        let cov_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM graph_coverage", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cov_count, 1);
        let reg_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM graph_regroups", [], |r| r.get(0))
            .unwrap();
        assert_eq!(reg_count, 1);
        let src_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM graph_sources", [], |r| r.get(0))
            .unwrap();
        assert_eq!(src_count, 1);
        let pos_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM graph_positions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pos_count, 1);

        // Verify jobs
        let job_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM jobs WHERE id = 'job_1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(job_count, 1);

        // Verify study intervals, study materials
        let interval_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM study_intervals", [], |r| r.get(0))
            .unwrap();
        assert_eq!(interval_count, 1);
        let study_mat_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM study_materials", [], |r| r.get(0))
            .unwrap();
        assert_eq!(study_mat_count, 1);

        // Verify prompt overrides
        let prompt_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM prompt_overrides", [], |r| r.get(0))
            .unwrap();
        assert_eq!(prompt_count, 3);

        // Verify kv_documents
        let render_val: String = conn
            .query_row(
                "SELECT value_json FROM kv_documents WHERE key = 'render_settings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(render_val.contains("1.5"));

        // Verify auth and credentials copied to user_data_dir, mode 0600 on Unix, and originals untouched in data_dir
        assert!(auth_file.exists());
        assert!(data_dir.join("auth.json").exists());
        assert!(data_dir.join("custom-credentials.json").exists());
        assert!(user_data_dir.join("custom-credentials.json").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = fs::metadata(&auth_file).unwrap();
            assert_eq!(meta.permissions().mode() & 0o777, 0o600);
            let cred_meta = fs::metadata(user_data_dir.join("custom-credentials.json")).unwrap();
            assert_eq!(cred_meta.permissions().mode() & 0o777, 0o600);
        }

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn preserves_legacy_auth_and_credentials_files_without_deletion() {
        let tmp = std::env::temp_dir().join(format!("lh_sql_auth_nodel_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let data_dir = tmp.join("data");
        let user_data_dir = tmp.join("user_data");
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(&user_data_dir).unwrap();

        let original_auth_content = r#"{"ANTHROPIC_API_KEY":"sk-ant-test"}"#;
        let original_cred_content = r#"{"token":"test-token"}"#;
        fs::write(data_dir.join("auth.json"), original_auth_content).unwrap();
        fs::write(
            data_dir.join("chatgpt-credentials.json"),
            original_cred_content,
        )
        .unwrap();

        let db_path = user_data_dir.join("learnharness.db");
        let auth_file = user_data_dir.join("auth.json");

        let _state = open_and_init_db(&db_path, &data_dir, &auth_file, &user_data_dir).unwrap();

        // 1. Originals MUST remain untouched in data_dir
        assert!(data_dir.join("auth.json").exists());
        assert_eq!(
            fs::read_to_string(data_dir.join("auth.json")).unwrap(),
            original_auth_content
        );
        assert!(data_dir.join("chatgpt-credentials.json").exists());
        assert_eq!(
            fs::read_to_string(data_dir.join("chatgpt-credentials.json")).unwrap(),
            original_cred_content
        );

        // 2. Copies must exist in user_data_dir with 0600 on Unix
        assert!(auth_file.exists());
        assert_eq!(
            fs::read_to_string(&auth_file).unwrap(),
            original_auth_content
        );
        assert!(user_data_dir.join("chatgpt-credentials.json").exists());
        assert_eq!(
            fs::read_to_string(user_data_dir.join("chatgpt-credentials.json")).unwrap(),
            original_cred_content
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta_auth = fs::metadata(&auth_file).unwrap();
            assert_eq!(meta_auth.permissions().mode() & 0o777, 0o600);
            let meta_cred = fs::metadata(user_data_dir.join("chatgpt-credentials.json")).unwrap();
            assert_eq!(meta_cred.permissions().mode() & 0o777, 0o600);
        }

        let _ = fs::remove_dir_all(&tmp);
    }
}
