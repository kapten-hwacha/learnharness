use crate::storage::DbState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSearchHit {
    pub node_id: String,
    pub name: String,
    pub statement: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeHistoryResult {
    pub records: Vec<Value>,
    pub teach_chat_ids: Vec<String>,
    pub teach_ratings: HashMap<String, i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGraphSnapshot {
    pub nodes: Vec<Value>,
    pub chains: Vec<Value>,
    pub sessions: Vec<Value>,
    pub coverage: Vec<Value>,
    pub regroups: Vec<Value>,
    pub sources: HashMap<String, Value>,
    pub positions: HashMap<String, Value>,
}

pub fn append_node(conn: &mut Connection, node: &Value) -> Result<(), String> {
    let id = node
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing id in node".to_string())?;
    let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let statement = node.get("statement").and_then(|v| v.as_str()).unwrap_or("");
    let aliases = node.get("aliases").cloned().unwrap_or(json!([]));
    let aliases_json = serde_json::to_string(&aliases).unwrap_or_else(|_| "[]".to_string());
    let aliases_text = aliases
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    let created_at = node
        .get("createdAt")
        .and_then(|v| v.as_str())
        .unwrap_or("2026-10-01T00:00:00Z");
    let provenance = node.get("provenance").cloned().unwrap_or(json!([]));
    let prov_json = serde_json::to_string(&provenance).unwrap_or_else(|_| "[]".to_string());

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin tx: {e}"))?;

    tx.execute(
        r#"
        INSERT INTO graph_nodes (id, name, statement, aliases_json, created_at, provenance_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
        params![id, name, statement, aliases_json, created_at, prov_json],
    )
    .map_err(|e| format!("Failed to insert graph_node: {e}"))?;

    tx.execute(
        r#"
        INSERT INTO nodes_fts (node_id, name, statement, aliases_text)
        VALUES (?1, ?2, ?3, ?4)
        "#,
        params![id, name, statement, aliases_text],
    )
    .map_err(|e| format!("Failed to insert nodes_fts: {e}"))?;

    crate::storage::migrate::materialize_fsrs_cards(&tx)?;

    tx.commit()
        .map_err(|e| format!("Failed to commit append_node: {e}"))?;
    Ok(())
}

pub fn read_nodes(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, name, statement, aliases_json, created_at, provenance_json
            FROM graph_nodes
            ORDER BY seq ASC
            "#,
        )
        .map_err(|e| format!("Failed to prepare read_nodes: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let statement: String = row.get(2)?;
            let aliases_json: String = row.get(3)?;
            let created_at: String = row.get(4)?;
            let prov_json: String = row.get(5)?;

            let aliases: Value = serde_json::from_str(&aliases_json).unwrap_or(json!([]));
            let provenance: Value = serde_json::from_str(&prov_json).unwrap_or(json!([]));

            Ok(json!({
                "id": id,
                "name": name,
                "statement": statement,
                "aliases": aliases,
                "createdAt": created_at,
                "provenance": provenance
            }))
        })
        .map_err(|e| format!("Failed to query graph_nodes: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Error reading node row: {e}"))?);
    }
    Ok(out)
}

pub fn append_chain(conn: &Connection, chain: &Value) -> Result<(), String> {
    let id = chain
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing id in chain".to_string())?;
    let premises = chain.get("premises").cloned().unwrap_or(json!([]));
    let premises_json = serde_json::to_string(&premises).unwrap_or_else(|_| "[]".to_string());
    let conclusion = chain
        .get("conclusion")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let provenance = chain.get("provenance").cloned().unwrap_or(json!([]));
    let prov_json = serde_json::to_string(&provenance).unwrap_or_else(|_| "[]".to_string());
    let created_at = chain
        .get("createdAt")
        .and_then(|v| v.as_str())
        .unwrap_or("2026-10-01T00:00:00Z");

    conn.execute(
        r#"
        INSERT INTO graph_chains (id, premises_json, conclusion, provenance_json, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        "#,
        params![id, premises_json, conclusion, prov_json, created_at],
    )
    .map_err(|e| format!("Failed to insert chain: {e}"))?;

    Ok(())
}

pub fn read_chains(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, premises_json, conclusion, provenance_json, created_at
            FROM graph_chains
            ORDER BY seq ASC
            "#,
        )
        .map_err(|e| format!("Failed to prepare read_chains: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let premises_json: String = row.get(1)?;
            let conclusion: String = row.get(2)?;
            let prov_json: String = row.get(3)?;
            let created_at: String = row.get(4)?;

            let premises: Value = serde_json::from_str(&premises_json).unwrap_or(json!([]));
            let provenance: Value = serde_json::from_str(&prov_json).unwrap_or(json!([]));

            Ok(json!({
                "id": id,
                "premises": premises,
                "conclusion": conclusion,
                "provenance": provenance,
                "createdAt": created_at
            }))
        })
        .map_err(|e| format!("Failed to query graph_chains: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Error reading chain: {e}"))?);
    }
    Ok(out)
}

pub fn append_checkpoint(conn: &Connection, checkpoint: &Value) -> Result<(), String> {
    let chat_id = checkpoint
        .get("chatId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing chatId in checkpoint".to_string())?;
    let folded_at = checkpoint
        .get("foldedAt")
        .and_then(|v| v.as_str())
        .unwrap_or("2026-10-01T00:00:00Z");

    conn.execute(
        "INSERT INTO graph_checkpoints (chat_id, folded_at) VALUES (?1, ?2)",
        params![chat_id, folded_at],
    )
    .map_err(|e| format!("Failed to insert checkpoint: {e}"))?;

    Ok(())
}

pub fn read_checkpoints(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT chat_id, folded_at FROM graph_checkpoints ORDER BY seq ASC")
        .map_err(|e| format!("Failed to prepare read_checkpoints: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let chat_id: String = row.get(0)?;
            let folded_at: String = row.get(1)?;
            Ok(json!({
                "chatId": chat_id,
                "foldedAt": folded_at
            }))
        })
        .map_err(|e| format!("Failed to query checkpoints: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Error reading checkpoint: {e}"))?);
    }
    Ok(out)
}

pub fn append_coverage(conn: &Connection, entry: &Value) -> Result<(), String> {
    let chat_id = entry
        .get("chatId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing chatId in coverage".to_string())?;
    let fp = entry.get("fp").and_then(|v| v.as_str()).unwrap_or("");
    let tokens = entry.get("tokens").and_then(|v| v.as_i64()).unwrap_or(0);
    let folded_at = entry
        .get("foldedAt")
        .and_then(|v| v.as_str())
        .unwrap_or("2026-10-01T00:00:00Z");

    conn.execute(
        "INSERT INTO graph_coverage (chat_id, fp, tokens, folded_at) VALUES (?1, ?2, ?3, ?4)",
        params![chat_id, fp, tokens, folded_at],
    )
    .map_err(|e| format!("Failed to insert coverage: {e}"))?;

    Ok(())
}

pub fn read_coverage(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT chat_id, fp, tokens, folded_at FROM graph_coverage ORDER BY seq ASC")
        .map_err(|e| format!("Failed to prepare read_coverage: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let chat_id: String = row.get(0)?;
            let fp: String = row.get(1)?;
            let tokens: i64 = row.get(2)?;
            let folded_at: String = row.get(3)?;
            Ok(json!({
                "chatId": chat_id,
                "fp": fp,
                "tokens": tokens,
                "foldedAt": folded_at
            }))
        })
        .map_err(|e| format!("Failed to query coverage: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Error reading coverage: {e}"))?);
    }
    Ok(out)
}

pub fn append_regroup(conn: &Connection, regroup: &Value) -> Result<(), String> {
    let id = regroup
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing id in regroup".to_string())?;
    let node_id = regroup.get("nodeId").and_then(|v| v.as_str()).unwrap_or("");
    let target_session_id = regroup
        .get("targetSessionId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let reason = regroup.get("reason").and_then(|v| v.as_str()).unwrap_or("");
    let regrouped_at = regroup
        .get("regroupedAt")
        .and_then(|v| v.as_str())
        .unwrap_or("2026-10-01T00:00:00Z");

    conn.execute(
        r#"
        INSERT INTO graph_regroups (id, node_id, target_session_id, reason, regrouped_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        "#,
        params![id, node_id, target_session_id, reason, regrouped_at],
    )
    .map_err(|e| format!("Failed to insert regroup: {e}"))?;

    Ok(())
}

pub fn read_regroups(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, node_id, target_session_id, reason, regrouped_at
            FROM graph_regroups
            ORDER BY seq ASC
            "#,
        )
        .map_err(|e| format!("Failed to prepare read_regroups: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let node_id: String = row.get(1)?;
            let target_session_id: String = row.get(2)?;
            let reason: String = row.get(3)?;
            let regrouped_at: String = row.get(4)?;
            Ok(json!({
                "id": id,
                "nodeId": node_id,
                "targetSessionId": target_session_id,
                "reason": reason,
                "regroupedAt": regrouped_at
            }))
        })
        .map_err(|e| format!("Failed to query regroups: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Error reading regroup: {e}"))?);
    }
    Ok(out)
}

pub fn upsert_source(conn: &Connection, source: &Value) -> Result<(), String> {
    let id = source
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing id in source".to_string())?;
    let file_path = source
        .get("filePath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let imported_at = source
        .get("importedAt")
        .and_then(|v| v.as_str())
        .unwrap_or("2026-10-01T00:00:00Z");

    // Preserve existing extractions if source didn't provide any
    let extractions = source.get("extractions");
    let extractions_json = match extractions {
        Some(e) if !e.is_null() => Some(serde_json::to_string(e).unwrap_or_default()),
        _ => conn
            .query_row(
                "SELECT extractions_json FROM graph_sources WHERE id = ?1",
                params![id],
                |r| r.get::<_, Option<String>>(0),
            )
            .unwrap_or(None),
    };

    conn.execute(
        r#"
        INSERT OR REPLACE INTO graph_sources (id, file_path, imported_at, extractions_json)
        VALUES (?1, ?2, ?3, ?4)
        "#,
        params![id, file_path, imported_at, extractions_json],
    )
    .map_err(|e| format!("Failed to upsert source: {e}"))?;

    Ok(())
}

pub fn read_sources(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT id, file_path, imported_at, extractions_json FROM graph_sources")
        .map_err(|e| format!("Failed to prepare read_sources: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let file_path: String = row.get(1)?;
            let imported_at: String = row.get(2)?;
            let ext_json: Option<String> = row.get(3)?;

            let mut obj = json!({
                "id": id,
                "filePath": file_path,
                "importedAt": imported_at
            });
            if let Some(ej) = ext_json {
                if let Ok(ext) = serde_json::from_str::<Value>(&ej) {
                    obj["extractions"] = ext;
                }
            }
            Ok(obj)
        })
        .map_err(|e| format!("Failed to query sources: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Error reading source: {e}"))?);
    }
    Ok(out)
}

pub fn read_source_map(conn: &Connection) -> Result<HashMap<String, Value>, String> {
    let sources = read_sources(conn)?;
    let mut map = HashMap::new();
    for s in sources {
        if let Some(id) = s.get("id").and_then(|v| v.as_str()) {
            map.insert(id.to_string(), s);
        }
    }
    Ok(map)
}

pub fn delete_sources(conn: &Connection, ids: &[String]) -> Result<usize, String> {
    let mut deleted = 0;
    for id in ids {
        let count = conn
            .execute("DELETE FROM graph_sources WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete source {id}: {e}"))?;
        deleted += count;
    }
    Ok(deleted)
}

pub fn append_source_usage(conn: &mut Connection, id: &str, entry: &Value) -> Result<(), String> {
    let ext_opt: Option<String> = conn
        .query_row(
            "SELECT extractions_json FROM graph_sources WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| format!("Source not found: {e}"))?;

    let mut list = ext_opt
        .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
        .unwrap_or_default();

    let started_at = entry
        .get("startedAt")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let already_present = list
        .iter()
        .any(|e| e.get("startedAt").and_then(|v| v.as_str()) == Some(started_at));

    if !already_present {
        list.push(entry.clone());
        let updated_json = serde_json::to_string(&list).unwrap_or_default();
        conn.execute(
            "UPDATE graph_sources SET extractions_json = ?1 WHERE id = ?2",
            params![updated_json, id],
        )
        .map_err(|e| format!("Failed to update extractions: {e}"))?;
    }
    Ok(())
}

pub fn read_positions(conn: &Connection) -> Result<HashMap<String, Value>, String> {
    let mut stmt = conn
        .prepare("SELECT node_id, x, y FROM graph_positions")
        .map_err(|e| format!("Failed to prepare read_positions: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let node_id: String = row.get(0)?;
            let x: f64 = row.get(1)?;
            let y: f64 = row.get(2)?;
            Ok((node_id, json!({ "x": x, "y": y })))
        })
        .map_err(|e| format!("Failed to query positions: {e}"))?;

    let mut map = HashMap::new();
    for r in rows {
        let (id, val) = r.map_err(|e| format!("Error reading position: {e}"))?;
        map.insert(id, val);
    }
    Ok(map)
}

pub fn write_positions(
    conn: &mut Connection,
    positions: &HashMap<String, Value>,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin tx: {e}"))?;

    tx.execute("DELETE FROM graph_positions", [])
        .map_err(|e| format!("Failed to clear positions: {e}"))?;

    for (node_id, pos) in positions {
        let x = pos.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let y = pos.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        tx.execute(
            "INSERT INTO graph_positions (node_id, x, y) VALUES (?1, ?2, ?3)",
            params![node_id, x, y],
        )
        .map_err(|e| format!("Failed to insert position: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit positions: {e}"))?;
    Ok(())
}

pub fn rewrite_ledgers(conn: &mut Connection, next: &Value) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin tx: {e}"))?;

    if let Some(nodes) = next.get("nodes").and_then(|v| v.as_array()) {
        tx.execute("DELETE FROM graph_nodes", [])
            .map_err(|e| format!("Failed to clear graph_nodes: {e}"))?;
        tx.execute("DELETE FROM nodes_fts", [])
            .map_err(|e| format!("Failed to clear nodes_fts: {e}"))?;

        for node in nodes {
            let id = node.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let statement = node.get("statement").and_then(|v| v.as_str()).unwrap_or("");
            let aliases = node.get("aliases").cloned().unwrap_or(json!([]));
            let aliases_json = serde_json::to_string(&aliases).unwrap_or_else(|_| "[]".to_string());
            let aliases_text = aliases
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            let created_at = node
                .get("createdAt")
                .and_then(|v| v.as_str())
                .unwrap_or("2026-10-01T00:00:00Z");
            let provenance = node.get("provenance").cloned().unwrap_or(json!([]));
            let prov_json = serde_json::to_string(&provenance).unwrap_or_else(|_| "[]".to_string());

            tx.execute(
                r#"
                INSERT INTO graph_nodes (id, name, statement, aliases_json, created_at, provenance_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params![id, name, statement, aliases_json, created_at, prov_json],
            )
            .map_err(|e| format!("Failed to insert rewritten node: {e}"))?;

            tx.execute(
                "INSERT INTO nodes_fts (node_id, name, statement, aliases_text) VALUES (?1, ?2, ?3, ?4)",
                params![id, name, statement, aliases_text],
            )
            .map_err(|e| format!("Failed to insert rewritten nodes_fts: {e}"))?;
        }
        crate::storage::migrate::materialize_fsrs_cards(&tx)?;
    }

    if let Some(chains) = next.get("chains").and_then(|v| v.as_array()) {
        tx.execute("DELETE FROM graph_chains", [])
            .map_err(|e| format!("Failed to clear graph_chains: {e}"))?;
        for chain in chains {
            let id = chain.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let premises = chain.get("premises").cloned().unwrap_or(json!([]));
            let premises_json =
                serde_json::to_string(&premises).unwrap_or_else(|_| "[]".to_string());
            let conclusion = chain
                .get("conclusion")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let provenance = chain.get("provenance").cloned().unwrap_or(json!([]));
            let prov_json = serde_json::to_string(&provenance).unwrap_or_else(|_| "[]".to_string());
            let created_at = chain
                .get("createdAt")
                .and_then(|v| v.as_str())
                .unwrap_or("2026-10-01T00:00:00Z");

            tx.execute(
                r#"
                INSERT INTO graph_chains (id, premises_json, conclusion, provenance_json, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                "#,
                params![id, premises_json, conclusion, prov_json, created_at],
            )
            .map_err(|e| format!("Failed to insert rewritten chain: {e}"))?;
        }
    }

    let sessions_opt = next
        .get("checkpoints")
        .or_else(|| next.get("sessions"))
        .and_then(|v| v.as_array());
    if let Some(sessions) = sessions_opt {
        tx.execute("DELETE FROM graph_checkpoints", [])
            .map_err(|e| format!("Failed to clear checkpoints: {e}"))?;
        for s in sessions {
            let chat_id = s.get("chatId").and_then(|v| v.as_str()).unwrap_or("");
            let folded_at = s
                .get("foldedAt")
                .and_then(|v| v.as_str())
                .unwrap_or("2026-10-01T00:00:00Z");
            tx.execute(
                "INSERT INTO graph_checkpoints (chat_id, folded_at) VALUES (?1, ?2)",
                params![chat_id, folded_at],
            )
            .map_err(|e| format!("Failed to insert rewritten checkpoint: {e}"))?;
        }
    }

    if let Some(coverage) = next.get("coverage").and_then(|v| v.as_array()) {
        tx.execute("DELETE FROM graph_coverage", [])
            .map_err(|e| format!("Failed to clear coverage: {e}"))?;
        for c in coverage {
            let chat_id = c.get("chatId").and_then(|v| v.as_str()).unwrap_or("");
            let fp = c.get("fp").and_then(|v| v.as_str()).unwrap_or("");
            let tokens = c.get("tokens").and_then(|v| v.as_i64()).unwrap_or(0);
            let folded_at = c
                .get("foldedAt")
                .and_then(|v| v.as_str())
                .unwrap_or("2026-10-01T00:00:00Z");
            tx.execute(
                "INSERT INTO graph_coverage (chat_id, fp, tokens, folded_at) VALUES (?1, ?2, ?3, ?4)",
                params![chat_id, fp, tokens, folded_at],
            )
            .map_err(|e| format!("Failed to insert rewritten coverage: {e}"))?;
        }
    }

    if let Some(regroups) = next.get("regroups").and_then(|v| v.as_array()) {
        tx.execute("DELETE FROM graph_regroups", [])
            .map_err(|e| format!("Failed to clear regroups: {e}"))?;
        for r in regroups {
            let id = r.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let node_id = r.get("nodeId").and_then(|v| v.as_str()).unwrap_or("");
            let target_session_id = r
                .get("targetSessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let reason = r.get("reason").and_then(|v| v.as_str()).unwrap_or("");
            let regrouped_at = r
                .get("regroupedAt")
                .and_then(|v| v.as_str())
                .unwrap_or("2026-10-01T00:00:00Z");

            tx.execute(
                r#"
                INSERT INTO graph_regroups (id, node_id, target_session_id, reason, regrouped_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                "#,
                params![id, node_id, target_session_id, reason, regrouped_at],
            )
            .map_err(|e| format!("Failed to insert rewritten regroup: {e}"))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit rewrite_ledgers: {e}"))?;
    Ok(())
}

pub fn read_graph(conn: &Connection) -> Result<KnowledgeGraphSnapshot, String> {
    let nodes = read_nodes(conn)?;
    let chains = read_chains(conn)?;
    let sessions = read_checkpoints(conn)?;
    let coverage = read_coverage(conn)?;
    let regroups = read_regroups(conn)?;
    let sources = read_source_map(conn)?;
    let positions = read_positions(conn)?;

    Ok(KnowledgeGraphSnapshot {
        nodes,
        chains,
        sessions,
        coverage,
        regroups,
        sources,
        positions,
    })
}

pub fn save_graph(conn: &mut Connection, graph: &Value) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin tx: {e}"))?;

    if let Some(nodes) = graph.get("nodes").and_then(|v| v.as_array()) {
        tx.execute("DELETE FROM graph_nodes", [])
            .map_err(|e| format!("Failed to clear graph_nodes: {e}"))?;
        tx.execute("DELETE FROM nodes_fts", [])
            .map_err(|e| format!("Failed to clear nodes_fts: {e}"))?;

        for node in nodes {
            let id = node.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let statement = node.get("statement").and_then(|v| v.as_str()).unwrap_or("");
            let aliases = node.get("aliases").cloned().unwrap_or(json!([]));
            let aliases_json = serde_json::to_string(&aliases).unwrap_or_else(|_| "[]".to_string());
            let aliases_text = aliases
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            let created_at = node
                .get("createdAt")
                .and_then(|v| v.as_str())
                .unwrap_or("2026-10-01T00:00:00Z");
            let provenance = node.get("provenance").cloned().unwrap_or(json!([]));
            let prov_json = serde_json::to_string(&provenance).unwrap_or_else(|_| "[]".to_string());

            tx.execute(
                r#"
                INSERT INTO graph_nodes (id, name, statement, aliases_json, created_at, provenance_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params![id, name, statement, aliases_json, created_at, prov_json],
            )
            .map_err(|e| format!("Failed to insert node: {e}"))?;

            tx.execute(
                "INSERT INTO nodes_fts (node_id, name, statement, aliases_text) VALUES (?1, ?2, ?3, ?4)",
                params![id, name, statement, aliases_text],
            )
            .map_err(|e| format!("Failed to insert nodes_fts: {e}"))?;
        }
        crate::storage::migrate::materialize_fsrs_cards(&tx)?;
    }

    if let Some(chains) = graph.get("chains").and_then(|v| v.as_array()) {
        tx.execute("DELETE FROM graph_chains", [])
            .map_err(|e| format!("Failed to clear graph_chains: {e}"))?;
        for chain in chains {
            let id = chain.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let premises = chain.get("premises").cloned().unwrap_or(json!([]));
            let premises_json =
                serde_json::to_string(&premises).unwrap_or_else(|_| "[]".to_string());
            let conclusion = chain
                .get("conclusion")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let provenance = chain.get("provenance").cloned().unwrap_or(json!([]));
            let prov_json = serde_json::to_string(&provenance).unwrap_or_else(|_| "[]".to_string());
            let created_at = chain
                .get("createdAt")
                .and_then(|v| v.as_str())
                .unwrap_or("2026-10-01T00:00:00Z");

            tx.execute(
                r#"
                INSERT INTO graph_chains (id, premises_json, conclusion, provenance_json, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                "#,
                params![id, premises_json, conclusion, prov_json, created_at],
            )
            .map_err(|e| format!("Failed to insert chain: {e}"))?;
        }
    }

    let sessions_opt = graph
        .get("checkpoints")
        .or_else(|| graph.get("sessions"))
        .and_then(|v| v.as_array());
    if let Some(sessions) = sessions_opt {
        tx.execute("DELETE FROM graph_checkpoints", [])
            .map_err(|e| format!("Failed to clear checkpoints: {e}"))?;
        for s in sessions {
            let chat_id = s.get("chatId").and_then(|v| v.as_str()).unwrap_or("");
            let folded_at = s
                .get("foldedAt")
                .and_then(|v| v.as_str())
                .unwrap_or("2026-10-01T00:00:00Z");
            tx.execute(
                "INSERT INTO graph_checkpoints (chat_id, folded_at) VALUES (?1, ?2)",
                params![chat_id, folded_at],
            )
            .map_err(|e| format!("Failed to insert checkpoint: {e}"))?;
        }
    }

    if let Some(coverage) = graph.get("coverage").and_then(|v| v.as_array()) {
        tx.execute("DELETE FROM graph_coverage", [])
            .map_err(|e| format!("Failed to clear coverage: {e}"))?;
        for c in coverage {
            let chat_id = c.get("chatId").and_then(|v| v.as_str()).unwrap_or("");
            let fp = c.get("fp").and_then(|v| v.as_str()).unwrap_or("");
            let tokens = c.get("tokens").and_then(|v| v.as_i64()).unwrap_or(0);
            let folded_at = c
                .get("foldedAt")
                .and_then(|v| v.as_str())
                .unwrap_or("2026-10-01T00:00:00Z");
            tx.execute(
                "INSERT INTO graph_coverage (chat_id, fp, tokens, folded_at) VALUES (?1, ?2, ?3, ?4)",
                params![chat_id, fp, tokens, folded_at],
            )
            .map_err(|e| format!("Failed to insert coverage: {e}"))?;
        }
    }

    if let Some(regroups) = graph.get("regroups").and_then(|v| v.as_array()) {
        tx.execute("DELETE FROM graph_regroups", [])
            .map_err(|e| format!("Failed to clear regroups: {e}"))?;
        for r in regroups {
            let id = r.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let node_id = r.get("nodeId").and_then(|v| v.as_str()).unwrap_or("");
            let target_session_id = r
                .get("targetSessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let reason = r.get("reason").and_then(|v| v.as_str()).unwrap_or("");
            let regrouped_at = r
                .get("regroupedAt")
                .and_then(|v| v.as_str())
                .unwrap_or("2026-10-01T00:00:00Z");

            tx.execute(
                r#"
                INSERT INTO graph_regroups (id, node_id, target_session_id, reason, regrouped_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                "#,
                params![id, node_id, target_session_id, reason, regrouped_at],
            )
            .map_err(|e| format!("Failed to insert regroup: {e}"))?;
        }
    }

    if let Some(sources) = graph.get("sources") {
        tx.execute("DELETE FROM graph_sources", [])
            .map_err(|e| format!("Failed to clear sources: {e}"))?;
        let src_iter: Box<dyn Iterator<Item = &Value>> = if let Some(arr) = sources.as_array() {
            Box::new(arr.iter())
        } else if let Some(map) = sources.as_object() {
            Box::new(map.values())
        } else {
            Box::new(std::iter::empty())
        };

        for s in src_iter {
            let id = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let file_path = s.get("filePath").and_then(|v| v.as_str()).unwrap_or("");
            let imported_at = s
                .get("importedAt")
                .and_then(|v| v.as_str())
                .unwrap_or("2026-10-01T00:00:00Z");
            let extractions_json = s
                .get("extractions")
                .and_then(|e| serde_json::to_string(e).ok());

            tx.execute(
                r#"
                INSERT INTO graph_sources (id, file_path, imported_at, extractions_json)
                VALUES (?1, ?2, ?3, ?4)
                "#,
                params![id, file_path, imported_at, extractions_json],
            )
            .map_err(|e| format!("Failed to insert source: {e}"))?;
        }
    }

    if let Some(positions) = graph.get("positions").and_then(|v| v.as_object()) {
        tx.execute("DELETE FROM graph_positions", [])
            .map_err(|e| format!("Failed to clear positions: {e}"))?;
        for (node_id, pos) in positions {
            let x = pos.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let y = pos.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
            tx.execute(
                "INSERT INTO graph_positions (node_id, x, y) VALUES (?1, ?2, ?3)",
                params![node_id, x, y],
            )
            .map_err(|e| format!("Failed to insert position: {e}"))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit save_graph: {e}"))?;
    Ok(())
}

pub fn get_revision(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        r#"
        SELECT (
            (SELECT COALESCE(MAX(seq), 0) FROM graph_nodes) +
            (SELECT COALESCE(MAX(seq), 0) FROM graph_chains) +
            (SELECT COALESCE(MAX(seq), 0) FROM graph_checkpoints) +
            (SELECT COALESCE(MAX(seq), 0) FROM graph_coverage) +
            (SELECT COALESCE(MAX(seq), 0) FROM graph_regroups) +
            (SELECT COUNT(*) FROM graph_sources) +
            (SELECT COUNT(*) FROM graph_positions) +
            (SELECT COALESCE(MAX(seq), 0) FROM graph_events)
        ) AS rev
        "#,
        [],
        |r| r.get(0),
    )
    .map_err(|e| format!("Failed to query revision: {e}"))
}

pub fn search_nodes(
    conn: &Connection,
    query: &str,
    limit: Option<usize>,
) -> Result<Vec<NodeSearchHit>, String> {
    let clean = match crate::storage::sanitize_fts5_query(query) {
        Some(q) => q,
        None => return Ok(vec![]),
    };
    let lim = limit.unwrap_or(20) as i64;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT node_id, name, statement, snippet(nodes_fts, 2, '<b>', '</b>', '...', 16) AS snip
            FROM nodes_fts
            WHERE nodes_fts MATCH ?1
            ORDER BY rank
            LIMIT ?2
            "#,
        )
        .map_err(|e| format!("Failed to prepare search_nodes: {e}"))?;

    let rows = stmt
        .query_map(params![clean, lim], |row| {
            let node_id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let statement: String = row.get(2)?;
            let snippet: String = row.get(3)?;
            Ok(NodeSearchHit {
                node_id,
                name,
                statement,
                snippet,
            })
        })
        .map_err(|e| format!("Failed to execute search_nodes: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Error reading node search hit: {e}"))?);
    }
    Ok(out)
}

pub fn read_practice_history(conn: &Connection) -> Result<PracticeHistoryResult, String> {
    let records = crate::storage::chats::list_practice_records(conn, None)?;

    let mut stmt = conn
        .prepare("SELECT id, seed_rating FROM chats WHERE kind = 'teach'")
        .map_err(|e| format!("Failed to prepare teach chats query: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let rating: i64 = row.get(1)?;
            Ok((id, rating))
        })
        .map_err(|e| format!("Failed to query teach chats: {e}"))?;

    let mut teach_chat_ids = Vec::new();
    let mut teach_ratings = HashMap::new();
    for r in rows {
        let (id, rating) = r.map_err(|e| format!("Error reading teach chat row: {e}"))?;
        teach_chat_ids.push(id.clone());
        teach_ratings.insert(id, rating);
    }

    Ok(PracticeHistoryResult {
        records,
        teach_chat_ids,
        teach_ratings,
    })
}

pub fn read_fsrs_cards(
    conn: &Connection,
    due_before_ms: Option<f64>,
) -> Result<Vec<Value>, String> {
    let mut query = "SELECT node_id, stability, difficulty, last_review_ms, reviews, due_at_ms, lane, seed_rating, stage FROM fsrs_cards".to_string();
    if due_before_ms.is_some() {
        query.push_str(" WHERE due_at_ms <= ?1");
    }
    query.push_str(" ORDER BY due_at_ms ASC");

    let mut stmt = conn
        .prepare(&query)
        .map_err(|e| format!("Failed to prepare read_fsrs_cards: {e}"))?;

    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<Value> {
        let node_id: String = row.get(0)?;
        let stability: Option<f64> = row.get(1)?;
        let difficulty: Option<f64> = row.get(2)?;
        let last_review_ms: Option<i64> = row.get(3)?;
        let reviews: i64 = row.get(4)?;
        let due_at_ms: f64 = row.get(5)?;
        let lane: String = row.get(6)?;
        let seed_rating: i64 = row.get(7)?;
        let stage: String = row.get(8)?;

        Ok(json!({
            "nodeId": node_id,
            "stability": stability,
            "difficulty": difficulty,
            "lastReviewMs": last_review_ms,
            "reviews": reviews,
            "dueAtMs": due_at_ms,
            "lane": lane,
            "seedRating": seed_rating,
            "stage": stage
        }))
    };

    let mut out = Vec::new();
    if let Some(due) = due_before_ms {
        let rows = stmt
            .query_map(params![due], map_row)
            .map_err(|e| format!("Failed to query fsrs_cards: {e}"))?;
        for r in rows {
            out.push(r.map_err(|e| format!("Error reading fsrs_card: {e}"))?);
        }
    } else {
        let rows = stmt
            .query_map([], map_row)
            .map_err(|e| format!("Failed to query fsrs_cards: {e}"))?;
        for r in rows {
            out.push(r.map_err(|e| format!("Error reading fsrs_card: {e}"))?);
        }
    }

    Ok(out)
}

pub fn upsert_fsrs_cards(conn: &mut Connection, cards: &[Value]) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin tx: {e}"))?;

    for card in cards {
        let node_id = card
            .get("nodeId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing nodeId in fsrs card".to_string())?;
        let stability = card.get("stability").and_then(|v| v.as_f64());
        let difficulty = card.get("difficulty").and_then(|v| v.as_f64());
        let last_review_ms = card
            .get("lastReviewMs")
            .or_else(|| card.get("lastReview"))
            .and_then(|v| v.as_i64());
        let reviews = card.get("reviews").and_then(|v| v.as_i64()).unwrap_or(0);
        let due_at_ms = card
            .get("dueAtMs")
            .or_else(|| card.get("dueAt"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let lane = card
            .get("lane")
            .and_then(|v| v.as_str())
            .unwrap_or("review");
        let seed_rating = card.get("seedRating").and_then(|v| v.as_i64()).unwrap_or(3);
        let stage = card
            .get("stage")
            .and_then(|v| v.as_str())
            .unwrap_or("practiced");

        tx.execute(
            r#"
            INSERT INTO fsrs_cards (
                node_id, stability, difficulty, last_review_ms, reviews, due_at_ms, lane, seed_rating, stage
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(node_id) DO UPDATE SET
                stability = excluded.stability,
                difficulty = excluded.difficulty,
                last_review_ms = excluded.last_review_ms,
                reviews = excluded.reviews,
                due_at_ms = excluded.due_at_ms,
                lane = excluded.lane,
                seed_rating = excluded.seed_rating,
                stage = excluded.stage
            "#,
            params![
                node_id,
                stability,
                difficulty,
                last_review_ms,
                reviews,
                due_at_ms,
                lane,
                seed_rating,
                stage
            ],
        )
        .map_err(|e| format!("Failed to upsert fsrs card: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit fsrs_cards: {e}"))?;
    Ok(())
}

pub fn clear_all(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin tx: {e}"))?;

    tx.execute("DELETE FROM graph_nodes", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM nodes_fts", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM graph_chains", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM graph_checkpoints", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM graph_coverage", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM graph_regroups", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM graph_sources", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM graph_positions", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM graph_events", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM fsrs_cards", [])
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn append_events(conn: &Connection, events: &[Value]) -> Result<(), String> {
    for ev in events {
        let json_str = serde_json::to_string(ev).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO graph_events (event_json) VALUES (?1)",
            params![json_str],
        )
        .map_err(|e| format!("Failed to append event: {e}"))?;
    }
    Ok(())
}

pub fn read_events(conn: &Connection, since_seq: Option<i64>) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT seq, event_json FROM graph_events WHERE seq > ?1 ORDER BY seq ASC")
        .map_err(|e| format!("Failed to prepare read_events: {e}"))?;

    let min_seq = since_seq.unwrap_or(0);
    let rows = stmt
        .query_map(params![min_seq], |row| {
            let seq: i64 = row.get(0)?;
            let raw: String = row.get(1)?;
            let mut val: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
            if let Some(obj) = val.as_object_mut() {
                obj.insert("seq".to_string(), json!(seq));
            }
            Ok(val)
        })
        .map_err(|e| format!("Failed to query events: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Error reading event: {e}"))?);
    }
    Ok(out)
}

// ─── Tauri Command Handlers ──────────────────────────────────────────────────

#[tauri::command]
pub async fn lh_graph_append_node(state: State<'_, DbState>, node: Value) -> Result<(), String> {
    let mut conn = state.conn.lock().unwrap();
    append_node(&mut conn, &node)
}

#[tauri::command]
pub async fn lh_graph_read_nodes(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    read_nodes(&conn)
}

#[tauri::command]
pub async fn lh_graph_append_chain(
    state: State<'_, DbState>,
    assertion: Value,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    append_chain(&conn, &assertion)
}

#[tauri::command]
pub async fn lh_graph_read_chains(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    read_chains(&conn)
}

#[tauri::command]
pub async fn lh_graph_append_checkpoint(
    state: State<'_, DbState>,
    checkpoint: Value,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    append_checkpoint(&conn, &checkpoint)
}

#[tauri::command]
pub async fn lh_graph_read_checkpoints(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    read_checkpoints(&conn)
}

#[tauri::command]
pub async fn lh_graph_append_coverage(
    state: State<'_, DbState>,
    entry: Value,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    append_coverage(&conn, &entry)
}

#[tauri::command]
pub async fn lh_graph_read_coverage(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    read_coverage(&conn)
}

#[tauri::command]
pub async fn lh_graph_append_regroup(
    state: State<'_, DbState>,
    regroup: Value,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    append_regroup(&conn, &regroup)
}

#[tauri::command]
pub async fn lh_graph_read_regroups(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    read_regroups(&conn)
}

#[tauri::command]
pub async fn lh_graph_upsert_source(
    state: State<'_, DbState>,
    source: Value,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    upsert_source(&conn, &source)
}

#[tauri::command]
pub async fn lh_graph_save_source(state: State<'_, DbState>, source: Value) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    upsert_source(&conn, &source)
}

#[tauri::command]
pub async fn lh_graph_read_sources(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    read_sources(&conn)
}

#[tauri::command]
pub async fn lh_graph_delete_sources(
    state: State<'_, DbState>,
    ids: Vec<String>,
) -> Result<usize, String> {
    let conn = state.conn.lock().unwrap();
    delete_sources(&conn, &ids)
}

#[tauri::command]
pub async fn lh_graph_delete_source(
    state: State<'_, DbState>,
    id: String,
) -> Result<usize, String> {
    let conn = state.conn.lock().unwrap();
    delete_sources(&conn, &[id])
}

#[tauri::command]
pub async fn lh_graph_append_source_usage(
    state: State<'_, DbState>,
    id: String,
    entry: Value,
) -> Result<(), String> {
    let mut conn = state.conn.lock().unwrap();
    append_source_usage(&mut conn, &id, &entry)
}

#[tauri::command]
pub async fn lh_graph_read_positions(
    state: State<'_, DbState>,
) -> Result<HashMap<String, Value>, String> {
    let conn = state.conn.lock().unwrap();
    read_positions(&conn)
}

#[tauri::command]
pub async fn lh_graph_write_positions(
    state: State<'_, DbState>,
    positions: HashMap<String, Value>,
) -> Result<(), String> {
    let mut conn = state.conn.lock().unwrap();
    write_positions(&mut conn, &positions)
}

#[tauri::command]
pub async fn lh_graph_save_positions(
    state: State<'_, DbState>,
    positions: HashMap<String, Value>,
) -> Result<(), String> {
    let mut conn = state.conn.lock().unwrap();
    write_positions(&mut conn, &positions)
}

#[tauri::command]
pub async fn lh_graph_rewrite_ledgers(
    state: State<'_, DbState>,
    next: Value,
) -> Result<(), String> {
    let mut conn = state.conn.lock().unwrap();
    rewrite_ledgers(&mut conn, &next)
}

#[tauri::command]
pub async fn lh_read_graph(state: State<'_, DbState>) -> Result<KnowledgeGraphSnapshot, String> {
    let conn = state.conn.lock().unwrap();
    read_graph(&conn)
}

#[tauri::command]
pub async fn lh_graph_load_snapshot(
    state: State<'_, DbState>,
) -> Result<KnowledgeGraphSnapshot, String> {
    let conn = state.conn.lock().unwrap();
    read_graph(&conn)
}

#[tauri::command]
pub async fn lh_save_graph(state: State<'_, DbState>, graph: Value) -> Result<(), String> {
    let mut conn = state.conn.lock().unwrap();
    save_graph(&mut conn, &graph)
}

#[tauri::command]
pub async fn lh_graph_revision(state: State<'_, DbState>) -> Result<i64, String> {
    let conn = state.conn.lock().unwrap();
    get_revision(&conn)
}

#[tauri::command]
pub async fn lh_get_graph_revision(state: State<'_, DbState>) -> Result<i64, String> {
    let conn = state.conn.lock().unwrap();
    get_revision(&conn)
}

#[tauri::command]
pub async fn lh_search_nodes(
    state: State<'_, DbState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<NodeSearchHit>, String> {
    let conn = state.conn.lock().unwrap();
    search_nodes(&conn, &query, limit)
}

#[tauri::command]
pub async fn lh_read_practice_history(
    state: State<'_, DbState>,
) -> Result<PracticeHistoryResult, String> {
    let conn = state.conn.lock().unwrap();
    read_practice_history(&conn)
}

#[tauri::command]
pub async fn lh_read_fsrs_cards(
    state: State<'_, DbState>,
    due_before_ms: Option<f64>,
) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    read_fsrs_cards(&conn, due_before_ms)
}

#[tauri::command]
pub async fn lh_list_fsrs_cards(
    state: State<'_, DbState>,
    due_before_ms: Option<f64>,
) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    read_fsrs_cards(&conn, due_before_ms)
}

#[tauri::command]
pub async fn lh_upsert_fsrs_cards(
    state: State<'_, DbState>,
    cards: Vec<Value>,
) -> Result<(), String> {
    let mut conn = state.conn.lock().unwrap();
    upsert_fsrs_cards(&mut conn, &cards)
}

#[tauri::command]
pub async fn lh_save_fsrs_cards(
    state: State<'_, DbState>,
    cards: Vec<Value>,
) -> Result<(), String> {
    let mut conn = state.conn.lock().unwrap();
    upsert_fsrs_cards(&mut conn, &cards)
}

#[tauri::command]
pub async fn lh_recompute_fsrs_cards(state: State<'_, DbState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    crate::storage::migrate::materialize_fsrs_cards(&conn)
}

#[tauri::command]
pub async fn lh_graph_clear_all(state: State<'_, DbState>) -> Result<(), String> {
    let mut conn = state.conn.lock().unwrap();
    clear_all(&mut conn)
}

#[tauri::command]
pub async fn lh_append_graph_events(
    state: State<'_, DbState>,
    events: Vec<Value>,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    append_events(&conn, &events)
}

#[tauri::command]
pub async fn lh_read_graph_events(
    state: State<'_, DbState>,
    since_seq: Option<i64>,
) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().unwrap();
    read_events(&conn, since_seq)
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
    fn ledgers_fts_and_fsrs_cards() {
        let mut conn = test_db();

        // 1. Append nodes and verify seq ASC order
        let n1 = json!({
            "id": "node_1",
            "name": "Superposition",
            "statement": "Quantum states exist in linear combinations.",
            "aliases": ["linear combination"],
            "createdAt": "2026-10-01T00:00:00Z",
            "provenance": [{"chatId": "c1", "messageId": "m1"}]
        });
        let n2 = json!({
            "id": "node_2",
            "name": "Measurement Collapse",
            "statement": "Measurement projects state into eigenstate.",
            "aliases": ["wavefunction collapse"],
            "createdAt": "2026-10-01T00:01:00Z",
            "provenance": [{"chatId": "c1", "messageId": "m2"}]
        });
        append_node(&mut conn, &n1).unwrap();
        append_node(&mut conn, &n2).unwrap();

        let nodes = read_nodes(&conn).unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0]["id"], "node_1");
        assert_eq!(nodes[1]["id"], "node_2");

        // 2. Search nodes FTS5
        let hits = search_nodes(&conn, "eigenstate", None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].node_id, "node_2");
        assert!(hits[0].snippet.contains("eigenstate"));

        // 3. Chains, checkpoints, coverage, regroups
        let chain1 = json!({
            "id": "chain_1",
            "premises": ["node_1"],
            "conclusion": "node_2",
            "provenance": [{"chatId": "c1", "messageId": "m3"}],
            "createdAt": "2026-10-01T00:02:00Z"
        });
        append_chain(&conn, &chain1).unwrap();
        let chains = read_chains(&conn).unwrap();
        assert_eq!(chains.len(), 1);
        assert_eq!(chains[0]["conclusion"], "node_2");

        let cp = json!({"chatId": "c1", "foldedAt": "2026-10-01T00:03:00Z"});
        append_checkpoint(&conn, &cp).unwrap();
        assert_eq!(read_checkpoints(&conn).unwrap().len(), 1);

        let cov = json!({"chatId": "c1", "fp": "fp_x", "tokens": 120, "foldedAt": "2026-10-01T00:04:00Z"});
        append_coverage(&conn, &cov).unwrap();
        assert_eq!(read_coverage(&conn).unwrap().len(), 1);

        let reg = json!({
            "id": "reg_1",
            "nodeId": "node_1",
            "targetSessionId": "c2",
            "reason": "grouped",
            "regroupedAt": "2026-10-01T00:05:00Z"
        });
        append_regroup(&conn, &reg).unwrap();
        assert_eq!(read_regroups(&conn).unwrap().len(), 1);

        // 4. Sources, source usage, positions
        let src = json!({
            "id": "src_1",
            "filePath": "/tmp/notes.md",
            "importedAt": "2026-10-01T00:00:00Z"
        });
        upsert_source(&conn, &src).unwrap();
        assert_eq!(read_sources(&conn).unwrap().len(), 1);

        let usage = json!({
            "startedAt": "2026-10-01T00:06:00Z",
            "model": "claude-3-5-sonnet",
            "inputTokens": 100,
            "outputTokens": 50
        });
        append_source_usage(&mut conn, "src_1", &usage).unwrap();
        // verify idempotent
        append_source_usage(&mut conn, "src_1", &usage).unwrap();
        let sources_after = read_sources(&conn).unwrap();
        let ext = sources_after[0]["extractions"].as_array().unwrap();
        assert_eq!(ext.len(), 1);

        let mut positions = HashMap::new();
        positions.insert("node_1".to_string(), json!({"x": 10.0, "y": 20.0}));
        write_positions(&mut conn, &positions).unwrap();
        let read_pos = read_positions(&conn).unwrap();
        assert_eq!(read_pos["node_1"]["x"], 10.0);

        // 5. Revision
        let rev = get_revision(&conn).unwrap();
        assert!(rev > 0);

        // 6. rewrite_ledgers atomic replacement
        let replacement = json!({
            "nodes": [n2],
            "chains": []
        });
        rewrite_ledgers(&mut conn, &replacement).unwrap();
        let nodes_rewritten = read_nodes(&conn).unwrap();
        assert_eq!(nodes_rewritten.len(), 1);
        assert_eq!(nodes_rewritten[0]["id"], "node_2");
        assert_eq!(read_chains(&conn).unwrap().len(), 0);
        // Untouched tables remained intact
        assert_eq!(read_checkpoints(&conn).unwrap().len(), 1);

        // 7. FSRS cards upsert and read ordered by due_at_ms ASC
        let card1 = json!({
            "nodeId": "node_1",
            "stability": 2.5,
            "difficulty": 5.0,
            "lastReviewMs": 1700000000000i64,
            "reviews": 1,
            "dueAtMs": 1700200000000f64,
            "lane": "review",
            "seedRating": 3,
            "stage": "practiced"
        });
        let card2 = json!({
            "nodeId": "node_2",
            "stability": 1.0,
            "difficulty": 6.0,
            "lastReviewMs": 1700000000000i64,
            "reviews": 1,
            "dueAtMs": 1700100000000f64,
            "lane": "review",
            "seedRating": 3,
            "stage": "practiced"
        });
        upsert_fsrs_cards(&mut conn, &[card1, card2]).unwrap();
        let read_cards = read_fsrs_cards(&conn, None).unwrap();
        assert_eq!(read_cards.len(), 2);
        // dueAtMs: 1700100000000 must come first
        assert_eq!(read_cards[0]["nodeId"], "node_2");
        assert_eq!(read_cards[1]["nodeId"], "node_1");
    }
}
