use crate::storage::DbState;
use rusqlite::{params, Connection};
use serde_json::Value;
use tauri::State;

pub fn save_job(conn: &Connection, record: &Value) -> Result<(), String> {
    let id = record
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing id in job record".to_string())?;
    let kind = record.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let chat_id = record.get("chatId").and_then(|v| v.as_str()).unwrap_or("");
    let tool_call_id = record
        .get("toolCallId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let status = record.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let activity = record
        .get("activity")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let created_at = record
        .get("createdAt")
        .and_then(|v| v.as_str())
        .unwrap_or("2026-10-01T00:00:00Z");
    let updated_at = record
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or("2026-10-01T00:00:00Z");

    let record_json =
        serde_json::to_string(record).map_err(|e| format!("Serialization error: {e}"))?;

    conn.execute(
        r#"
        INSERT INTO jobs (id, kind, chat_id, tool_call_id, status, activity, created_at, updated_at, record_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            chat_id = excluded.chat_id,
            tool_call_id = excluded.tool_call_id,
            status = excluded.status,
            activity = excluded.activity,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            record_json = excluded.record_json
        "#,
        params![
            id,
            kind,
            chat_id,
            tool_call_id,
            status,
            activity,
            created_at,
            updated_at,
            record_json
        ],
    )
    .map_err(|e| format!("Failed to save job: {e}"))?;

    Ok(())
}

pub fn get_job(conn: &Connection, job_id: &str) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT record_json FROM jobs WHERE id = ?1")
        .map_err(|e| format!("Failed to prepare get_job: {e}"))?;

    let mut rows = stmt
        .query_map(params![job_id], |row| {
            let json_str: String = row.get(0)?;
            Ok(json_str)
        })
        .map_err(|e| format!("Failed to query job: {e}"))?;

    if let Some(r) = rows.next() {
        let json_str = r.map_err(|e| format!("Error reading job: {e}"))?;
        let val: Value = serde_json::from_str(&json_str)
            .map_err(|e| format!("Failed to parse job JSON: {e}"))?;
        Ok(Some(val))
    } else {
        Ok(None)
    }
}

pub fn list_jobs(conn: &Connection, chat_id: Option<&str>) -> Result<Vec<Value>, String> {
    let mut query = "SELECT record_json FROM jobs".to_string();
    if chat_id.is_some() {
        query.push_str(" WHERE chat_id = ?1");
    }
    query.push_str(" ORDER BY updated_at DESC");

    let mut stmt = conn
        .prepare(&query)
        .map_err(|e| format!("Failed to prepare list_jobs: {e}"))?;

    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<String> { row.get(0) };

    let mut out = Vec::new();
    if let Some(cid) = chat_id {
        let rows = stmt
            .query_map(params![cid], map_row)
            .map_err(|e| format!("Failed to query jobs: {e}"))?;
        for r in rows {
            let json_str = r.map_err(|e| format!("Error reading job: {e}"))?;
            if let Ok(val) = serde_json::from_str::<Value>(&json_str) {
                out.push(val);
            }
        }
    } else {
        let rows = stmt
            .query_map([], map_row)
            .map_err(|e| format!("Failed to query jobs: {e}"))?;
        for r in rows {
            let json_str = r.map_err(|e| format!("Error reading job: {e}"))?;
            if let Ok(val) = serde_json::from_str::<Value>(&json_str) {
                out.push(val);
            }
        }
    }

    Ok(out)
}

pub fn find_job_by_tool_call(
    conn: &Connection,
    chat_id: &str,
    tool_call_id: &str,
) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT record_json FROM jobs WHERE chat_id = ?1 AND tool_call_id = ?2")
        .map_err(|e| format!("Failed to prepare find_job_by_tool_call: {e}"))?;

    let mut rows = stmt
        .query_map(params![chat_id, tool_call_id], |row| {
            let json_str: String = row.get(0)?;
            Ok(json_str)
        })
        .map_err(|e| format!("Failed to query find_job_by_tool_call: {e}"))?;

    if let Some(r) = rows.next() {
        let json_str = r.map_err(|e| format!("Error reading job: {e}"))?;
        let val: Value = serde_json::from_str(&json_str)
            .map_err(|e| format!("Failed to parse job JSON: {e}"))?;
        Ok(Some(val))
    } else {
        Ok(None)
    }
}

pub fn delete_job(conn: &Connection, job_id: &str) -> Result<bool, String> {
    let rows = conn
        .execute("DELETE FROM jobs WHERE id = ?1", params![job_id])
        .map_err(|e| format!("Failed to delete job: {e}"))?;
    Ok(rows > 0)
}

pub fn delete_jobs_for_chat(conn: &Connection, chat_id: &str) -> Result<usize, String> {
    let count = conn
        .execute("DELETE FROM jobs WHERE chat_id = ?1", params![chat_id])
        .map_err(|e| format!("Failed to delete jobs for chat: {e}"))?;
    Ok(count)
}

// ─── Tauri Command Handlers ──────────────────────────────────────────────────

#[tauri::command]
pub async fn lh_job_save(state: State<'_, DbState>, record: Value) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    save_job(&conn, &record)
}

#[tauri::command]
pub async fn lh_save_job(state: State<'_, DbState>, record: Value) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    save_job(&conn, &record)
}

#[tauri::command]
pub async fn lh_job_get(
    state: State<'_, DbState>,
    job_id: String,
) -> Result<Option<Value>, String> {
    let conn = state.conn.lock().unwrap();
    get_job(&conn, &job_id)
}

#[tauri::command]
pub async fn lh_get_job(
    state: State<'_, DbState>,
    job_id: String,
) -> Result<Option<Value>, String> {
    let conn = state.conn.lock().unwrap();
    get_job(&conn, &job_id)
}

#[tauri::command]
pub async fn lh_job_list(
    state: State<'_, DbState>,
    chat_id: Option<String>,
) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    list_jobs(&conn, chat_id.as_deref())
}

#[tauri::command]
pub async fn lh_list_jobs(
    state: State<'_, DbState>,
    chat_id: Option<String>,
) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    list_jobs(&conn, chat_id.as_deref())
}

#[tauri::command]
pub async fn lh_job_find_by_tool_call(
    state: State<'_, DbState>,
    chat_id: String,
    tool_call_id: String,
) -> Result<Option<Value>, String> {
    let conn = state.conn.lock().unwrap();
    find_job_by_tool_call(&conn, &chat_id, &tool_call_id)
}

#[tauri::command]
pub async fn lh_job_delete_for_chat(
    state: State<'_, DbState>,
    chat_id: String,
) -> Result<usize, String> {
    let conn = state.conn.lock().unwrap();
    delete_jobs_for_chat(&conn, &chat_id)
}

#[tauri::command]
pub async fn lh_delete_job(state: State<'_, DbState>, job_id: String) -> Result<bool, String> {
    let conn = state.conn.lock().unwrap();
    delete_job(&conn, &job_id)
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
    fn job_crud_and_tool_call_lookup() {
        let conn = test_db();

        let job1 = json!({
            "id": "job_1",
            "kind": "extractor",
            "chatId": "chat_1",
            "toolCallId": "tc_ext_1",
            "status": "pending",
            "activity": "extracting concepts",
            "createdAt": "2026-10-01T00:00:00Z",
            "updatedAt": "2026-10-01T00:01:00Z"
        });
        let job2 = json!({
            "id": "job_2",
            "kind": "auditor",
            "chatId": "chat_1",
            "toolCallId": "tc_aud_1",
            "status": "completed",
            "activity": "verified 2 propositions",
            "createdAt": "2026-10-01T00:02:00Z",
            "updatedAt": "2026-10-01T00:03:00Z"
        });
        let job3 = json!({
            "id": "job_3",
            "kind": "extractor",
            "chatId": "chat_2",
            "toolCallId": "tc_ext_2",
            "status": "pending",
            "activity": "extracting other chat",
            "createdAt": "2026-10-01T00:04:00Z",
            "updatedAt": "2026-10-01T00:05:00Z"
        });

        save_job(&conn, &job1).unwrap();
        save_job(&conn, &job2).unwrap();
        save_job(&conn, &job3).unwrap();

        // 1. Get job
        let loaded = get_job(&conn, "job_1").unwrap().expect("job_1 not found");
        assert_eq!(loaded["id"], "job_1");
        assert_eq!(loaded["status"], "pending");

        // 2. List jobs (ordered by updated_at DESC)
        let all_jobs = list_jobs(&conn, None).unwrap();
        assert_eq!(all_jobs.len(), 3);
        assert_eq!(all_jobs[0]["id"], "job_3"); // 00:05:00Z
        assert_eq!(all_jobs[1]["id"], "job_2"); // 00:03:00Z
        assert_eq!(all_jobs[2]["id"], "job_1"); // 00:01:00Z

        let chat1_jobs = list_jobs(&conn, Some("chat_1")).unwrap();
        assert_eq!(chat1_jobs.len(), 2);
        assert_eq!(chat1_jobs[0]["id"], "job_2");
        assert_eq!(chat1_jobs[1]["id"], "job_1");

        // 3. Find by tool call id
        let found = find_job_by_tool_call(&conn, "chat_1", "tc_aud_1")
            .unwrap()
            .unwrap();
        assert_eq!(found["id"], "job_2");
        assert!(find_job_by_tool_call(&conn, "chat_1", "tc_nonexistent")
            .unwrap()
            .is_none());

        // 4. Delete for chat
        let count = delete_jobs_for_chat(&conn, "chat_1").unwrap();
        assert_eq!(count, 2);
        assert_eq!(list_jobs(&conn, Some("chat_1")).unwrap().len(), 0);
        assert_eq!(list_jobs(&conn, None).unwrap().len(), 1);
    }
}
