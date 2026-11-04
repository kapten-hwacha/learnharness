#![cfg(not(target_os = "ios"))]

use serde::{Deserialize, Serialize};
use std::process::Stdio;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
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
