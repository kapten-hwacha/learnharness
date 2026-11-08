use crate::storage::DbState;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use tauri::State;

pub fn kv_get(conn: &Connection, key: &str) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT value_json FROM kv_documents WHERE key = ?1")
        .map_err(|e| format!("Failed to prepare kv_get: {e}"))?;

    let mut rows = stmt
        .query_map(params![key], |r| r.get::<_, String>(0))
        .map_err(|e| format!("Failed to query kv_documents: {e}"))?;

    if let Some(r) = rows.next() {
        let val_str = r.map_err(|e| format!("Error reading kv_document: {e}"))?;
        let val: Value = serde_json::from_str(&val_str)
            .map_err(|e| format!("Failed to parse kv value JSON: {e}"))?;
        Ok(Some(val))
    } else {
        Ok(None)
    }
}

pub fn kv_set(conn: &Connection, key: &str, value: &Value) -> Result<(), String> {
    let now_ms = crate::storage::migrate::current_time_ms();
    let val_json = serde_json::to_string(value).map_err(|e| format!("Serialization error: {e}"))?;

    conn.execute(
        r#"
        INSERT INTO kv_documents (key, value_json, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        "#,
        params![key, val_json, now_ms],
    )
    .map_err(|e| format!("Failed to set kv document: {e}"))?;

    Ok(())
}

pub fn study_read_intervals(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT chat_id, start_iso, end_iso, end_reason FROM study_intervals ORDER BY seq ASC",
        )
        .map_err(|e| format!("Failed to prepare study_read_intervals: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let chat_id: String = row.get(0)?;
            let start: String = row.get(1)?;
            let end: String = row.get(2)?;
            let end_reason: String = row.get(3)?;
            Ok(json!({
                "chatId": chat_id,
                "start": start,
                "end": end,
                "endReason": end_reason
            }))
        })
        .map_err(|e| format!("Failed to query study_intervals: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Error reading interval: {e}"))?);
    }
    Ok(out)
}

pub fn study_append_intervals(conn: &mut Connection, intervals: &[Value]) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin tx: {e}"))?;

    for item in intervals {
        let chat_id = item.get("chatId").and_then(|v| v.as_str()).unwrap_or("");
        let start = item.get("start").and_then(|v| v.as_str()).unwrap_or("");
        let end = item.get("end").and_then(|v| v.as_str()).unwrap_or("");
        let end_reason = item.get("endReason").and_then(|v| v.as_str()).unwrap_or("");

        tx.execute(
            "INSERT INTO study_intervals (chat_id, start_iso, end_iso, end_reason) VALUES (?1, ?2, ?3, ?4)",
            params![chat_id, start, end, end_reason],
        )
        .map_err(|e| format!("Failed to insert interval: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit intervals: {e}"))?;
    Ok(())
}

pub fn study_list_materials(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT id, content_json FROM study_materials")
        .map_err(|e| format!("Failed to prepare study_list_materials: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let content_json: String = row.get(1)?;
            let content: Value = serde_json::from_str(&content_json).unwrap_or(json!({}));
            Ok(json!({
                "id": id,
                "content": content
            }))
        })
        .map_err(|e| format!("Failed to query study_materials: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Error reading material: {e}"))?);
    }
    Ok(out)
}

pub fn study_save_materials(conn: &Connection, id: &str, content: &Value) -> Result<(), String> {
    let content_json =
        serde_json::to_string(content).map_err(|e| format!("Serialization error: {e}"))?;

    conn.execute(
        "INSERT OR REPLACE INTO study_materials (id, content_json) VALUES (?1, ?2)",
        params![id, content_json],
    )
    .map_err(|e| format!("Failed to save material: {e}"))?;

    Ok(())
}

pub fn prompt_override_list(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT segment_path FROM prompt_overrides ORDER BY segment_path ASC")
        .map_err(|e| format!("Failed to prepare prompt_override_list: {e}"))?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query prompt_overrides: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Error reading prompt override: {e}"))?);
    }
    Ok(out)
}

pub fn prompt_override_read(
    conn: &Connection,
    segment_path: &str,
) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT content FROM prompt_overrides WHERE segment_path = ?1")
        .map_err(|e| format!("Failed to prepare prompt_override_read: {e}"))?;

    let mut rows = stmt
        .query_map(params![segment_path], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query prompt_override: {e}"))?;

    if let Some(r) = rows.next() {
        Ok(Some(r.map_err(|e| format!("Error reading content: {e}"))?))
    } else {
        Ok(None)
    }
}

pub fn prompt_override_write(
    conn: &Connection,
    segment_path: &str,
    content: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO prompt_overrides (segment_path, content) VALUES (?1, ?2)",
        params![segment_path, content],
    )
    .map_err(|e| format!("Failed to write prompt override: {e}"))?;

    Ok(())
}

pub fn prompt_override_delete(conn: &Connection, segment_path: &str) -> Result<bool, String> {
    let rows = conn
        .execute(
            "DELETE FROM prompt_overrides WHERE segment_path = ?1",
            params![segment_path],
        )
        .map_err(|e| format!("Failed to delete prompt override: {e}"))?;

    Ok(rows > 0)
}

fn validate_auth_filename(filename: Option<&str>) -> Result<String, String> {
    let name = filename.unwrap_or("auth.json");
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains('\0')
    {
        return Err(format!("Invalid auth filename: {name}"));
    }
    if name != "auth.json" && !name.ends_with("-credentials.json") {
        return Err(format!("Invalid auth filename pattern: {name}"));
    }
    Ok(name.to_string())
}

pub fn auth_read(user_data_dir: &Path, filename: Option<&str>) -> Result<Option<String>, String> {
    let name = validate_auth_filename(filename)?;
    let path = user_data_dir.join(name);
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("Failed to read auth file {}: {e}", path.display()))
}

pub fn auth_write(
    user_data_dir: &Path,
    filename: Option<&str>,
    content: &str,
) -> Result<(), String> {
    let name = validate_auth_filename(filename)?;
    fs::create_dir_all(user_data_dir)
        .map_err(|e| format!("Failed to create user_data_dir: {e}"))?;

    let target_path = user_data_dir.join(&name);
    let temp_name = format!(
        ".tmp_{}_{}_{}",
        name,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let temp_path = user_data_dir.join(temp_name);

    fs::write(&temp_path, content).map_err(|e| format!("Failed to write temp auth file: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600));
    }

    fs::rename(&temp_path, &target_path).map_err(|e| format!("Failed to rename auth file: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&target_path, fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

// ─── Tauri Command Handlers ──────────────────────────────────────────────────

#[tauri::command]
pub async fn lh_kv_get(state: State<'_, DbState>, key: String) -> Result<Option<Value>, String> {
    let conn = state.conn.lock().unwrap();
    kv_get(&conn, &key)
}

#[tauri::command]
pub async fn lh_kv_set(state: State<'_, DbState>, key: String, value: Value) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    kv_set(&conn, &key, &value)
}

#[tauri::command]
pub async fn lh_study_read_intervals(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    study_read_intervals(&conn)
}

#[tauri::command]
pub async fn lh_study_list_intervals(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    study_read_intervals(&conn)
}

#[tauri::command]
pub async fn lh_study_append_intervals(
    state: State<'_, DbState>,
    intervals: Vec<Value>,
) -> Result<(), String> {
    let mut conn = state.conn.lock().unwrap();
    study_append_intervals(&mut conn, &intervals)
}

#[tauri::command]
pub async fn lh_study_append_interval(
    state: State<'_, DbState>,
    interval: Option<Value>,
    intervals: Option<Vec<Value>>,
) -> Result<(), String> {
    let mut list = Vec::new();
    if let Some(i) = interval {
        list.push(i);
    }
    if let Some(mut is) = intervals {
        list.append(&mut is);
    }
    let mut conn = state.conn.lock().unwrap();
    study_append_intervals(&mut conn, &list)
}

#[tauri::command]
pub async fn lh_list_study_materials(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    study_list_materials(&conn)
}

#[tauri::command]
pub async fn lh_save_study_materials(
    state: State<'_, DbState>,
    id: String,
    content: Value,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    study_save_materials(&conn, &id, &content)
}

#[tauri::command]
pub async fn lh_prompt_override_list(state: State<'_, DbState>) -> Result<Vec<String>, String> {
    let conn = state.conn.lock().unwrap();
    prompt_override_list(&conn)
}

#[tauri::command]
pub async fn lh_prompts_list_overrides(state: State<'_, DbState>) -> Result<Vec<String>, String> {
    let conn = state.conn.lock().unwrap();
    prompt_override_list(&conn)
}

#[tauri::command]
pub async fn lh_list_prompt_overrides(state: State<'_, DbState>) -> Result<Vec<String>, String> {
    let conn = state.conn.lock().unwrap();
    prompt_override_list(&conn)
}

#[tauri::command]
pub async fn lh_prompt_override_read(
    state: State<'_, DbState>,
    segment_path: String,
) -> Result<Option<String>, String> {
    let conn = state.conn.lock().unwrap();
    prompt_override_read(&conn, &segment_path)
}

#[tauri::command]
pub async fn lh_prompts_get_override(
    state: State<'_, DbState>,
    segment_path: String,
) -> Result<Option<String>, String> {
    let conn = state.conn.lock().unwrap();
    prompt_override_read(&conn, &segment_path)
}

#[tauri::command]
pub async fn lh_get_prompt_override(
    state: State<'_, DbState>,
    segment_path: String,
) -> Result<Option<String>, String> {
    let conn = state.conn.lock().unwrap();
    prompt_override_read(&conn, &segment_path)
}

#[tauri::command]
pub async fn lh_prompt_override_write(
    state: State<'_, DbState>,
    segment_path: String,
    content: Option<String>,
    text: Option<String>,
) -> Result<(), String> {
    let body = content
        .or(text)
        .ok_or_else(|| "Missing override content/text".to_string())?;
    let conn = state.conn.lock().unwrap();
    prompt_override_write(&conn, &segment_path, &body)
}

#[tauri::command]
pub async fn lh_prompts_set_override(
    state: State<'_, DbState>,
    segment_path: String,
    content: Option<String>,
    text: Option<String>,
) -> Result<(), String> {
    let body = content
        .or(text)
        .ok_or_else(|| "Missing override content/text".to_string())?;
    let conn = state.conn.lock().unwrap();
    prompt_override_write(&conn, &segment_path, &body)
}

#[tauri::command]
pub async fn lh_set_prompt_override(
    state: State<'_, DbState>,
    segment_path: String,
    content: Option<String>,
    text: Option<String>,
) -> Result<(), String> {
    let body = content
        .or(text)
        .ok_or_else(|| "Missing override content/text".to_string())?;
    let conn = state.conn.lock().unwrap();
    prompt_override_write(&conn, &segment_path, &body)
}

#[tauri::command]
pub async fn lh_prompt_override_delete(
    state: State<'_, DbState>,
    segment_path: String,
) -> Result<bool, String> {
    let conn = state.conn.lock().unwrap();
    prompt_override_delete(&conn, &segment_path)
}

#[tauri::command]
pub async fn lh_prompts_delete_override(
    state: State<'_, DbState>,
    segment_path: String,
) -> Result<bool, String> {
    let conn = state.conn.lock().unwrap();
    prompt_override_delete(&conn, &segment_path)
}

#[tauri::command]
pub async fn lh_auth_read(
    state: State<'_, DbState>,
    filename: Option<String>,
) -> Result<Option<String>, String> {
    auth_read(&state.user_data_dir, filename.as_deref())
}

#[tauri::command]
pub async fn lh_auth_write(
    state: State<'_, DbState>,
    filename: Option<String>,
    content: String,
) -> Result<(), String> {
    auth_write(&state.user_data_dir, filename.as_deref(), &content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::schema::init_schema;
    use rusqlite::Connection;
    use serde_json::json;

    fn test_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        init_schema(&mut conn).unwrap();
        conn
    }

    #[test]
    fn kv_study_prompts_and_auth_0600() {
        let mut conn = test_db();

        // 1. KV
        assert!(kv_get(&conn, "settings").unwrap().is_none());
        let settings_val = json!({"general": {"autoUpdate": true}});
        kv_set(&conn, "settings", &settings_val).unwrap();
        let loaded = kv_get(&conn, "settings").unwrap().unwrap();
        assert_eq!(loaded["general"]["autoUpdate"], true);

        // 2. Study intervals
        let int1 = json!({
            "chatId": "chat_1",
            "start": "2026-10-01T00:00:00Z",
            "end": "2026-10-01T01:00:00Z",
            "endReason": "stop"
        });
        study_append_intervals(&mut conn, &[int1]).unwrap();
        let intervals = study_read_intervals(&conn).unwrap();
        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0]["chatId"], "chat_1");

        // Study materials
        let mat = json!({"topics": ["qm", "math"]});
        study_save_materials(&conn, "default", &mat).unwrap();
        let mats = study_list_materials(&conn).unwrap();
        assert_eq!(mats.len(), 1);

        // 3. Prompt overrides
        assert_eq!(prompt_override_list(&conn).unwrap().len(), 0);
        prompt_override_write(&conn, "teacher/20-teaching.md", "# Custom Teaching").unwrap();
        prompt_override_write(&conn, "system-prompt.md", "# Custom System").unwrap();

        let list = prompt_override_list(&conn).unwrap();
        assert_eq!(
            list,
            vec![
                "system-prompt.md".to_string(),
                "teacher/20-teaching.md".to_string()
            ]
        );

        let custom = prompt_override_read(&conn, "system-prompt.md")
            .unwrap()
            .unwrap();
        assert_eq!(custom, "# Custom System");

        prompt_override_delete(&conn, "system-prompt.md").unwrap();
        assert!(prompt_override_read(&conn, "system-prompt.md")
            .unwrap()
            .is_none());

        // 4. Auth read/write 0600 on Unix
        let tmp = std::env::temp_dir().join(format!("lh_auth_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        auth_write(&tmp, None, r#"{"OPENAI_API_KEY":"sk-secret"}"#).unwrap();
        let auth_content = auth_read(&tmp, None).unwrap().unwrap();
        assert!(auth_content.contains("sk-secret"));

        auth_write(&tmp, Some("custom-credentials.json"), r#"{"token":"abc"}"#).unwrap();
        let cred_content = auth_read(&tmp, Some("custom-credentials.json"))
            .unwrap()
            .unwrap();
        assert!(cred_content.contains("abc"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta1 = std::fs::metadata(tmp.join("auth.json")).unwrap();
            assert_eq!(meta1.permissions().mode() & 0o777, 0o600);
            let meta2 = std::fs::metadata(tmp.join("custom-credentials.json")).unwrap();
            assert_eq!(meta2.permissions().mode() & 0o777, 0o600);
        }

        // Must reject path traversal
        assert!(auth_write(&tmp, Some("../evil.json"), "{}").is_err());
        assert!(auth_write(&tmp, Some("foo/bar.json"), "{}").is_err());
        assert!(auth_write(&tmp, Some("plain.txt"), "{}").is_err());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
