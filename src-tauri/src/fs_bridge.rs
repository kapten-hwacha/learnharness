use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDirs {
    pub data_dir: String,
    pub user_data_dir: String,
    pub home_dir: String,
    pub root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatResult {
    pub exists: bool,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryResult {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub size: u64,
}

pub fn resolve_app_dirs(app: &tauri::AppHandle) -> (PathBuf, PathBuf, PathBuf) {
    use tauri::Manager;
    let mut user_data_dir = if let Ok(path) = std::env::var("LH_USER_DATA_DIR") {
        PathBuf::from(path)
    } else {
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("LearnHarness"))
    };

    if cfg!(debug_assertions) || std::env::var("LH_DEV").is_ok() {
        let parent = user_data_dir.parent().unwrap_or(Path::new("."));
        let name = user_data_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("LearnHarness");
        if !name.ends_with("-dev") {
            user_data_dir = parent.join(format!("{name}-dev"));
        }
    }

    let data_dir = if let Ok(env_data) = std::env::var("LH_DATA_DIR") {
        PathBuf::from(env_data)
    } else {
        user_data_dir.join("data")
    };

    let auth_file = if let Ok(env_auth) = std::env::var("LH_AUTH_FILE") {
        PathBuf::from(env_auth)
    } else {
        user_data_dir.join("auth.json")
    };

    let _ = std::fs::create_dir_all(&user_data_dir);
    let _ = std::fs::create_dir_all(&data_dir);

    (data_dir, auth_file, user_data_dir)
}

pub fn dirs_home() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
}

pub fn to_posix(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub const SENSITIVE_HOME_PATHS: &[&str] = &[
    ".claude",
    ".codex",
    ".cursor",
    ".gemini",
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".config/gcloud",
    ".kube",
    ".docker",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    ".config/gh",
    ".config/hub",
    ".config/glab-cli",
    ".config/op",
    ".config/stripe",
    ".config/vercel",
    ".config/supabase",
    ".config/firebase",
    ".config/heroku",
    ".pgpass",
    ".my.cnf",
    ".zsh_history",
    ".bash_history",
    ".python_history",
    ".node_repl_history",
    "Library/Keychains",
    "Library/Cookies",
    "Library/Safari",
    "Library/Messages",
    "Library/Mail",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/BraveSoftware",
    "Library/Application Support/Microsoft Edge",
    "Library/Application Support/Firefox",
    ".mozilla",
    ".config/google-chrome",
    ".config/chromium",
    ".config/BraveSoftware",
    ".config/microsoft-edge",
    "AppData/Local/Google/Chrome",
    "AppData/Local/BraveSoftware",
    "AppData/Local/Microsoft/Edge",
    "AppData/Roaming/Mozilla",
];

fn is_env_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".env" || lower.starts_with(".env.")
}

fn is_credential_or_temp_file(file_path: &Path, auth_file: &Path, canonical_auth: &Path) -> bool {
    if file_path == auth_file || file_path == canonical_auth {
        return true;
    }

    let auth_parent = auth_file.parent();
    let canonical_auth_parent = canonical_auth.parent();

    let parent_matches = file_path
        .parent()
        .is_some_and(|p| auth_parent == Some(p) || canonical_auth_parent == Some(p));

    if parent_matches {
        if let Some(file_name) = file_path.file_name().and_then(|n| n.to_str()) {
            let lower = file_name.to_ascii_lowercase();
            if lower == "auth.json"
                || lower == "chatgpt-credentials.json"
                || lower == "github-copilot-credentials.json"
                || lower == "xai-credentials.json"
            {
                return true;
            }
            if lower.contains(".tmp")
                && (lower.contains("auth.json")
                    || lower.contains("-credentials.json")
                    || lower.starts_with(".auth")
                    || lower.starts_with("auth")
                    || lower.ends_with(".tmp"))
            {
                return true;
            }
        }
    }

    false
}

fn is_sensitive_home_subpath(path: &Path, home: &Path) -> bool {
    let p_posix = to_posix(path).to_ascii_lowercase();
    let h_posix = to_posix(home).to_ascii_lowercase();
    let h_trimmed = h_posix.trim_end_matches('/');

    let rel = if p_posix == h_trimmed {
        ""
    } else if p_posix.starts_with(&(h_trimmed.to_string() + "/")) {
        &p_posix[h_trimmed.len() + 1..]
    } else {
        return false;
    };

    if rel.is_empty() {
        return false;
    }

    for &sens in SENSITIVE_HOME_PATHS {
        let s_lower = sens.to_ascii_lowercase();
        if rel == s_lower || rel.starts_with(&(s_lower.clone() + "/")) {
            return true;
        }
    }

    false
}

fn load_settings(data_dir: &Path) -> Option<serde_json::Value> {
    let settings_file = data_dir.join("settings.json");
    if settings_file.exists() {
        if let Ok(content) = fs::read_to_string(&settings_file) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                return Some(v);
            }
        }
    }

    let mut dirs_to_check = vec![data_dir.to_path_buf()];
    if let Some(parent) = data_dir.parent() {
        dirs_to_check.push(parent.to_path_buf());
        dirs_to_check.push(parent.join("user_data"));
    }

    for dir in dirs_to_check {
        let db_path = dir.join("learnharness.db");
        if db_path.exists() {
            if let Ok(conn) = rusqlite::Connection::open_with_flags(
                &db_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            ) {
                if let Ok(val_str) = conn.query_row::<String, _, _>(
                    "SELECT value_json FROM kv_documents WHERE key = 'settings'",
                    [],
                    |r| r.get(0),
                ) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&val_str) {
                        return Some(v);
                    }
                }
            }
        }
    }
    None
}

fn validate_external_path(
    raw: &str,
    data_dir: &Path,
    auth_file: &Path,
    home_dir: Option<&Path>,
    require_dir: bool,
) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.contains('\0') {
        return Err("Invalid path".to_string());
    }

    let raw_path = Path::new(raw);
    if !raw_path.is_absolute() {
        return Err(format!("Path must be absolute: {raw}"));
    }

    let canonical = fs::canonicalize(raw).map_err(|e| format!("Failed to resolve {raw}: {e}"))?;

    if require_dir {
        if !canonical.is_dir() {
            return Err(format!("Path is not a directory: {raw}"));
        }
    } else if !canonical.is_file() {
        return Err(format!("Path is not a file: {raw}"));
    }

    if let Some(name) = raw_path.file_name().and_then(|n| n.to_str()) {
        if is_env_file_name(name) {
            return Err("Access denied: protected location".to_string());
        }
    }
    if let Some(name) = canonical.file_name().and_then(|n| n.to_str()) {
        if is_env_file_name(name) {
            return Err("Access denied: protected location".to_string());
        }
    }

    let canonical_auth = fs::canonicalize(auth_file).unwrap_or_else(|_| auth_file.to_path_buf());
    if is_credential_or_temp_file(raw_path, auth_file, &canonical_auth)
        || is_credential_or_temp_file(&canonical, auth_file, &canonical_auth)
    {
        return Err("Access denied: protected location".to_string());
    }

    if let Some(home) = home_dir {
        let canonical_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
        if is_sensitive_home_subpath(raw_path, home)
            || is_sensitive_home_subpath(raw_path, &canonical_home)
            || is_sensitive_home_subpath(&canonical, &canonical_home)
            || is_sensitive_home_subpath(&canonical, home)
        {
            return Err("Access denied: protected location".to_string());
        }
    }

    if let Some(val) = load_settings(data_dir) {
        let is_restricted = val
            .get("agent")
            .and_then(|a| a.get("restrictFileAccess"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            || val
                .get("agent")
                .and_then(|a| a.get("fileAccess"))
                .and_then(|f| f.get("restricted"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

        if is_restricted {
            let folders_val = val
                .get("agent")
                .and_then(|a| a.get("allowedFolders"))
                .or_else(|| {
                    val.get("agent")
                        .and_then(|a| a.get("fileAccess"))
                        .and_then(|f| f.get("folders"))
                });

            let allowed_folders = folders_val
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let mut is_inside_allowed = false;
            for folder_val in allowed_folders {
                if let Some(folder_str) = folder_val.as_str() {
                    let folder_path = if folder_str == "~" {
                        home_dir.map(|h| h.to_path_buf())
                    } else if folder_str.starts_with("~/") || folder_str.starts_with("~\\") {
                        home_dir.map(|h| h.join(&folder_str[2..]))
                    } else {
                        Some(PathBuf::from(folder_str))
                    };

                    if let Some(fp) = folder_path {
                        if let Ok(canon_folder) = fs::canonicalize(&fp) {
                            let mut folder_is_sensitive = false;
                            if let Some(home) = home_dir {
                                let canonical_home =
                                    fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
                                if is_sensitive_home_subpath(&canon_folder, home)
                                    || is_sensitive_home_subpath(&canon_folder, &canonical_home)
                                    || is_sensitive_home_subpath(&fp, home)
                                    || is_sensitive_home_subpath(&fp, &canonical_home)
                                {
                                    folder_is_sensitive = true;
                                }
                            }
                            if is_credential_or_temp_file(&canon_folder, auth_file, &canonical_auth)
                                || is_credential_or_temp_file(&fp, auth_file, &canonical_auth)
                            {
                                folder_is_sensitive = true;
                            }

                            if !folder_is_sensitive && canonical.starts_with(&canon_folder) {
                                is_inside_allowed = true;
                                break;
                            }
                        }
                    }
                }
            }

            if !is_inside_allowed {
                return Err("Access denied: outside allowed folders".into());
            }
        }
    }

    Ok(canonical)
}

pub fn validate_external_read_path(
    raw: &str,
    data_dir: &Path,
    auth_file: &Path,
    home_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    validate_external_path(raw, data_dir, auth_file, home_dir, false)
}

pub fn validate_external_dir_path(
    raw: &str,
    data_dir: &Path,
    auth_file: &Path,
    home_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    validate_external_path(raw, data_dir, auth_file, home_dir, true)
}

pub fn walk_external(
    root_dir: &Path,
    data_dir: &Path,
    auth_file: &Path,
    home_dir: Option<&Path>,
    max_entries: Option<usize>,
) -> Result<Vec<String>, String> {
    let canon_root =
        validate_external_dir_path(&root_dir.to_string_lossy(), data_dir, auth_file, home_dir)?;

    let max_files = max_entries.unwrap_or(5000);
    let mut results = Vec::new();
    let mut queue = vec![canon_root];

    while let Some(curr_dir) = queue.pop() {
        let entries = match fs::read_dir(&curr_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.starts_with('.')
                || file_name == "node_modules"
                || is_env_file_name(&file_name)
            {
                continue;
            }

            let path = entry.path();
            if let Some(home) = home_dir {
                if is_sensitive_home_subpath(&path, home) {
                    continue;
                }
            }

            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
            if is_dir {
                queue.push(path);
            } else {
                results.push(to_posix(&path));
                if results.len() >= max_files {
                    return Ok(results);
                }
            }
        }
    }

    Ok(results)
}

// ─── Tauri Command Handlers ──────────────────────────────────────────────────

#[tauri::command]
pub async fn lh_get_host_dirs(app: tauri::AppHandle) -> Result<HostDirs, String> {
    use tauri::Manager;
    let (data_dir, _, user_data_dir) = resolve_app_dirs(&app);
    let home_dir = dirs_home()
        .map(|p| to_posix(&p))
        .unwrap_or_else(|| "/home".to_string());
    let root = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .to_string_lossy()
        .to_string();

    Ok(HostDirs {
        data_dir: to_posix(&data_dir),
        user_data_dir: to_posix(&user_data_dir),
        home_dir,
        root,
    })
}

#[tauri::command]
pub async fn lh_fs_read_external(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    let (data_dir, auth_file, _) = resolve_app_dirs(&app);
    let home = dirs_home();
    let safe_path = validate_external_read_path(&path, &data_dir, &auth_file, home.as_deref())?;
    fs::read(&safe_path).map_err(|e| format!("Failed to read {path}: {e}"))
}

#[tauri::command]
pub async fn lh_fs_stat_external(
    app: tauri::AppHandle,
    path: String,
) -> Result<StatResult, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(StatResult {
            exists: false,
            is_file: false,
            is_dir: false,
            size: 0,
            mtime_ms: 0,
        });
    }

    let (data_dir, auth_file, _) = resolve_app_dirs(&app);
    let home = dirs_home();
    let is_dir = p.is_dir();
    let safe_path = validate_external_path(&path, &data_dir, &auth_file, home.as_deref(), is_dir)?;

    let meta = fs::metadata(&safe_path).map_err(|e| e.to_string())?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Ok(StatResult {
        exists: true,
        is_file: meta.is_file(),
        is_dir: meta.is_dir(),
        size: meta.len(),
        mtime_ms,
    })
}

#[tauri::command]
pub async fn lh_fs_list_external_dir(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<DirEntryResult>, String> {
    let (data_dir, auth_file, _) = resolve_app_dirs(&app);
    let home = dirs_home();
    let safe_dir = validate_external_dir_path(&path, &data_dir, &auth_file, home.as_deref())?;

    let entries = fs::read_dir(&safe_dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_env_file_name(&name) {
            continue;
        }

        let p = entry.path();
        if let Some(h) = home.as_deref() {
            if is_sensitive_home_subpath(&p, h) {
                continue;
            }
        }

        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let is_file = meta.as_ref().map(|m| m.is_file()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);

        out.push(DirEntryResult {
            name,
            path: to_posix(&p),
            is_dir,
            is_file,
            size,
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn lh_fs_walk_external(
    app: tauri::AppHandle,
    root_dir: String,
    max_entries: Option<usize>,
) -> Result<Vec<String>, String> {
    let (data_dir, auth_file, _) = resolve_app_dirs(&app);
    let home = dirs_home();
    walk_external(
        Path::new(&root_dir),
        &data_dir,
        &auth_file,
        home.as_deref(),
        max_entries,
    )
}

#[tauri::command]
pub async fn lh_quaderno_write_pdf(
    app: tauri::AppHandle,
    filename: String,
    data_base64: String,
) -> Result<String, String> {
    let p = Path::new(&filename);
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid filename".to_string())?;

    if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err(format!("Invalid filename: {filename}"));
    }

    let (data_dir, _, _) = resolve_app_dirs(&app);
    let quaderno_dir = data_dir.join("quaderno");
    fs::create_dir_all(&quaderno_dir)
        .map_err(|e| format!("Failed to create quaderno directory: {e}"))?;

    let target = quaderno_dir.join(name);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("Base64 decode failed: {e}"))?;

    fs::write(&target, &bytes).map_err(|e| format!("Failed to write pdf file: {e}"))?;

    Ok(to_posix(&target))
}

#[tauri::command]
pub async fn lh_quaderno_list_pdfs(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let (data_dir, _, _) = resolve_app_dirs(&app);
    let quaderno_dir = data_dir.join("quaderno");
    if !quaderno_dir.exists() {
        return Ok(vec![]);
    }

    let entries = fs::read_dir(&quaderno_dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file() {
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.ends_with(".pdf") {
                    out.push(name.to_string());
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
pub async fn lh_debug_write(
    app: tauri::AppHandle,
    rel_path: String,
    line: String,
    append: Option<bool>,
) -> Result<(), String> {
    let p = Path::new(&rel_path);
    for comp in p.components() {
        if matches!(
            comp,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        ) {
            return Err(format!("Invalid rel_path traversal: {rel_path}"));
        }
    }

    let (_, _, user_data_dir) = resolve_app_dirs(&app);
    let debug_dir = user_data_dir.join("debug");
    let target = debug_dir.join(p);

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create debug dir: {e}"))?;
    }

    let formatted_line = if line.ends_with('\n') {
        line
    } else {
        format!("{line}\n")
    };

    if append.unwrap_or(true) {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&target)
            .map_err(|e| format!("Failed to open debug file: {e}"))?;
        file.write_all(formatted_line.as_bytes())
            .map_err(|e| format!("Failed to write to debug file: {e}"))?;
    } else {
        fs::write(&target, formatted_line)
            .map_err(|e| format!("Failed to write debug file: {e}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

    fn setup_dirs() -> (tempfile_or_path::TempDirs, PathBuf, PathBuf, PathBuf) {
        let id = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "lh_test_{}_{}_{}",
            std::process::id(),
            id,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let data_dir = base.join("LearnHarness");
        let user_data_dir = base.join("user_data");
        let auth_file = user_data_dir.join("auth.json");
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(&user_data_dir).unwrap();
        (
            tempfile_or_path::TempDirs(base),
            data_dir,
            auth_file,
            user_data_dir,
        )
    }

    mod tempfile_or_path {
        use std::path::PathBuf;
        pub struct TempDirs(pub PathBuf);
        impl Drop for TempDirs {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn validate_rejects_ssh_and_env() {
        let (_guard, data_dir, auth_file, user_data_dir) = setup_dirs();
        let home = user_data_dir.join("fake_home");
        let ssh_dir = home.join(".ssh");
        fs::create_dir_all(&ssh_dir).unwrap();
        let id_rsa = ssh_dir.join("id_rsa");
        fs::write(&id_rsa, "private key").unwrap();

        let res = validate_external_read_path(
            id_rsa.to_str().unwrap(),
            &data_dir,
            &auth_file,
            Some(&home),
        );
        assert!(res.is_err());
        assert!(res
            .unwrap_err()
            .contains("Access denied: protected location"));

        let env_file = home.join(".env");
        fs::write(&env_file, "SECRET=1").unwrap();
        let res_env = validate_external_read_path(
            env_file.to_str().unwrap(),
            &data_dir,
            &auth_file,
            Some(&home),
        );
        assert!(res_env.is_err());
        assert!(res_env
            .unwrap_err()
            .contains("Access denied: protected location"));

        let env_local = home.join(".env.local");
        fs::write(&env_local, "SECRET=2").unwrap();
        let res_local = validate_external_read_path(
            env_local.to_str().unwrap(),
            &data_dir,
            &auth_file,
            Some(&home),
        );
        assert!(res_local.is_err());
        assert!(res_local
            .unwrap_err()
            .contains("Access denied: protected location"));
    }

    #[test]
    fn validate_rejects_auth_and_sibling_credentials() {
        let (_guard, data_dir, auth_file, user_data_dir) = setup_dirs();
        fs::write(&auth_file, "{}").unwrap();
        let res_auth =
            validate_external_read_path(auth_file.to_str().unwrap(), &data_dir, &auth_file, None);
        assert!(res_auth.is_err());
        assert!(res_auth
            .unwrap_err()
            .contains("Access denied: protected location"));

        let chatgpt = user_data_dir.join("chatgpt-credentials.json");
        fs::write(&chatgpt, "{}").unwrap();
        let res_chatgpt =
            validate_external_read_path(chatgpt.to_str().unwrap(), &data_dir, &auth_file, None);
        assert!(res_chatgpt.is_err());
        assert!(res_chatgpt
            .unwrap_err()
            .contains("Access denied: protected location"));

        let temp_cred = user_data_dir.join("auth.json.tmp-1234");
        fs::write(&temp_cred, "{}").unwrap();
        let res_temp =
            validate_external_read_path(temp_cred.to_str().unwrap(), &data_dir, &auth_file, None);
        assert!(res_temp.is_err());
        assert!(res_temp
            .unwrap_err()
            .contains("Access denied: protected location"));
    }

    #[test]
    fn validate_rejects_symlink_escaping_into_ssh() {
        let (_guard, data_dir, auth_file, user_data_dir) = setup_dirs();
        let home = user_data_dir.join("fake_home");
        let ssh_dir = home.join(".ssh");
        fs::create_dir_all(&ssh_dir).unwrap();
        let id_rsa = ssh_dir.join("id_rsa");
        fs::write(&id_rsa, "private key").unwrap();

        let docs_dir = home.join("documents");
        fs::create_dir_all(&docs_dir).unwrap();
        let symlink_file = docs_dir.join("my_key.txt");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&id_rsa, &symlink_file).unwrap();
            let res = validate_external_read_path(
                symlink_file.to_str().unwrap(),
                &data_dir,
                &auth_file,
                Some(&home),
            );
            assert!(res.is_err());
            assert!(res
                .unwrap_err()
                .contains("Access denied: protected location"));
        }
    }

    #[test]
    fn validate_enforces_restricted_file_access_in_settings() {
        let (_guard, data_dir, auth_file, user_data_dir) = setup_dirs();
        let home = user_data_dir.join("fake_home");
        let allowed = home.join("allowed_dir");
        let forbidden = home.join("forbidden_dir");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&forbidden).unwrap();

        let allowed_file = allowed.join("file.txt");
        let forbidden_file = forbidden.join("file.txt");
        fs::write(&allowed_file, "hello").unwrap();
        fs::write(&forbidden_file, "secret").unwrap();

        let settings = serde_json::json!({
            "agent": {
                "restrictFileAccess": true,
                "allowedFolders": [allowed.to_str().unwrap()]
            }
        });
        fs::write(data_dir.join("settings.json"), settings.to_string()).unwrap();

        let res_forbidden = validate_external_read_path(
            forbidden_file.to_str().unwrap(),
            &data_dir,
            &auth_file,
            Some(&home),
        );
        assert!(res_forbidden.is_err());
        assert_eq!(
            res_forbidden.unwrap_err(),
            "Access denied: outside allowed folders"
        );

        let res_allowed = validate_external_read_path(
            allowed_file.to_str().unwrap(),
            &data_dir,
            &auth_file,
            Some(&home),
        );
        assert!(res_allowed.is_ok());
        assert_eq!(
            res_allowed.unwrap(),
            fs::canonicalize(&allowed_file).unwrap()
        );
    }

    #[test]
    fn external_walk_and_db_settings_policy() {
        let (_guard, data_dir, auth_file, user_data_dir) = setup_dirs();
        let home = user_data_dir.join("fake_home");
        let allowed = home.join("allowed_workspace");
        let forbidden = home.join("forbidden_folder");
        let ssh_dir = home.join(".ssh");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&forbidden).unwrap();
        fs::create_dir_all(&ssh_dir).unwrap();

        let allowed_doc = allowed.join("notes.txt");
        let forbidden_doc = forbidden.join("notes.txt");
        let env_file = allowed.join(".env");
        let node_modules = allowed.join("node_modules/pkg");
        let nested_file = node_modules.join("index.js");
        let sub_doc = allowed.join("sub/chapter.md");
        fs::create_dir_all(allowed.join("sub")).unwrap();
        fs::create_dir_all(&node_modules).unwrap();

        fs::write(&allowed_doc, "allowed").unwrap();
        fs::write(&forbidden_doc, "forbidden").unwrap();
        fs::write(&env_file, "SECRET=1").unwrap();
        fs::write(&nested_file, "console.log(1)").unwrap();
        fs::write(&sub_doc, "# Chapter").unwrap();

        // 1. Create SQLite DB with settings in kv_documents
        let db_path = user_data_dir.join("learnharness.db");
        let mut conn = rusqlite::Connection::open(&db_path).unwrap();
        crate::storage::schema::init_schema(&mut conn).unwrap();
        let settings = serde_json::json!({
            "agent": {
                "fileAccess": {
                    "restricted": true,
                    "folders": [allowed.to_str().unwrap()]
                }
            }
        });
        conn.execute(
            "INSERT INTO kv_documents (key, value_json, updated_at) VALUES ('settings', ?1, ?2)",
            rusqlite::params![settings.to_string(), 1700000000i64],
        )
        .unwrap();

        // 2. Validate external read path reads settings from SQLite
        let res_allowed = validate_external_read_path(
            allowed_doc.to_str().unwrap(),
            &data_dir,
            &auth_file,
            Some(&home),
        );
        assert!(res_allowed.is_ok());

        let res_forbidden = validate_external_read_path(
            forbidden_doc.to_str().unwrap(),
            &data_dir,
            &auth_file,
            Some(&home),
        );
        assert!(res_forbidden.is_err());
        assert_eq!(
            res_forbidden.unwrap_err(),
            "Access denied: outside allowed folders"
        );

        // 3. Walk external under allowed: must find allowed_doc and sub_doc, but skip .env and node_modules
        let walked = walk_external(&allowed, &data_dir, &auth_file, Some(&home), None).unwrap();
        let canon_allowed_doc = fs::canonicalize(&allowed_doc).unwrap();
        let canon_sub_doc = fs::canonicalize(&sub_doc).unwrap();
        assert!(walked.contains(&to_posix(&canon_allowed_doc)));
        assert!(walked.contains(&to_posix(&canon_sub_doc)));
        assert!(!walked.iter().any(|p| p.contains(".env")));
        assert!(!walked.iter().any(|p| p.contains("node_modules")));
    }
}
