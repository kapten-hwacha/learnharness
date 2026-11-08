use rusqlite::{params, Connection, Transaction};
use serde_json::Value;
use std::path::Path;

pub(crate) const FSRS_W: [f64; 21] = [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
    0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];
pub(crate) const DAY_MS: f64 = 86_400_000.0;

pub(crate) fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = m + if m > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy as u64;
    era * 146097 + doe as i64 - 719468
}

pub(crate) fn parse_iso_timestamp(iso: &str, fallback_ms: i64) -> i64 {
    if let Ok(num) = iso.parse::<i64>() {
        return num;
    }
    let parts: Vec<&str> = iso.split('T').collect();
    if parts.len() == 2 {
        let date_parts: Vec<&str> = parts[0].split('-').collect();
        let time_str = parts[1].trim_end_matches('Z');
        let time_parts: Vec<&str> = time_str.split(':').collect();
        if date_parts.len() == 3 && time_parts.len() >= 2 {
            if let (Ok(y), Ok(m), Ok(d), Ok(h), Ok(min)) = (
                date_parts[0].parse::<i64>(),
                date_parts[1].parse::<i64>(),
                date_parts[2].parse::<i64>(),
                time_parts[0].parse::<i64>(),
                time_parts[1].parse::<i64>(),
            ) {
                let sec_parts: Vec<&str> = if time_parts.len() >= 3 {
                    time_parts[2].split('.').collect()
                } else {
                    vec!["0"]
                };
                let sec = sec_parts[0].parse::<i64>().unwrap_or(0);
                let ms = if sec_parts.len() > 1 {
                    let mut ms_str = sec_parts[1].to_string();
                    ms_str.truncate(3);
                    while ms_str.len() < 3 {
                        ms_str.push('0');
                    }
                    ms_str.parse::<i64>().unwrap_or(0)
                } else {
                    0
                };
                let days_since_1970 = days_from_civil(y, m, d);
                let total_secs = days_since_1970 * 86400 + h * 3600 + min * 60 + sec;
                return total_secs * 1000 + ms;
            }
        }
    }
    fallback_ms
}

fn fsrs_update(previous: Option<(f64, f64)>, rating: i64, elapsed_days: f64) -> (f64, f64) {
    let n = rating as usize;
    let factor = (0.9_f64).powf(-1.0 / FSRS_W[20]) - 1.0;
    if previous.is_none() {
        let stability = FSRS_W[n - 1];
        let difficulty = (FSRS_W[4] - (FSRS_W[5] * (n as f64 - 1.0)).exp() + 1.0).clamp(1.0, 10.0);
        return (stability, difficulty);
    }
    let (s, d) = previous.unwrap();
    let r = (1.0 + factor * elapsed_days / s).powf(-FSRS_W[20]);
    let next_difficulty = (FSRS_W[7] * (FSRS_W[4] - (FSRS_W[5] * 3.0).exp() + 1.0)
        + (1.0 - FSRS_W[7]) * (d + (10.0 - d) * (-FSRS_W[6] * (rating as f64 - 3.0)) / 9.0))
        .clamp(1.0, 10.0);
    let next_stability = if rating == 1 {
        let s1 = FSRS_W[11]
            * d.powf(-FSRS_W[12])
            * ((s + 1.0).powf(FSRS_W[13]) - 1.0)
            * ((1.0 - r) * FSRS_W[14]).exp();
        let s2 = s / (FSRS_W[17] * FSRS_W[18]).exp();
        s1.min(s2)
    } else {
        let hard_penalty = if rating == 2 { FSRS_W[15] } else { 1.0 };
        let easy_bonus = if rating == 4 { FSRS_W[16] } else { 1.0 };
        s * (1.0
            + (FSRS_W[8]).exp()
                * (11.0 - d)
                * s.powf(-FSRS_W[9])
                * (((1.0 - r) * FSRS_W[10]).exp() - 1.0)
                * hard_penalty
                * easy_bonus)
    };
    (next_stability.max(0.001), next_difficulty)
}

fn review_rating(
    outcome: &str,
    rung: Option<&str>,
    miss_class: Option<&str>,
    missed: &[String],
    rating: Option<i64>,
    target: &str,
) -> Option<i64> {
    if outcome == "dismissed" {
        return None;
    }
    if !missed.is_empty() {
        if missed.iter().any(|m| m == target) {
            let is_r3_plus = rung.map(|r| r >= "R3").unwrap_or(false);
            if outcome != "movedOn"
                && outcome != "surrendered"
                && !is_r3_plus
                && (miss_class == Some("execution") || miss_class == Some("careless"))
            {
                return Some(2);
            }
            return Some(1);
        }
        let is_r3_plus = rung.map(|r| r >= "R3").unwrap_or(false);
        if outcome == "movedOn" || outcome == "surrendered" || is_r3_plus {
            return Some(3);
        }
    }
    let is_r3_plus = rung.map(|r| r >= "R3").unwrap_or(false);
    if outcome == "movedOn" || outcome == "surrendered" || is_r3_plus {
        return Some(1);
    }
    if miss_class == Some("execution") || miss_class == Some("careless") {
        return Some(2);
    }
    if let Some(r) = rating {
        if (1..=4).contains(&r) {
            return Some(r);
        }
    }
    if outcome == "solved" && rung.is_none() {
        return Some(3);
    }
    Some(2)
}

pub fn migrate_legacy_data_if_needed(
    conn: &mut Connection,
    data_dir: &Path,
    auth_file: &Path,
    user_data_dir: &Path,
) -> Result<(), String> {
    let ver: i32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap_or(0);
    if ver > 0 {
        return Ok(());
    }

    // Step 1: Handle auth.json and credentials file isolation
    migrate_auth_and_credentials(data_dir, auth_file, user_data_dir)?;

    // Step 2: Atomic migration of legacy data/ into SQLite
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin migration transaction: {e}"))?;

    migrate_chats(&tx, data_dir)?;
    migrate_graph(&tx, data_dir)?;
    migrate_jobs(&tx, data_dir)?;
    migrate_study(&tx, data_dir)?;
    migrate_prompts(&tx, data_dir)?;
    migrate_kv_documents(&tx, data_dir)?;
    materialize_fsrs_cards(&tx)?;

    tx.commit()
        .map_err(|e| format!("Failed to commit migration transaction: {e}"))?;

    // Mark migration complete
    conn.pragma_update(None, "user_version", 1)
        .map_err(|e| format!("Failed to set user_version to 1: {e}"))?;

    Ok(())
}

fn migrate_auth_and_credentials(
    data_dir: &Path,
    auth_file: &Path,
    user_data_dir: &Path,
) -> Result<(), String> {
    if !user_data_dir.exists() {
        let _ = std::fs::create_dir_all(user_data_dir);
    }

    let legacy_auth = data_dir.join("auth.json");
    if legacy_auth.exists() && (!auth_file.exists() && legacy_auth != *auth_file) {
        let _ = std::fs::copy(&legacy_auth, auth_file);
    }

    if auth_file.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(auth_file, std::fs::Permissions::from_mode(0o600));
        }
    }

    if data_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(data_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if name.ends_with("-credentials.json") {
                        let target = user_data_dir.join(name);
                        if !target.exists() && p != target {
                            let _ = std::fs::copy(&p, &target);
                        }
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::PermissionsExt;
                            let _ = std::fs::set_permissions(
                                &target,
                                std::fs::Permissions::from_mode(0o600),
                            );
                        }
                    }
                }
            }
        }
    }

    if let Ok(entries) = std::fs::read_dir(user_data_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.ends_with("-credentials.json") {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ =
                            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
                    }
                }
            }
        }
    }

    Ok(())
}

fn migrate_chats(tx: &Transaction, data_dir: &Path) -> Result<(), String> {
    let chats_dir = data_dir.join("chats");
    if !chats_dir.exists() {
        return Ok(());
    }
    let entries = match std::fs::read_dir(&chats_dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };

    let mut chat_stmt = tx
        .prepare_cached(
            r#"
            INSERT OR REPLACE INTO chats (
                id, version, title, kind, created_at, updated_at,
                message_count, phase, pending_question, pending_problem, seed_rating,
                messages_json, tree_json, settings_json, turns_json, extractions_json, clarifications_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
            "#,
        )
        .map_err(|e| format!("Failed to prepare chat statement: {e}"))?;

    let mut fts_stmt = tx
        .prepare_cached(
            r#"
            INSERT INTO chats_fts (chat_id, title, transcript_text)
            VALUES (?1, ?2, ?3)
            "#,
        )
        .map_err(|e| format!("Failed to prepare chats_fts statement: {e}"))?;

    let mut img_stmt = tx
        .prepare_cached(
            r#"
            INSERT OR REPLACE INTO chat_image_snapshots (chat_id, snapshot_id, mime_type, data_base64, width, height)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
        )
        .map_err(|e| format!("Failed to prepare chat_image_snapshots statement: {e}"))?;

    let mut practice_stmt = tx
        .prepare_cached(
            r#"
            INSERT INTO practice_records (chat_id, at_ms, targets_json, outcome, rung, miss_class, missed_json, rating)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
        )
        .map_err(|e| format!("Failed to prepare practice_records statement: {e}"))?;

    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() || p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = match std::fs::read_to_string(&p) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let val: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !val.is_object() {
            continue;
        }

        let file_stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown");
        let id = val
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or(file_stem)
            .to_string();
        let version = val.get("version").and_then(|v| v.as_i64()).unwrap_or(1);
        let title = val
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled session")
            .to_string();
        let kind = val
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("teach")
            .to_string();
        let fallback_now = "2026-10-01T00:00:00Z".to_string();
        let created_at = val
            .get("createdAt")
            .and_then(|v| v.as_str())
            .unwrap_or(&fallback_now)
            .to_string();
        let updated_at = val
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .unwrap_or(&created_at)
            .to_string();

        let messages_val = val.get("messages").cloned().unwrap_or(Value::Array(vec![]));
        let messages = messages_val.as_array().cloned().unwrap_or_default();
        let message_count = messages.len() as i64;
        let messages_json =
            serde_json::to_string(&messages_val).unwrap_or_else(|_| "[]".to_string());

        let tree_json = val
            .get("tree")
            .map(|v| serde_json::to_string(v).unwrap_or_default());
        let settings_json = val
            .get("settings")
            .map(|v| serde_json::to_string(v).unwrap_or_default());
        let turns_json = val
            .get("turns")
            .map(|v| serde_json::to_string(v).unwrap_or_default());
        let extractions_json = val
            .get("extractions")
            .map(|v| serde_json::to_string(v).unwrap_or_default());
        let clarifications_json = val
            .get("clarifications")
            .map(|v| serde_json::to_string(v).unwrap_or_default());

        let phase = derive_phase(&messages);
        let pending_question = if has_dangling_question(&messages) {
            1
        } else {
            0
        };
        let pending_problem = if has_active_problem(&messages) { 1 } else { 0 };
        let seed_rating = derive_seed_rating(&messages);

        chat_stmt
            .execute(params![
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
            ])
            .map_err(|e| format!("Failed to insert chat {id}: {e}"))?;

        let transcript_text =
            extract_transcript_text(&messages, val.get("tree"), val.get("extractions"));
        let _ = fts_stmt.execute(params![id, title, transcript_text]);

        if let Some(snapshots) = val.get("imageSnapshots").and_then(|s| s.as_object()) {
            for (snapshot_id, snap_val) in snapshots {
                let mime_type = snap_val
                    .get("mimeType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("image/png");
                let data_base64 = snap_val
                    .get("data")
                    .or_else(|| snap_val.get("dataBase64"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let width = snap_val.get("width").and_then(|v| v.as_i64()).unwrap_or(0);
                let height = snap_val.get("height").and_then(|v| v.as_i64()).unwrap_or(0);
                let _ = img_stmt.execute(params![
                    id,
                    snapshot_id,
                    mime_type,
                    data_base64,
                    width,
                    height
                ]);
            }
        }

        let records = extract_practice_records(&id, &messages);
        for rec in records {
            let _ = practice_stmt.execute(params![
                rec.chat_id,
                rec.at_ms,
                rec.targets_json,
                rec.outcome,
                rec.rung,
                rec.miss_class,
                rec.missed_json,
                rec.rating
            ]);
        }
    }

    Ok(())
}

pub(crate) fn derive_phase(messages: &[Value]) -> String {
    let mut phase = "probe";
    let mut probe_done_results = std::collections::HashSet::new();
    for m in messages {
        if m.get("role").and_then(|r| r.as_str()) == Some("toolResult") {
            let tool_name = m.get("toolName").and_then(|t| t.as_str());
            let is_error = m.get("isError").and_then(|e| e.as_bool()).unwrap_or(false);
            let not_ok = m
                .get("details")
                .and_then(|d| d.get("ok"))
                .and_then(|o| o.as_bool())
                == Some(false);
            if tool_name == Some("probe_done") && !is_error && !not_ok {
                if let Some(call_id) = m.get("toolCallId").and_then(|i| i.as_str()) {
                    probe_done_results.insert(call_id.to_string());
                }
            }
        }
    }

    for m in messages {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role == "toolResult" {
            if phase == "probe" {
                if let Some(call_id) = m.get("toolCallId").and_then(|i| i.as_str()) {
                    if probe_done_results.contains(call_id) {
                        phase = "plan";
                    }
                }
            }
        } else if role == "assistant" && phase == "plan" {
            if let Some(content) = m.get("content").and_then(|c| c.as_array()) {
                for block in content {
                    let b_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    let b_name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    if b_type == "toolCall" && (b_name == "quiz" || b_name == "explain") {
                        if let Some(node_id) = block
                            .get("arguments")
                            .and_then(|a| a.get("nodeId"))
                            .and_then(|n| n.as_str())
                        {
                            if !node_id.is_empty() {
                                phase = "teach";
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    phase.to_string()
}

pub(crate) fn has_dangling_question(messages: &[Value]) -> bool {
    const QUESTION_TOOLS: &[&str] = &["quiz", "probe", "ask_user_question", "explain", "recall"];
    for mi in (0..messages.len()).rev() {
        let m = &messages[mi];
        if m.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            continue;
        }
        let stop_reason = m.get("stopReason").and_then(|s| s.as_str()).unwrap_or("");
        if stop_reason == "error" || stop_reason == "aborted" {
            continue;
        }
        let mut answered = std::collections::HashSet::new();
        for tail in &messages[mi + 1..] {
            if tail.get("role").and_then(|r| r.as_str()) == Some("toolResult") {
                if let Some(tid) = tail.get("toolCallId").and_then(|t| t.as_str()) {
                    answered.insert(tid);
                }
            }
        }
        if let Some(content) = m.get("content").and_then(|c| c.as_array()) {
            for block in content {
                if block.get("type").and_then(|t| t.as_str()) == Some("toolCall") {
                    let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    let id = block.get("id").and_then(|i| i.as_str()).unwrap_or("");
                    if QUESTION_TOOLS.contains(&name) && !answered.contains(id) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
    false
}

pub(crate) fn has_active_problem(messages: &[Value]) -> bool {
    let mut clean_call_ids = std::collections::HashSet::new();
    for m in messages {
        if m.get("role").and_then(|r| r.as_str()) == Some("toolResult") {
            let is_error = m.get("isError").and_then(|e| e.as_bool()).unwrap_or(false);
            if !is_error {
                if let Some(id) = m.get("toolCallId").and_then(|i| i.as_str()) {
                    clean_call_ids.insert(id.to_string());
                }
            }
        }
    }

    for m in messages.iter().rev() {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role == "custom" {
            if m.get("customType").and_then(|c| c.as_str()) == Some("problem-dismissed") {
                return false;
            }
            continue;
        }
        if role == "assistant" {
            if let Some(content) = m.get("content").and_then(|c| c.as_array()) {
                for block in content.iter().rev() {
                    if block.get("type").and_then(|t| t.as_str()) != Some("toolCall") {
                        continue;
                    }
                    let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    let id = block.get("id").and_then(|i| i.as_str()).unwrap_or("");
                    if name == "conclude" {
                        if clean_call_ids.contains(id) {
                            return false;
                        }
                        continue;
                    }
                    if name == "problem" {
                        if clean_call_ids.contains(id) {
                            return true;
                        }
                        continue;
                    }
                }
            }
        }
    }
    false
}

pub(crate) fn derive_seed_rating(messages: &[Value]) -> i64 {
    let mut ratings = Vec::new();
    for m in messages {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role == "assistant" {
            if let Some(content) = m.get("content").and_then(|c| c.as_array()) {
                for block in content {
                    if block.get("type").and_then(|t| t.as_str()) == Some("toolCall") {
                        let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        if name == "explain" || name == "quiz" {
                            if let Some(pr) = block
                                .get("arguments")
                                .and_then(|a| a.get("priorRating"))
                                .and_then(|p| p.as_i64())
                            {
                                if (1..=4).contains(&pr) {
                                    ratings.push(pr);
                                }
                            }
                        }
                    }
                }
            }
        } else if role == "toolResult"
            || (role == "custom"
                && m.get("customType").and_then(|c| c.as_str()) == Some("lh_question_answered"))
        {
            if let Some(details) = m.get("details").and_then(|d| d.as_object()) {
                let q_type = details.get("questionType").and_then(|q| q.as_str());
                let kind = details.get("kind").and_then(|k| k.as_str());
                let is_quiz_or_check = q_type == Some("check")
                    || q_type == Some("transfer")
                    || (kind == Some("quiz") && q_type.is_none());
                if is_quiz_or_check {
                    let correct = details.get("correct").and_then(|c| c.as_bool());
                    let dont_know = details
                        .get("dontKnow")
                        .and_then(|d| d.as_bool())
                        .unwrap_or(false);
                    if correct.is_some() || dont_know {
                        let conf = details
                            .get("confidence")
                            .and_then(|c| c.as_f64())
                            .unwrap_or(50.0);
                        let r = if dont_know || correct == Some(false) {
                            1
                        } else if conf < 70.0 {
                            2
                        } else if conf >= 90.0 {
                            4
                        } else {
                            3
                        };
                        ratings.push(r);
                    }
                }
            }
        }
    }
    if ratings.is_empty() {
        return 3;
    }
    let sum: i64 = ratings.iter().sum();
    let avg = (sum as f64) / (ratings.len() as f64);
    avg.round().clamp(1.0, 4.0) as i64
}

pub(crate) struct PracticeRecordRow {
    pub(crate) chat_id: String,
    pub(crate) at_ms: i64,
    pub(crate) targets_json: String,
    pub(crate) outcome: String,
    pub(crate) rung: Option<String>,
    pub(crate) miss_class: Option<String>,
    pub(crate) missed_json: Option<String>,
    pub(crate) rating: Option<i64>,
}

pub(crate) fn extract_practice_records(
    chat_id: &str,
    messages: &[Value],
) -> Vec<PracticeRecordRow> {
    let mut clean_calls = std::collections::HashSet::new();
    for m in messages {
        if m.get("role").and_then(|r| r.as_str()) == Some("toolResult") {
            let is_error = m.get("isError").and_then(|e| e.as_bool()).unwrap_or(false);
            if !is_error {
                if let Some(id) = m.get("toolCallId").and_then(|i| i.as_str()) {
                    clean_calls.insert(id.to_string());
                }
            }
        }
    }

    struct Event {
        at: i64,
        order: usize,
        name: String,
        args: Value,
    }
    let mut events = Vec::new();
    for m in messages {
        if m.get("role").and_then(|r| r.as_str()) == Some("assistant") {
            let timestamp = m.get("timestamp").and_then(|t| t.as_i64()).unwrap_or(0);
            if let Some(content) = m.get("content").and_then(|c| c.as_array()) {
                for (order, block) in content.iter().enumerate() {
                    if block.get("type").and_then(|t| t.as_str()) == Some("toolCall") {
                        let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        let id = block.get("id").and_then(|i| i.as_str()).unwrap_or("");
                        if (name == "problem" || name == "conclude") && clean_calls.contains(id) {
                            let args = block.get("arguments").cloned().unwrap_or(Value::Null);
                            events.push(Event {
                                at: timestamp,
                                order,
                                name: name.to_string(),
                                args,
                            });
                        }
                    }
                }
            }
        }
    }
    events.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.order.cmp(&b.order)));

    let mut out = Vec::new();
    let mut active: Option<(Vec<String>, i64)> = None;
    for event in events {
        if event.name == "problem" {
            let targets = match event.args.get("target") {
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect(),
                Some(Value::String(s)) => vec![s.clone()],
                _ => vec![],
            };
            active = Some((targets, event.at));
            continue;
        }
        if let Some((targets, prob_at)) = active.take() {
            if targets.is_empty() {
                continue;
            }
            let outcome = event
                .args
                .get("outcome")
                .and_then(|o| o.as_str())
                .unwrap_or("");
            if ![
                "solved",
                "solvedWithHints",
                "movedOn",
                "surrendered",
                "dismissed",
            ]
            .contains(&outcome)
            {
                continue;
            }
            let rung = event
                .args
                .get("rung")
                .and_then(|r| r.as_str())
                .map(|s| s.to_string());
            let miss_class = event
                .args
                .get("missClass")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string());
            let missed_json = event
                .args
                .get("missed")
                .map(|m| serde_json::to_string(m).unwrap_or_default());
            let rating = event.args.get("rating").and_then(|r| r.as_i64());
            let at_ms = if event.at > 0 { event.at } else { prob_at };

            out.push(PracticeRecordRow {
                chat_id: chat_id.to_string(),
                at_ms,
                targets_json: serde_json::to_string(&targets).unwrap_or_else(|_| "[]".to_string()),
                outcome: outcome.to_string(),
                rung,
                miss_class,
                missed_json,
                rating,
            });
        }
    }
    out
}

pub(crate) fn extract_transcript_text(
    messages: &[Value],
    tree: Option<&Value>,
    extractions: Option<&Value>,
) -> String {
    let mut texts = Vec::new();
    for m in messages {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role == "user" {
            if let Some(content) = m.get("content") {
                if let Some(s) = content.as_str() {
                    texts.push(s.to_string());
                } else if let Some(arr) = content.as_array() {
                    for part in arr {
                        if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                                texts.push(t.to_string());
                            }
                        }
                    }
                }
            }
        } else if role == "assistant" {
            if let Some(content) = m.get("content").and_then(|c| c.as_array()) {
                for part in content {
                    if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                            texts.push(t.to_string());
                        }
                    }
                }
            }
        }
    }

    if let Some(t) = tree {
        if let Some(nodes) = t.get("nodes").and_then(|n| n.as_array()) {
            for node in nodes {
                if let Some(title) = node.get("title").and_then(|s| s.as_str()) {
                    texts.push(title.to_string());
                }
                if let Some(stmt) = node.get("statement").and_then(|s| s.as_str()) {
                    texts.push(stmt.to_string());
                }
            }
        }
    }

    if let Some(ext) = extractions {
        if let Some(runs) = ext.as_array() {
            for run in runs {
                if let Some(nodes) = run.get("nodes").and_then(|n| n.as_array()) {
                    for node in nodes {
                        if let Some(name) = node.get("name").and_then(|s| s.as_str()) {
                            texts.push(name.to_string());
                        }
                        if let Some(stmt) = node.get("statement").and_then(|s| s.as_str()) {
                            texts.push(stmt.to_string());
                        }
                    }
                }
            }
        }
    }

    texts.join(" ")
}

fn migrate_graph(tx: &Transaction, data_dir: &Path) -> Result<(), String> {
    let mut node_stmt = tx
        .prepare_cached(
            r#"
            INSERT INTO graph_nodes (id, name, statement, aliases_json, created_at, provenance_json)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
        )
        .map_err(|e| format!("Failed to prepare graph_nodes statement: {e}"))?;

    let mut node_fts_stmt = tx
        .prepare_cached(
            r#"
            INSERT INTO nodes_fts (node_id, name, statement, aliases_text)
            VALUES (?1, ?2, ?3, ?4)
            "#,
        )
        .map_err(|e| format!("Failed to prepare nodes_fts statement: {e}"))?;

    let mut chain_stmt = tx
        .prepare_cached(
            r#"
            INSERT INTO graph_chains (id, premises_json, conclusion, provenance_json, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
        )
        .map_err(|e| format!("Failed to prepare graph_chains statement: {e}"))?;

    let mut checkpoint_stmt = tx
        .prepare_cached(
            r#"
            INSERT INTO graph_checkpoints (chat_id, folded_at)
            VALUES (?1, ?2)
            "#,
        )
        .map_err(|e| format!("Failed to prepare graph_checkpoints statement: {e}"))?;

    let mut coverage_stmt = tx
        .prepare_cached(
            r#"
            INSERT INTO graph_coverage (chat_id, fp, tokens, folded_at)
            VALUES (?1, ?2, ?3, ?4)
            "#,
        )
        .map_err(|e| format!("Failed to prepare graph_coverage statement: {e}"))?;

    let mut regroup_stmt = tx
        .prepare_cached(
            r#"
            INSERT INTO graph_regroups (id, node_id, target_session_id, reason, regrouped_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
        )
        .map_err(|e| format!("Failed to prepare graph_regroups statement: {e}"))?;

    let mut source_stmt = tx
        .prepare_cached(
            r#"
            INSERT OR REPLACE INTO graph_sources (id, file_path, imported_at, extractions_json)
            VALUES (?1, ?2, ?3, ?4)
            "#,
        )
        .map_err(|e| format!("Failed to prepare graph_sources statement: {e}"))?;

    let mut pos_stmt = tx
        .prepare_cached(
            r#"
            INSERT OR REPLACE INTO graph_positions (node_id, x, y)
            VALUES (?1, ?2, ?3)
            "#,
        )
        .map_err(|e| format!("Failed to prepare graph_positions statement: {e}"))?;

    let mut event_stmt = tx
        .prepare_cached(
            r#"
            INSERT INTO graph_events (event_json)
            VALUES (?1)
            "#,
        )
        .map_err(|e| format!("Failed to prepare graph_events statement: {e}"))?;

    // 1. nodes.jsonl
    let nodes_path = data_dir.join("graph/nodes.jsonl");
    if nodes_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&nodes_path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let val: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(_) => continue, // Skip corrupt lines
                };
                if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                    let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let statement = val.get("statement").and_then(|v| v.as_str()).unwrap_or("");
                    let aliases_val = val.get("aliases").cloned().unwrap_or(Value::Array(vec![]));
                    let aliases_json = serde_json::to_string(&aliases_val).unwrap_or_default();
                    let aliases_text = aliases_val
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|a| a.as_str())
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or_default();
                    let created_at = val
                        .get("createdAt")
                        .and_then(|v| v.as_str())
                        .unwrap_or("2026-10-01T00:00:00Z");
                    let prov_val = val
                        .get("provenance")
                        .cloned()
                        .unwrap_or(Value::Array(vec![]));
                    let prov_json = serde_json::to_string(&prov_val).unwrap_or_default();

                    let _ = node_stmt.execute(params![
                        id,
                        name,
                        statement,
                        aliases_json,
                        created_at,
                        prov_json
                    ]);
                    let _ = node_fts_stmt.execute(params![id, name, statement, aliases_text]);
                }
            }
        }
    }

    // 2. chains.jsonl
    let chains_path = data_dir.join("graph/chains.jsonl");
    if chains_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&chains_path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let val: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                    let premises_val = val.get("premises").cloned().unwrap_or(Value::Array(vec![]));
                    let premises_json = serde_json::to_string(&premises_val).unwrap_or_default();
                    let conclusion = val.get("conclusion").and_then(|v| v.as_str()).unwrap_or("");
                    let prov_val = val
                        .get("provenance")
                        .cloned()
                        .unwrap_or(Value::Array(vec![]));
                    let prov_json = serde_json::to_string(&prov_val).unwrap_or_default();
                    let created_at = val
                        .get("createdAt")
                        .and_then(|v| v.as_str())
                        .unwrap_or("2026-10-01T00:00:00Z");

                    let _ = chain_stmt.execute(params![
                        id,
                        premises_json,
                        conclusion,
                        prov_json,
                        created_at
                    ]);
                }
            }
        }
    }

    // 3. sessions.jsonl
    let sessions_path = data_dir.join("graph/sessions.jsonl");
    if sessions_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&sessions_path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let val: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(chat_id) = val.get("chatId").and_then(|v| v.as_str()) {
                    let folded_at = val
                        .get("foldedAt")
                        .and_then(|v| v.as_str())
                        .unwrap_or("2026-10-01T00:00:00Z");
                    let _ = checkpoint_stmt.execute(params![chat_id, folded_at]);
                }
            }
        }
    }

    // 4. coverage.jsonl
    let cov_path = data_dir.join("graph/coverage.jsonl");
    if cov_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&cov_path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let val: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(chat_id) = val.get("chatId").and_then(|v| v.as_str()) {
                    let fp = val.get("fp").and_then(|v| v.as_str()).unwrap_or("");
                    let tokens = val.get("tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                    let folded_at = val
                        .get("foldedAt")
                        .and_then(|v| v.as_str())
                        .unwrap_or("2026-10-01T00:00:00Z");
                    let _ = coverage_stmt.execute(params![chat_id, fp, tokens, folded_at]);
                }
            }
        }
    }

    // 5. regroups.jsonl
    let regroups_path = data_dir.join("graph/regroups.jsonl");
    if regroups_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&regroups_path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let val: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                    let node_id = val.get("nodeId").and_then(|v| v.as_str()).unwrap_or("");
                    let target_session_id = val
                        .get("targetSessionId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let reason = val.get("reason").and_then(|v| v.as_str()).unwrap_or("");
                    let regrouped_at = val
                        .get("regroupedAt")
                        .and_then(|v| v.as_str())
                        .unwrap_or("2026-10-01T00:00:00Z");
                    let _ = regroup_stmt.execute(params![
                        id,
                        node_id,
                        target_session_id,
                        reason,
                        regrouped_at
                    ]);
                }
            }
        }
    }

    // 6. sources.json
    let sources_path = data_dir.join("graph/sources.json");
    if sources_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&sources_path) {
            if let Ok(Value::Object(map)) = serde_json::from_str(&content) {
                for (id, src_val) in map {
                    let file_path = src_val
                        .get("filePath")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let imported_at = src_val
                        .get("importedAt")
                        .and_then(|v| v.as_str())
                        .unwrap_or("2026-10-01T00:00:00Z");
                    let extractions_json = src_val
                        .get("extractions")
                        .map(|v| serde_json::to_string(v).unwrap_or_default());
                    let _ =
                        source_stmt.execute(params![id, file_path, imported_at, extractions_json]);
                }
            }
        }
    }

    // 7. positions.json
    let pos_path = data_dir.join("graph/positions.json");
    if pos_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&pos_path) {
            if let Ok(Value::Object(map)) = serde_json::from_str(&content) {
                for (node_id, p_val) in map {
                    let x = p_val.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let y = p_val.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let _ = pos_stmt.execute(params![node_id, x, y]);
                }
            }
        }
    }

    // 8. knowledge-graph.jsonl
    let kg_path = data_dir.join("knowledge-graph.jsonl");
    if kg_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&kg_path) {
            // Check if whole content is snapshot { "nodes": [...], "edges": [...] }
            let parsed_snapshot: Result<Value, _> = serde_json::from_str(&content);
            if let Ok(Value::Object(obj)) = parsed_snapshot {
                if let Some(nodes) = obj.get("nodes").and_then(|n| n.as_array()) {
                    for node in nodes {
                        if let Some(id) = node.get("id").and_then(|v| v.as_str()) {
                            let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            let statement =
                                node.get("statement").and_then(|v| v.as_str()).unwrap_or("");
                            let aliases_val =
                                node.get("aliases").cloned().unwrap_or(Value::Array(vec![]));
                            let aliases_json =
                                serde_json::to_string(&aliases_val).unwrap_or_default();
                            let aliases_text = aliases_val
                                .as_array()
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|a| a.as_str())
                                        .collect::<Vec<_>>()
                                        .join(" ")
                                })
                                .unwrap_or_default();
                            let created_at = node
                                .get("createdAt")
                                .and_then(|v| v.as_str())
                                .unwrap_or("2026-10-01T00:00:00Z");
                            let prov_val = node
                                .get("provenance")
                                .cloned()
                                .unwrap_or(Value::Array(vec![]));
                            let prov_json = serde_json::to_string(&prov_val).unwrap_or_default();

                            let _ = node_stmt.execute(params![
                                id,
                                name,
                                statement,
                                aliases_json,
                                created_at,
                                prov_json
                            ]);
                            let _ =
                                node_fts_stmt.execute(params![id, name, statement, aliases_text]);
                        }
                    }
                }
                if let Some(edges) = obj.get("edges").and_then(|e| e.as_array()) {
                    for edge in edges {
                        if let Some(id) = edge.get("id").and_then(|v| v.as_str()) {
                            let premises_val = edge
                                .get("premises")
                                .cloned()
                                .unwrap_or(Value::Array(vec![]));
                            let premises_json =
                                serde_json::to_string(&premises_val).unwrap_or_default();
                            let conclusion = edge
                                .get("conclusion")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let prov_val = edge
                                .get("provenance")
                                .cloned()
                                .unwrap_or(Value::Array(vec![]));
                            let prov_json = serde_json::to_string(&prov_val).unwrap_or_default();
                            let created_at = edge
                                .get("createdAt")
                                .and_then(|v| v.as_str())
                                .unwrap_or("2026-10-01T00:00:00Z");

                            let _ = chain_stmt.execute(params![
                                id,
                                premises_json,
                                conclusion,
                                prov_json,
                                created_at
                            ]);
                        }
                    }
                }
            } else {
                // Line by line JSONL
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let val: Value = match serde_json::from_str(trimmed) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let typ = val.get("type").and_then(|v| v.as_str());
                    if typ == Some("node")
                        || (typ.is_none()
                            && val.get("id").is_some()
                            && val.get("statement").is_some())
                    {
                        if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                            let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            let statement =
                                val.get("statement").and_then(|v| v.as_str()).unwrap_or("");
                            let aliases_val =
                                val.get("aliases").cloned().unwrap_or(Value::Array(vec![]));
                            let aliases_json =
                                serde_json::to_string(&aliases_val).unwrap_or_default();
                            let aliases_text = aliases_val
                                .as_array()
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|a| a.as_str())
                                        .collect::<Vec<_>>()
                                        .join(" ")
                                })
                                .unwrap_or_default();
                            let created_at = val
                                .get("createdAt")
                                .and_then(|v| v.as_str())
                                .unwrap_or("2026-10-01T00:00:00Z");
                            let prov_val = val
                                .get("provenance")
                                .cloned()
                                .unwrap_or(Value::Array(vec![]));
                            let prov_json = serde_json::to_string(&prov_val).unwrap_or_default();

                            let _ = node_stmt.execute(params![
                                id,
                                name,
                                statement,
                                aliases_json,
                                created_at,
                                prov_json
                            ]);
                            let _ =
                                node_fts_stmt.execute(params![id, name, statement, aliases_text]);
                        }
                    } else if typ == Some("edge")
                        || typ == Some("chain")
                        || val.get("conclusion").is_some()
                    {
                        if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                            let premises_val =
                                val.get("premises").cloned().unwrap_or(Value::Array(vec![]));
                            let premises_json =
                                serde_json::to_string(&premises_val).unwrap_or_default();
                            let conclusion =
                                val.get("conclusion").and_then(|v| v.as_str()).unwrap_or("");
                            let prov_val = val
                                .get("provenance")
                                .cloned()
                                .unwrap_or(Value::Array(vec![]));
                            let prov_json = serde_json::to_string(&prov_val).unwrap_or_default();
                            let created_at = val
                                .get("createdAt")
                                .and_then(|v| v.as_str())
                                .unwrap_or("2026-10-01T00:00:00Z");

                            let _ = chain_stmt.execute(params![
                                id,
                                premises_json,
                                conclusion,
                                prov_json,
                                created_at
                            ]);
                        }
                    }
                }
            }
        }
    }

    // 9. knowledge-graph-events.jsonl
    let events_path = data_dir.join("knowledge-graph-events.jsonl");
    if events_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&events_path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let _ = event_stmt.execute(params![trimmed]);
            }
        }
    }

    Ok(())
}

fn migrate_jobs(tx: &Transaction, data_dir: &Path) -> Result<(), String> {
    let jobs_dir = data_dir.join("jobs");
    if !jobs_dir.exists() {
        return Ok(());
    }
    let entries = match std::fs::read_dir(&jobs_dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };

    let mut job_stmt = tx
        .prepare_cached(
            r#"
            INSERT OR REPLACE INTO jobs (
                id, kind, chat_id, tool_call_id, status, activity, created_at, updated_at, record_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
        )
        .map_err(|e| format!("Failed to prepare jobs statement: {e}"))?;

    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() || p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = match std::fs::read_to_string(&p) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let val: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
            let kind = val.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let chat_id = val.get("chatId").and_then(|v| v.as_str()).unwrap_or("");
            let tool_call_id = val.get("toolCallId").and_then(|v| v.as_str()).unwrap_or("");
            let status = val.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let activity = val.get("activity").and_then(|v| v.as_str()).unwrap_or("");
            let created_at = val
                .get("createdAt")
                .and_then(|v| v.as_str())
                .unwrap_or("2026-10-01T00:00:00Z");
            let updated_at = val
                .get("updatedAt")
                .and_then(|v| v.as_str())
                .unwrap_or(created_at);

            let _ = job_stmt.execute(params![
                id,
                kind,
                chat_id,
                tool_call_id,
                status,
                activity,
                created_at,
                updated_at,
                raw
            ]);
        }
    }

    Ok(())
}

fn migrate_study(tx: &Transaction, data_dir: &Path) -> Result<(), String> {
    let mut interval_stmt = tx
        .prepare_cached(
            r#"
            INSERT INTO study_intervals (chat_id, start_iso, end_iso, end_reason)
            VALUES (?1, ?2, ?3, ?4)
            "#,
        )
        .map_err(|e| format!("Failed to prepare study_intervals statement: {e}"))?;

    let intervals_path = data_dir.join("study/intervals.jsonl");
    if intervals_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&intervals_path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let val: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(chat_id) = val.get("chatId").and_then(|v| v.as_str()) {
                    let start = val.get("start").and_then(|v| v.as_str()).unwrap_or("");
                    let end = val.get("end").and_then(|v| v.as_str()).unwrap_or("");
                    let end_reason = val
                        .get("endReason")
                        .and_then(|v| v.as_str())
                        .unwrap_or("stop");
                    let _ = interval_stmt.execute(params![chat_id, start, end, end_reason]);
                }
            }
        }
    }

    let open_path = data_dir.join("study/open.json");
    if open_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&open_path) {
            let now_ms = current_time_ms();
            let _ = tx.execute(
                "INSERT OR REPLACE INTO kv_documents (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
                params!["study_open", content, now_ms],
            );
        }
    }

    let study_json_path = data_dir.join("study.json");
    if study_json_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&study_json_path) {
            let _ = tx.execute(
                "INSERT OR REPLACE INTO study_materials (id, content_json) VALUES (?1, ?2)",
                params!["default", content],
            );
        }
    }

    Ok(())
}

fn migrate_prompts(tx: &Transaction, data_dir: &Path) -> Result<(), String> {
    let mut prompt_stmt = tx
        .prepare_cached(
            r#"
            INSERT OR REPLACE INTO prompt_overrides (segment_path, content)
            VALUES (?1, ?2)
            "#,
        )
        .map_err(|e| format!("Failed to prepare prompt_overrides statement: {e}"))?;

    let prompts_dir = data_dir.join("prompts");
    if prompts_dir.exists() {
        walk_prompts(&prompts_dir, "", &mut |segment_path, content| {
            let _ = prompt_stmt.execute(params![segment_path, content]);
        });
    }

    let prompt_json = data_dir.join("prompt-overrides.json");
    if prompt_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&prompt_json) {
            if let Ok(Value::Object(map)) = serde_json::from_str(&content) {
                for (k, v) in map {
                    if let Some(text) = v.as_str() {
                        let _ = prompt_stmt.execute(params![k, text]);
                    }
                }
            }
        }
    }

    Ok(())
}

fn walk_prompts(dir: &Path, prefix: &str, callback: &mut dyn FnMut(&str, &str)) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let rel = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };
        if p.is_dir() {
            walk_prompts(&p, &rel, callback);
        } else if p.is_file() && name.ends_with(".md") {
            if let Ok(content) = std::fs::read_to_string(&p) {
                callback(&rel, &content);
            }
        }
    }
}

fn migrate_kv_documents(tx: &Transaction, data_dir: &Path) -> Result<(), String> {
    let now_ms = current_time_ms();
    let mut kv_stmt = tx
        .prepare_cached(
            r#"
            INSERT OR REPLACE INTO kv_documents (key, value_json, updated_at)
            VALUES (?1, ?2, ?3)
            "#,
        )
        .map_err(|e| format!("Failed to prepare kv_documents statement: {e}"))?;

    let settings_path = data_dir.join("settings.json");
    if settings_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&settings_path) {
            let _ = kv_stmt.execute(params!["settings", content, now_ms]);
        }
    }

    let render_path = if data_dir.join("graph/render-settings.json").exists() {
        data_dir.join("graph/render-settings.json")
    } else {
        data_dir.join("render-settings.json")
    };
    if render_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&render_path) {
            let _ = kv_stmt.execute(params!["render_settings", content, now_ms]);
        }
    }

    let source_org_path = if data_dir.join("graph/source-organization.json").exists() {
        data_dir.join("graph/source-organization.json")
    } else {
        data_dir.join("source-organization.json")
    };
    if source_org_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&source_org_path) {
            let _ = kv_stmt.execute(params!["source_organization", content, now_ms]);
        }
    }

    let profiler_path = data_dir.join("profiler-state.json");
    if profiler_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&profiler_path) {
            let _ = kv_stmt.execute(params!["profiler_state", content, now_ms]);
        }
    }

    Ok(())
}

pub(crate) fn materialize_fsrs_cards(tx: &Connection) -> Result<(), String> {
    tx.execute(
        "DELETE FROM fsrs_cards WHERE node_id NOT IN (SELECT id FROM graph_nodes)",
        [],
    )
    .map_err(|e| format!("Failed to prune orphaned fsrs_cards: {e}"))?;

    struct NodeData {
        created_at_ms: i64,
        chat_id: String,
    }
    let mut nodes_map = std::collections::HashMap::new();
    {
        let mut stmt = tx
            .prepare("SELECT id, created_at, provenance_json FROM graph_nodes ORDER BY seq ASC")
            .map_err(|e| format!("Failed to query graph_nodes: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let created_at: String = row.get(1)?;
                let prov_json: String = row.get(2)?;
                Ok((id, created_at, prov_json))
            })
            .map_err(|e| format!("Failed to read graph_nodes: {e}"))?;

        let now_ms = current_time_ms();
        for r in rows.flatten() {
            let (id, created_at, prov_json) = r;
            let prov: Value = serde_json::from_str(&prov_json).unwrap_or(Value::Array(vec![]));
            let chat_id = prov
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|item| item.get("chatId"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            let created_at_ms = parse_iso_timestamp(&created_at, now_ms);
            nodes_map.insert(
                id,
                NodeData {
                    created_at_ms,
                    chat_id,
                },
            );
        }
    }

    if nodes_map.is_empty() {
        return Ok(());
    }

    let mut teach_chats = std::collections::HashMap::new();
    {
        let mut stmt = tx
            .prepare("SELECT id, seed_rating FROM chats WHERE kind = 'teach'")
            .map_err(|e| format!("Failed to query chats: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let rating: i64 = row.get(1)?;
                Ok((id, rating))
            })
            .map_err(|e| format!("Failed to read chats: {e}"))?;
        for r in rows.flatten() {
            teach_chats.insert(r.0, r.1);
        }
    }

    struct CardState {
        node_id: String,
        stability: Option<f64>,
        difficulty: Option<f64>,
        last_review_ms: Option<i64>,
        reviews: i64,
        due_at_ms: f64,
        lane: String,
        seed_rating: i64,
        stage: String,
        anchor_ms: i64,
    }

    let mut cards: std::collections::HashMap<String, CardState> = std::collections::HashMap::new();
    for (node_id, node) in &nodes_map {
        let is_teach = teach_chats.is_empty()
            || teach_chats.contains_key(&node.chat_id)
            || node.chat_id.is_empty();
        if !is_teach {
            continue;
        }
        let seed_rating = teach_chats
            .get(&node.chat_id)
            .copied()
            .unwrap_or(3)
            .clamp(1, 4);
        let due_at_ms = node.created_at_ms as f64 + FSRS_W[(seed_rating - 1) as usize] * DAY_MS;
        cards.insert(
            node_id.clone(),
            CardState {
                node_id: node_id.clone(),
                stability: None,
                difficulty: None,
                last_review_ms: None,
                reviews: 0,
                due_at_ms,
                lane: "new".to_string(),
                seed_rating,
                stage: "practiced".to_string(),
                anchor_ms: node.created_at_ms,
            },
        );
    }

    struct PracticeRow {
        chat_id: String,
        at_ms: i64,
        targets: Vec<String>,
        outcome: String,
        rung: Option<String>,
        miss_class: Option<String>,
        missed: Vec<String>,
        rating: Option<i64>,
    }
    let mut records = Vec::new();
    {
        let mut stmt = tx
            .prepare(
                r#"
                SELECT chat_id, at_ms, targets_json, outcome, rung, miss_class, missed_json, rating
                FROM practice_records ORDER BY at_ms ASC
                "#,
            )
            .map_err(|e| format!("Failed to query practice_records: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let chat_id: String = row.get(0)?;
                let at_ms: i64 = row.get(1)?;
                let targets_json: String = row.get(2)?;
                let outcome: String = row.get(3)?;
                let rung: Option<String> = row.get(4)?;
                let miss_class: Option<String> = row.get(5)?;
                let missed_json: Option<String> = row.get(6)?;
                let rating: Option<i64> = row.get(7)?;
                Ok((
                    chat_id,
                    at_ms,
                    targets_json,
                    outcome,
                    rung,
                    miss_class,
                    missed_json,
                    rating,
                ))
            })
            .map_err(|e| format!("Failed to read practice_records: {e}"))?;

        for r in rows.flatten() {
            let (chat_id, at_ms, targets_json, outcome, rung, miss_class, missed_json, rating) = r;
            let targets: Vec<String> = serde_json::from_str(&targets_json).unwrap_or_default();
            let missed: Vec<String> = missed_json
                .and_then(|m| serde_json::from_str(&m).ok())
                .unwrap_or_default();
            records.push(PracticeRow {
                chat_id,
                at_ms,
                targets,
                outcome,
                rung,
                miss_class,
                missed,
                rating,
            });
        }
    }

    let mut seen = std::collections::HashSet::new();
    let retention = 0.9_f64;
    let factor = (0.9_f64).powf(-1.0 / FSRS_W[20]) - 1.0;

    for rec in records {
        for target in &rec.targets {
            let dedupe_key = format!("{}\0{}", rec.chat_id, target);
            if seen.contains(&dedupe_key) {
                continue;
            }
            seen.insert(dedupe_key);

            let card = match cards.get_mut(target) {
                Some(c) => c,
                None => continue,
            };

            let rating = match review_rating(
                &rec.outcome,
                rec.rung.as_deref(),
                rec.miss_class.as_deref(),
                &rec.missed,
                rec.rating,
                target,
            ) {
                Some(r) => r,
                None => continue,
            };

            let born_at = nodes_map
                .get(target)
                .map(|n| n.created_at_ms)
                .unwrap_or(rec.at_ms);
            let elapsed_days = match card.last_review_ms {
                None => ((rec.at_ms - born_at) as f64 / DAY_MS).max(0.0),
                Some(last) => ((rec.at_ms - last) as f64 / DAY_MS).max(0.0),
            };

            let prev = match (card.stability, card.difficulty) {
                (Some(s), Some(d)) => Some((s, d)),
                _ => None,
            };

            let (next_s, next_d) = fsrs_update(prev, rating, elapsed_days);
            let prior_stage = card.stage.clone();
            let mut stage = card.stage.clone();
            let mut anchor = card.anchor_ms;

            if rating == 1 {
                stage = "practiced".to_string();
                anchor = rec.at_ms;
            } else if rating >= 3 {
                let since = rec.at_ms - anchor;
                if since >= (7.0 * DAY_MS) as i64
                    && (prior_stage == "demonstrated" || prior_stage == "retained")
                {
                    stage = "retained".to_string();
                } else if since >= DAY_MS as i64 && prior_stage == "practiced" {
                    stage = "demonstrated".to_string();
                    anchor = rec.at_ms;
                }
            }

            let interval_days = next_s / factor * (retention.powf(-1.0 / FSRS_W[20]) - 1.0);
            card.stability = Some(next_s);
            card.difficulty = Some(next_d);
            card.last_review_ms = Some(rec.at_ms);
            card.reviews += 1;
            card.due_at_ms = rec.at_ms as f64 + interval_days * DAY_MS;
            card.lane = "review".to_string();
            card.stage = stage;
            card.anchor_ms = anchor;
        }
    }

    let mut insert_stmt = tx
        .prepare_cached(
            r#"
            INSERT OR REPLACE INTO fsrs_cards (
                node_id, stability, difficulty, last_review_ms, reviews, due_at_ms, lane, seed_rating, stage
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
        )
        .map_err(|e| format!("Failed to prepare fsrs_cards insert: {e}"))?;

    for card in cards.values() {
        insert_stmt
            .execute(params![
                card.node_id,
                card.stability,
                card.difficulty,
                card.last_review_ms,
                card.reviews,
                card.due_at_ms,
                card.lane,
                card.seed_rating,
                card.stage,
            ])
            .map_err(|e| format!("Failed to insert fsrs_card {}: {e}", card.node_id))?;
    }

    Ok(())
}
