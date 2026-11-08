use crate::storage::DbState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatListItem {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: i64,
    pub phase: String,
    pub pending_question: bool,
    pub pending_problem: bool,
    pub seed_rating: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchHit {
    pub chat_id: String,
    pub title: String,
    pub snippet: String,
}

pub fn list_chats(conn: &Connection) -> Result<Vec<ChatListItem>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, title, kind, created_at, updated_at, message_count,
                   phase, pending_question, pending_problem, seed_rating
            FROM chats
            ORDER BY updated_at DESC
            "#,
        )
        .map_err(|e| format!("Failed to prepare list_chats: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let kind: String = row.get(2)?;
            let created_at: String = row.get(3)?;
            let updated_at: String = row.get(4)?;
            let message_count: i64 = row.get(5)?;
            let phase: String = row.get(6)?;
            let pending_question: i64 = row.get(7)?;
            let pending_problem: i64 = row.get(8)?;
            let seed_rating: i64 = row.get(9)?;

            Ok(ChatListItem {
                id,
                title,
                kind,
                created_at,
                updated_at,
                message_count,
                phase,
                pending_question: pending_question != 0,
                pending_problem: pending_problem != 0,
                seed_rating,
            })
        })
        .map_err(|e| format!("Failed to query chats: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Failed to read chat row: {e}"))?);
    }
    Ok(out)
}

pub fn load_chat(conn: &Connection, chat_id: &str) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, version, title, kind, created_at, updated_at,
                   messages_json, tree_json, settings_json, turns_json,
                   extractions_json, clarifications_json
            FROM chats
            WHERE id = ?1
            "#,
        )
        .map_err(|e| format!("Failed to prepare load_chat: {e}"))?;

    let mut rows = stmt
        .query_map(params![chat_id], |row| {
            let id: String = row.get(0)?;
            let version: i64 = row.get(1)?;
            let title: String = row.get(2)?;
            let kind: String = row.get(3)?;
            let created_at: String = row.get(4)?;
            let updated_at: String = row.get(5)?;
            let messages_json: String = row.get(6)?;
            let tree_json: Option<String> = row.get(7)?;
            let settings_json: Option<String> = row.get(8)?;
            let turns_json: Option<String> = row.get(9)?;
            let extractions_json: Option<String> = row.get(10)?;
            let clarifications_json: Option<String> = row.get(11)?;

            Ok((
                id,
                version,
                title,
                kind,
                created_at,
                updated_at,
                messages_json,
                tree_json,
                settings_json,
                turns_json,
                extractions_json,
                clarifications_json,
            ))
        })
        .map_err(|e| format!("Failed to query chat: {e}"))?;

    let row = match rows.next() {
        Some(Ok(r)) => r,
        Some(Err(e)) => return Err(format!("Error loading chat: {e}")),
        None => return Ok(None),
    };

    let (
        id,
        version,
        title,
        kind,
        created_at,
        updated_at,
        messages_json,
        tree_json,
        settings_json,
        turns_json,
        extractions_json,
        clarifications_json,
    ) = row;

    let messages: Value = serde_json::from_str(&messages_json).unwrap_or(Value::Array(vec![]));

    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), Value::String(id));
    map.insert("version".to_string(), Value::Number(version.into()));
    map.insert("title".to_string(), Value::String(title));
    map.insert("kind".to_string(), Value::String(kind));
    map.insert("createdAt".to_string(), Value::String(created_at));
    map.insert("updatedAt".to_string(), Value::String(updated_at));
    map.insert("messages".to_string(), messages);

    if let Some(tj) = tree_json {
        if let Ok(val) = serde_json::from_str::<Value>(&tj) {
            map.insert("tree".to_string(), val);
        }
    }
    if let Some(sj) = settings_json {
        if let Ok(val) = serde_json::from_str::<Value>(&sj) {
            map.insert("settings".to_string(), val);
        }
    }
    if let Some(tj) = turns_json {
        if let Ok(val) = serde_json::from_str::<Value>(&tj) {
            map.insert("turns".to_string(), val);
        }
    }
    if let Some(ej) = extractions_json {
        if let Ok(val) = serde_json::from_str::<Value>(&ej) {
            map.insert("extractions".to_string(), val);
        }
    }
    if let Some(cj) = clarifications_json {
        if let Ok(val) = serde_json::from_str::<Value>(&cj) {
            map.insert("clarifications".to_string(), val);
        }
    }

    // Query snapshots
    let mut snap_stmt = conn
        .prepare(
            r#"
            SELECT snapshot_id, mime_type, data_base64, width, height
            FROM chat_image_snapshots
            WHERE chat_id = ?1
            "#,
        )
        .map_err(|e| format!("Failed to prepare snapshots query: {e}"))?;

    let snap_rows = snap_stmt
        .query_map(params![chat_id], |r| {
            let snap_id: String = r.get(0)?;
            let mime_type: String = r.get(1)?;
            let data_base64: String = r.get(2)?;
            let width: i64 = r.get(3)?;
            let height: i64 = r.get(4)?;
            Ok((snap_id, mime_type, data_base64, width, height))
        })
        .map_err(|e| format!("Failed to query snapshots: {e}"))?;

    let mut snapshots_map = serde_json::Map::new();
    for sr in snap_rows {
        let (snap_id, mime_type, data_base64, width, height) =
            sr.map_err(|e| format!("Failed to read snapshot: {e}"))?;
        snapshots_map.insert(
            snap_id,
            json!({
                "mimeType": mime_type,
                "data": data_base64,
                "width": width,
                "height": height
            }),
        );
    }

    if !snapshots_map.is_empty() {
        map.insert("imageSnapshots".to_string(), Value::Object(snapshots_map));
    }

    Ok(Some(Value::Object(map)))
}

pub fn save_chat(
    conn: &mut Connection,
    chat_id: Option<&str>,
    record: &Value,
) -> Result<(), String> {
    let id = chat_id
        .map(|s| s.to_string())
        .or_else(|| {
            record
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| "Missing chat id in save_chat".to_string())?;

    let version = record.get("version").and_then(|v| v.as_i64()).unwrap_or(1);
    let title = record
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled");
    let kind = record
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("teach");
    let created_at = record
        .get("createdAt")
        .and_then(|v| v.as_str())
        .unwrap_or("2026-10-01T00:00:00Z");
    let updated_at = record
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or("2026-10-01T00:00:00Z");

    let messages = record
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let message_count = messages.len() as i64;
    let phase = crate::storage::migrate::derive_phase(&messages);
    let pending_question = crate::storage::migrate::has_dangling_question(&messages) as i64;
    let pending_problem = crate::storage::migrate::has_active_problem(&messages) as i64;
    let seed_rating = crate::storage::migrate::derive_seed_rating(&messages);
    let messages_json =
        serde_json::to_string(&messages).map_err(|e| format!("Serialization error: {e}"))?;

    let tree_json = record
        .get("tree")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::to_string(v).ok());
    let settings_json = record
        .get("settings")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::to_string(v).ok());
    let turns_json = record
        .get("turns")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::to_string(v).ok());
    let extractions_json = record
        .get("extractions")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::to_string(v).ok());
    let clarifications_json = record
        .get("clarifications")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::to_string(v).ok());

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {e}"))?;

    // 1. Upsert into chats
    tx.execute(
        r#"
        INSERT INTO chats (
            id, version, title, kind, created_at, updated_at, message_count,
            phase, pending_question, pending_problem, seed_rating,
            messages_json, tree_json, settings_json, turns_json, extractions_json, clarifications_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
        ON CONFLICT(id) DO UPDATE SET
            version = excluded.version,
            title = excluded.title,
            kind = excluded.kind,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            message_count = excluded.message_count,
            phase = excluded.phase,
            pending_question = excluded.pending_question,
            pending_problem = excluded.pending_problem,
            seed_rating = excluded.seed_rating,
            messages_json = excluded.messages_json,
            tree_json = excluded.tree_json,
            settings_json = excluded.settings_json,
            turns_json = excluded.turns_json,
            extractions_json = excluded.extractions_json,
            clarifications_json = excluded.clarifications_json
        "#,
        params![
            id,
            version,
            title,
            kind,
            created_at,
            updated_at,
            message_count,
            phase,
            pending_question,
            pending_problem,
            seed_rating,
            messages_json,
            tree_json,
            settings_json,
            turns_json,
            extractions_json,
            clarifications_json
        ],
    )
    .map_err(|e| format!("Failed to upsert chat: {e}"))?;

    // 2. Image snapshots
    if let Some(snaps) = record.get("imageSnapshots").and_then(|v| v.as_object()) {
        for (snap_id, snap_val) in snaps {
            let mime_type = snap_val
                .get("mimeType")
                .and_then(|v| v.as_str())
                .unwrap_or("image/png");
            let data_b64 = snap_val
                .get("data")
                .or_else(|| snap_val.get("dataBase64"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let width = snap_val.get("width").and_then(|v| v.as_i64()).unwrap_or(0);
            let height = snap_val.get("height").and_then(|v| v.as_i64()).unwrap_or(0);

            tx.execute(
                r#"
                INSERT OR REPLACE INTO chat_image_snapshots (
                    chat_id, snapshot_id, mime_type, data_base64, width, height
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params![id, snap_id, mime_type, data_b64, width, height],
            )
            .map_err(|e| format!("Failed to upsert snapshot: {e}"))?;
        }
    }

    // 3. Practice records
    tx.execute(
        "DELETE FROM practice_records WHERE chat_id = ?1",
        params![id],
    )
    .map_err(|e| format!("Failed to clean practice records: {e}"))?;

    let prs = crate::storage::migrate::extract_practice_records(&id, &messages);
    for pr in prs {
        tx.execute(
            r#"
            INSERT INTO practice_records (
                chat_id, at_ms, targets_json, outcome, rung, miss_class, missed_json, rating
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                pr.chat_id,
                pr.at_ms,
                pr.targets_json,
                pr.outcome,
                pr.rung,
                pr.miss_class,
                pr.missed_json,
                pr.rating
            ],
        )
        .map_err(|e| format!("Failed to insert practice record: {e}"))?;
    }

    // 4. FTS5 index
    tx.execute("DELETE FROM chats_fts WHERE chat_id = ?1", params![id])
        .map_err(|e| format!("Failed to clean chats_fts: {e}"))?;

    let transcript = crate::storage::migrate::extract_transcript_text(
        &messages,
        record.get("tree"),
        record.get("extractions"),
    );
    tx.execute(
        "INSERT INTO chats_fts (chat_id, title, transcript_text) VALUES (?1, ?2, ?3)",
        params![id, title, transcript],
    )
    .map_err(|e| format!("Failed to insert chats_fts: {e}"))?;

    // 5. Update FSRS cards
    crate::storage::migrate::materialize_fsrs_cards(&tx)?;

    tx.commit()
        .map_err(|e| format!("Failed to commit save_chat: {e}"))?;

    Ok(())
}

pub fn delete_chat(conn: &mut Connection, chat_id: &str) -> Result<bool, String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {e}"))?;

    tx.execute(
        "DELETE FROM chat_image_snapshots WHERE chat_id = ?1",
        params![chat_id],
    )
    .map_err(|e| format!("Failed to delete snapshots: {e}"))?;

    tx.execute(
        "DELETE FROM practice_records WHERE chat_id = ?1",
        params![chat_id],
    )
    .map_err(|e| format!("Failed to delete practice records: {e}"))?;

    tx.execute("DELETE FROM chats_fts WHERE chat_id = ?1", params![chat_id])
        .map_err(|e| format!("Failed to delete chats_fts: {e}"))?;

    let rows = tx
        .execute("DELETE FROM chats WHERE id = ?1", params![chat_id])
        .map_err(|e| format!("Failed to delete chat: {e}"))?;

    crate::storage::migrate::materialize_fsrs_cards(&tx)?;

    tx.commit()
        .map_err(|e| format!("Failed to commit delete_chat: {e}"))?;

    Ok(rows > 0)
}

pub fn search_chats(
    conn: &Connection,
    query: &str,
    limit: Option<usize>,
) -> Result<Vec<ChatSearchHit>, String> {
    let clean_query = match crate::storage::sanitize_fts5_query(query) {
        Some(q) => q,
        None => return Ok(vec![]),
    };
    let lim = limit.unwrap_or(20) as i64;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT chat_id, title, snippet(chats_fts, 2, '<b>', '</b>', '...', 16) AS snip
            FROM chats_fts
            WHERE chats_fts MATCH ?1
            ORDER BY rank
            LIMIT ?2
            "#,
        )
        .map_err(|e| format!("Failed to prepare search_chats: {e}"))?;

    let rows = stmt
        .query_map(params![clean_query, lim], |row| {
            let chat_id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let snippet: String = row.get(2)?;
            Ok(ChatSearchHit {
                chat_id,
                title,
                snippet,
            })
        })
        .map_err(|e| format!("Failed to execute search_chats: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Failed to read search hit: {e}"))?);
    }
    Ok(out)
}

pub fn save_image_snapshot(
    conn: &Connection,
    chat_id: &str,
    snapshot_id: &str,
    image: &Value,
) -> Result<(), String> {
    let mime_type = image
        .get("mimeType")
        .and_then(|v| v.as_str())
        .unwrap_or("image/png");
    let data_b64 = image
        .get("data")
        .or_else(|| image.get("dataBase64"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let width = image.get("width").and_then(|v| v.as_i64()).unwrap_or(0);
    let height = image.get("height").and_then(|v| v.as_i64()).unwrap_or(0);

    conn.execute(
        r#"
        INSERT OR REPLACE INTO chat_image_snapshots (
            chat_id, snapshot_id, mime_type, data_base64, width, height
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
        params![chat_id, snapshot_id, mime_type, data_b64, width, height],
    )
    .map_err(|e| format!("Failed to save image snapshot: {e}"))?;

    Ok(())
}

pub fn get_image_snapshot(
    conn: &Connection,
    chat_id: &str,
    snapshot_id: &str,
) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT mime_type, data_base64, width, height
            FROM chat_image_snapshots
            WHERE chat_id = ?1 AND snapshot_id = ?2
            "#,
        )
        .map_err(|e| format!("Failed to prepare get_image_snapshot: {e}"))?;

    let mut rows = stmt
        .query_map(params![chat_id, snapshot_id], |row| {
            let mime_type: String = row.get(0)?;
            let data_b64: String = row.get(1)?;
            let width: i64 = row.get(2)?;
            let height: i64 = row.get(3)?;
            Ok((mime_type, data_b64, width, height))
        })
        .map_err(|e| format!("Failed to query snapshot: {e}"))?;

    if let Some(r) = rows.next() {
        let (mime_type, data_b64, width, height) =
            r.map_err(|e| format!("Failed to read snapshot row: {e}"))?;
        Ok(Some(json!({
            "mimeType": mime_type,
            "data": data_b64,
            "width": width,
            "height": height
        })))
    } else {
        Ok(None)
    }
}

pub fn list_practice_records(
    conn: &Connection,
    chat_id: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut query = "SELECT chat_id, at_ms, targets_json, outcome, rung, miss_class, missed_json, rating FROM practice_records".to_string();
    if chat_id.is_some() {
        query.push_str(" WHERE chat_id = ?1");
    }
    query.push_str(" ORDER BY at_ms ASC");

    let mut stmt = conn
        .prepare(&query)
        .map_err(|e| format!("Failed to prepare list_practice_records: {e}"))?;

    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<Value> {
        let cid: String = row.get(0)?;
        let at_ms: i64 = row.get(1)?;
        let targets_json: String = row.get(2)?;
        let outcome: String = row.get(3)?;
        let rung: Option<String> = row.get(4)?;
        let miss_class: Option<String> = row.get(5)?;
        let missed_json: Option<String> = row.get(6)?;
        let rating: Option<i64> = row.get(7)?;

        let targets: Value = serde_json::from_str(&targets_json).unwrap_or(Value::Array(vec![]));
        let missed: Option<Value> = missed_json.and_then(|m| serde_json::from_str(&m).ok());

        let mut obj = json!({
            "chatId": cid,
            "at": at_ms,
            "targets": targets,
            "outcome": outcome,
            "rung": rung,
            "missClass": miss_class,
            "rating": rating
        });
        if let Some(m) = missed {
            obj["missed"] = m;
        }
        Ok(obj)
    };

    let mut out = Vec::new();
    if let Some(cid) = chat_id {
        let rows = stmt
            .query_map(params![cid], map_row)
            .map_err(|e| format!("Failed to query practice records: {e}"))?;
        for r in rows {
            out.push(r.map_err(|e| format!("Error reading record: {e}"))?);
        }
    } else {
        let rows = stmt
            .query_map([], map_row)
            .map_err(|e| format!("Failed to query practice records: {e}"))?;
        for r in rows {
            out.push(r.map_err(|e| format!("Error reading record: {e}"))?);
        }
    }

    Ok(out)
}

// ─── Tauri Command Handlers ──────────────────────────────────────────────────

#[tauri::command]
pub async fn lh_list_chats(state: State<'_, DbState>) -> Result<Vec<ChatListItem>, String> {
    let conn = state.conn.lock().unwrap();
    list_chats(&conn)
}

#[tauri::command]
pub async fn lh_load_chat(
    state: State<'_, DbState>,
    chat_id: String,
) -> Result<Option<Value>, String> {
    let conn = state.conn.lock().unwrap();
    load_chat(&conn, &chat_id)
}

#[tauri::command]
pub async fn lh_save_chat(
    state: State<'_, DbState>,
    chat_id: Option<String>,
    record: Option<Value>,
    chat: Option<Value>,
) -> Result<(), String> {
    let rec = record
        .or(chat)
        .ok_or_else(|| "Missing chat record parameter".to_string())?;
    let mut conn = state.conn.lock().unwrap();
    save_chat(&mut conn, chat_id.as_deref(), &rec)
}

#[tauri::command]
pub async fn lh_delete_chat(state: State<'_, DbState>, chat_id: String) -> Result<bool, String> {
    let mut conn = state.conn.lock().unwrap();
    delete_chat(&mut conn, &chat_id)
}

#[tauri::command]
pub async fn lh_search_chats(
    state: State<'_, DbState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<ChatSearchHit>, String> {
    let conn = state.conn.lock().unwrap();
    search_chats(&conn, &query, limit)
}

#[tauri::command]
pub async fn lh_save_image_snapshot(
    state: State<'_, DbState>,
    chat_id: String,
    snapshot_id: String,
    image: Value,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    save_image_snapshot(&conn, &chat_id, &snapshot_id, &image)
}

#[tauri::command]
pub async fn lh_save_chat_image(
    state: State<'_, DbState>,
    chat_id: String,
    snapshot_id: String,
    image: Value,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    save_image_snapshot(&conn, &chat_id, &snapshot_id, &image)
}

#[tauri::command]
pub async fn lh_get_image_snapshot(
    state: State<'_, DbState>,
    chat_id: String,
    snapshot_id: String,
) -> Result<Option<Value>, String> {
    let conn = state.conn.lock().unwrap();
    get_image_snapshot(&conn, &chat_id, &snapshot_id)
}

#[tauri::command]
pub async fn lh_list_practice_records(
    state: State<'_, DbState>,
    chat_id: Option<String>,
) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    list_practice_records(&conn, chat_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::schema::init_schema;
    use rusqlite::Connection;
    use serde_json::json;

    fn test_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            "#,
        )
        .unwrap();
        init_schema(&mut conn).unwrap();
        conn
    }

    #[test]
    fn crud_and_fts_search_and_image_snapshots() {
        let mut conn = test_db();

        let chat1 = json!({
            "id": "chat_qm_1",
            "version": 1,
            "title": "Quantum Spin and Entanglement",
            "kind": "teach",
            "createdAt": "2026-10-01T10:00:00Z",
            "updatedAt": "2026-10-01T11:00:00Z",
            "messages": [
                {
                    "role": "user",
                    "content": "Can you explain quantum spin?"
                },
                {
                    "role": "assistant",
                    "timestamp": 1700000000000i64,
                    "content": [
                        {
                            "type": "text",
                            "text": "Quantum spin is an intrinsic angular momentum of fundamental particles."
                        },
                        {
                            "type": "toolCall",
                            "name": "problem",
                            "id": "tc_p1",
                            "arguments": {
                                "target": ["node_spin_1"]
                            }
                        }
                    ]
                },
                {
                    "role": "toolResult",
                    "toolCallId": "tc_p1",
                    "isError": false,
                    "content": []
                },
                {
                    "role": "assistant",
                    "timestamp": 1700000010000i64,
                    "content": [
                        {
                            "type": "toolCall",
                            "name": "conclude",
                            "id": "tc_c1",
                            "arguments": {
                                "outcome": "solved",
                                "rating": 4
                            }
                        }
                    ]
                },
                {
                    "role": "toolResult",
                    "toolCallId": "tc_c1",
                    "isError": false,
                    "content": []
                }
            ],
            "imageSnapshots": {
                "snap_spin": {
                    "mimeType": "image/png",
                    "data": "c3Bpbl9pbWFnZQ==",
                    "width": 640,
                    "height": 480
                }
            }
        });

        save_chat(&mut conn, Some("chat_qm_1"), &chat1).unwrap();

        // 1. Verify list_chats
        let chats = list_chats(&conn).unwrap();
        assert_eq!(chats.len(), 1);
        assert_eq!(chats[0].id, "chat_qm_1");
        assert_eq!(chats[0].title, "Quantum Spin and Entanglement");
        assert_eq!(chats[0].kind, "teach");
        assert_eq!(chats[0].message_count, 5);

        // 2. Verify load_chat reconstructs imageSnapshots
        let loaded = load_chat(&conn, "chat_qm_1")
            .unwrap()
            .expect("Chat not found");
        assert_eq!(loaded["id"], "chat_qm_1");
        let snaps = loaded["imageSnapshots"]
            .as_object()
            .expect("Expected imageSnapshots");
        assert!(snaps.contains_key("snap_spin"));
        assert_eq!(snaps["snap_spin"]["width"], 640);

        // 3. Verify get_image_snapshot and save_image_snapshot
        let snap = get_image_snapshot(&conn, "chat_qm_1", "snap_spin")
            .unwrap()
            .unwrap();
        assert_eq!(snap["mimeType"], "image/png");

        let snap2 = json!({
            "mimeType": "image/jpeg",
            "data": "bmV3X2RhdGE=",
            "width": 320,
            "height": 240
        });
        save_image_snapshot(&conn, "chat_qm_1", "snap_spin_2", &snap2).unwrap();
        let snap2_loaded = get_image_snapshot(&conn, "chat_qm_1", "snap_spin_2")
            .unwrap()
            .unwrap();
        assert_eq!(snap2_loaded["mimeType"], "image/jpeg");

        // 4. Verify search_chats on title and transcript
        let hits_title = search_chats(&conn, "Entanglement", None).unwrap();
        assert_eq!(hits_title.len(), 1);
        assert_eq!(hits_title[0].chat_id, "chat_qm_1");

        let hits_transcript = search_chats(&conn, "intrinsic momentum", None).unwrap();
        assert_eq!(hits_transcript.len(), 1);
        assert_eq!(hits_transcript[0].chat_id, "chat_qm_1");
        assert!(
            hits_transcript[0].snippet.contains("momentum")
                || hits_transcript[0].snippet.contains("intrinsic")
        );

        // 5. Verify practice records extracted
        let practice = list_practice_records(&conn, Some("chat_qm_1")).unwrap();
        assert_eq!(practice.len(), 1);
        assert_eq!(practice[0]["outcome"], "solved");

        // 6. Delete chat and verify cascade
        let deleted = delete_chat(&mut conn, "chat_qm_1").unwrap();
        assert!(deleted);
        assert!(load_chat(&conn, "chat_qm_1").unwrap().is_none());
        assert!(get_image_snapshot(&conn, "chat_qm_1", "snap_spin")
            .unwrap()
            .is_none());
        assert_eq!(search_chats(&conn, "Entanglement", None).unwrap().len(), 0);
        assert_eq!(
            list_practice_records(&conn, Some("chat_qm_1"))
                .unwrap()
                .len(),
            0
        );
    }
}
