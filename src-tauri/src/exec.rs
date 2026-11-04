#![cfg(not(target_os = "ios"))]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

static DAEMON_REGISTRY: OnceLock<Mutex<HashMap<u32, Child>>> = OnceLock::new();

fn get_daemon_registry() -> &'static Mutex<HashMap<u32, Child>> {
    DAEMON_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn lh_spawn_daemon(cmd: String, args: Vec<String>) -> Result<u32, String> {
    let mut command = Command::new(cmd);
    command.args(args);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let child = command.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();

    let registry = get_daemon_registry();
    let mut map = registry.lock().map_err(|e| e.to_string())?;
    map.insert(pid, child);

    Ok(pid)
}

#[tauri::command]
pub async fn lh_kill_process(pid: u32) -> Result<(), String> {
    let registry = get_daemon_registry();
    let mut map = registry.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = map.remove(&pid) {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
pub async fn lh_exec_command(
    cmd: String,
    args: Vec<String>,
    env: Option<Vec<(String, String)>>,
    timeout_ms: Option<u64>,
) -> Result<ExecResult, String> {
    let mut command = tokio::process::Command::new(cmd);
    command.args(args);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    if let Some(env_vars) = env {
        for (k, v) in env_vars {
            command.env(k, v);
        }
    }

    let timeout_duration = std::time::Duration::from_millis(timeout_ms.unwrap_or(30_000));
    let child = command.spawn().map_err(|e| e.to_string())?;

    match tokio::time::timeout(timeout_duration, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(ExecResult {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        }),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("Command execution timed out".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn daemon_spawn_and_kill() {
        let pid = lh_spawn_daemon("sleep".to_string(), vec!["10".to_string()])
            .await
            .expect("spawn daemon succeeds");
        assert!(pid > 0);

        let kill_res = lh_kill_process(pid).await;
        assert!(kill_res.is_ok(), "kill process succeeds");
    }
}
