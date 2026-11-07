use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FsMutationOp {
    WriteFile {
        path: String,
        data_base64: String,
        #[serde(default)]
        mode: Option<u32>,
    },
    AppendFile {
        path: String,
        data_base64: String,
        #[serde(default)]
        mode: Option<u32>,
    },
    Rename {
        old_path: String,
        new_path: String,
    },
    Unlink {
        path: String,
    },
    Mkdir {
        path: String,
        #[serde(default)]
        recursive: Option<bool>,
        #[serde(default)]
        mode: Option<u32>,
    },
    Rm {
        path: String,
        #[serde(default)]
        recursive: Option<bool>,
        #[serde(default)]
        force: Option<bool>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedFsSnapshot {
    pub root: String,
    pub data_dir: String,
    pub auth_file: String,
    #[serde(rename = "homeDir")]
    pub home_dir: String,
    pub files: HashMap<String, String>,
    pub dirs: Vec<String>,
}

pub fn resolve_allowed(
    path: &str,
    data_dir: &Path,
    auth_file: &Path,
    user_data_dir: &Path,
) -> Result<PathBuf, String> {
    let p = Path::new(path);
    for component in p.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err(format!("Parent directory traversal not allowed: {path}"));
        }
    }

    if !data_dir.exists() {
        let _ = std::fs::create_dir_all(data_dir);
    }
    if !user_data_dir.exists() {
        let _ = std::fs::create_dir_all(user_data_dir);
    }

    let canonical_data_dir = data_dir
        .canonicalize()
        .map_err(|e| format!("Invalid data_dir: {e}"))?;
    let canonical_user_data_dir = user_data_dir
        .canonicalize()
        .map_err(|e| format!("Invalid user_data_dir: {e}"))?;

    let mut curr = p.to_path_buf();
    while !curr.exists() {
        match curr.parent() {
            Some(parent) => curr = parent.to_path_buf(),
            None => break,
        }
    }

    if curr.exists() {
        let canonical_curr = curr
            .canonicalize()
            .map_err(|e| format!("Canonicalize failed for ancestor: {e}"))?;

        if canonical_curr.starts_with(&canonical_data_dir) {
            if p.exists() {
                let canonical_p = p
                    .canonicalize()
                    .map_err(|e| format!("Canonicalize failed for path: {e}"))?;
                if !canonical_p.starts_with(&canonical_data_dir) {
                    return Err(format!("Symlink target escapes data_dir: {path}"));
                }
                return Ok(canonical_p);
            }
            let remaining = p.strip_prefix(&curr).unwrap_or(p);
            return Ok(canonical_curr.join(remaining));
        }

        if canonical_curr == canonical_user_data_dir {
            let is_direct_child =
                p.parent() == Some(user_data_dir) || p.parent() == Some(&canonical_user_data_dir);
            if is_direct_child {
                let file_name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if file_name == "auth.json" || file_name.ends_with("-credentials.json") {
                    if p.exists() {
                        let canonical_p = p
                            .canonicalize()
                            .map_err(|e| format!("Canonicalize failed: {e}"))?;
                        if canonical_p.parent() != Some(&canonical_user_data_dir) {
                            return Err(format!(
                                "Credential symlink outside user_data_dir: {path}"
                            ));
                        }
                        return Ok(canonical_p);
                    }
                    return Ok(canonical_user_data_dir.join(file_name));
                }
            }
        }
    }

    if p == auth_file {
        return Ok(auth_file.to_path_buf());
    }

    Err(format!("Path is not within allowed directories: {path}"))
}

pub fn apply_op(
    op: &FsMutationOp,
    data_dir: &Path,
    auth_file: &Path,
    user_data_dir: &Path,
) -> Result<(), String> {
    match op {
        FsMutationOp::WriteFile {
            path,
            data_base64,
            mode,
        } => {
            let resolved = resolve_allowed(path, data_dir, auth_file, user_data_dir)?;
            let file_name = resolved.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let is_credential =
                file_name == "auth.json" || file_name.ends_with("-credentials.json");

            let parent = resolved
                .parent()
                .ok_or_else(|| "Target path has no parent".to_string())?;
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;

            let temp_name = format!(
                ".tmp_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let temp_path = parent.join(temp_name);

            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data_base64.as_bytes())
                .map_err(|e| format!("Base64 decode failed: {e}"))?;

            fs::write(&temp_path, &bytes).map_err(|e| e.to_string())?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let perm_mode = if is_credential {
                    0o600
                } else {
                    mode.unwrap_or(0o644)
                };
                let _ = fs::set_permissions(&temp_path, fs::Permissions::from_mode(perm_mode));
            }

            fs::rename(&temp_path, &resolved).map_err(|e| e.to_string())?;

            #[cfg(unix)]
            {
                if is_credential {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&resolved, fs::Permissions::from_mode(0o600));
                }
            }
            Ok(())
        }
        FsMutationOp::AppendFile {
            path,
            data_base64,
            mode,
        } => {
            let resolved = resolve_allowed(path, data_dir, auth_file, user_data_dir)?;
            let file_name = resolved.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let is_credential =
                file_name == "auth.json" || file_name.ends_with("-credentials.json");

            if let Some(parent) = resolved.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }

            let is_new = !resolved.exists();
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&resolved)
                .map_err(|e| e.to_string())?;

            #[cfg(unix)]
            if is_new {
                use std::os::unix::fs::PermissionsExt;
                let perm_mode = if is_credential {
                    0o600
                } else {
                    mode.unwrap_or(0o644)
                };
                let _ = fs::set_permissions(&resolved, fs::Permissions::from_mode(perm_mode));
            }

            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data_base64.as_bytes())
                .map_err(|e| format!("Base64 decode failed: {e}"))?;

            use std::io::Write;
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            Ok(())
        }
        FsMutationOp::Rename { old_path, new_path } => {
            let resolved_old = resolve_allowed(old_path, data_dir, auth_file, user_data_dir)?;
            let resolved_new = resolve_allowed(new_path, data_dir, auth_file, user_data_dir)?;

            if let Some(parent) = resolved_new.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }

            fs::rename(&resolved_old, &resolved_new).map_err(|e| e.to_string())?;
            Ok(())
        }
        FsMutationOp::Unlink { path } => {
            let resolved = resolve_allowed(path, data_dir, auth_file, user_data_dir)?;
            if resolved.exists() {
                fs::remove_file(&resolved).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        FsMutationOp::Mkdir {
            path,
            recursive,
            mode: _,
        } => {
            let resolved = resolve_allowed(path, data_dir, auth_file, user_data_dir)?;
            if recursive.unwrap_or(false) {
                fs::create_dir_all(&resolved).map_err(|e| e.to_string())?;
            } else {
                fs::create_dir(&resolved).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        FsMutationOp::Rm {
            path,
            recursive,
            force,
        } => {
            let resolved = resolve_allowed(path, data_dir, auth_file, user_data_dir)?;
            if resolved.exists() {
                if recursive.unwrap_or(false) {
                    fs::remove_dir_all(&resolved).map_err(|e| e.to_string())?;
                } else if resolved.is_dir() {
                    fs::remove_dir(&resolved).map_err(|e| e.to_string())?;
                } else {
                    fs::remove_file(&resolved).map_err(|e| e.to_string())?;
                }
            } else if !force.unwrap_or(false) {
                return Err(format!("Path does not exist: {path}"));
            }
            Ok(())
        }
    }
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

fn collect_dir_files(dir: &Path, files: &mut HashMap<String, String>, dirs: &mut Vec<String>) {
    if !dir.exists() {
        return;
    }
    dirs.push(dir.to_string_lossy().to_string());
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_dir_files(&path, files, dirs);
            } else if path.is_file() {
                if let Ok(content) = fs::read(&path) {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&content);
                    files.insert(path.to_string_lossy().to_string(), b64);
                }
            }
        }
    }
}

#[tauri::command]
pub async fn lh_fs_hydrate(app: tauri::AppHandle) -> Result<HydratedFsSnapshot, String> {
    use tauri::Manager;
    let (data_dir, auth_file, user_data_dir) = resolve_app_dirs(&app);
    let root = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .to_string_lossy()
        .to_string();

    let mut files = HashMap::new();
    let mut dirs = Vec::new();

    collect_dir_files(&data_dir, &mut files, &mut dirs);

    if auth_file.exists() {
        if let Ok(content) = fs::read(&auth_file) {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&content);
            files.insert(auth_file.to_string_lossy().to_string(), b64);
        }
    }

    if user_data_dir.exists() {
        if let Ok(entries) = fs::read_dir(&user_data_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if name.ends_with("-credentials.json") {
                        if let Ok(content) = fs::read(&p) {
                            let b64 = base64::engine::general_purpose::STANDARD.encode(&content);
                            files.insert(p.to_string_lossy().to_string(), b64);
                        }
                    }
                }
            }
        }
    }

    let home_dir = dirs_home()
        .map(|p| to_posix(&p))
        .unwrap_or_else(|| "/home".to_string());

    Ok(HydratedFsSnapshot {
        root,
        data_dir: data_dir.to_string_lossy().to_string(),
        auth_file: auth_file.to_string_lossy().to_string(),
        home_dir,
        files,
        dirs,
    })
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

pub fn validate_external_read_path(
    raw: &str,
    data_dir: &Path,
    auth_file: &Path,
    home_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.contains('\0') {
        return Err("Invalid path".to_string());
    }

    let raw_path = Path::new(raw);
    if !raw_path.is_absolute() {
        return Err(format!("Path must be absolute: {raw}"));
    }

    let canonical = fs::canonicalize(raw).map_err(|e| format!("Failed to resolve {raw}: {e}"))?;

    if !canonical.is_file() {
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

    let settings_path = data_dir.join("settings.json");
    if settings_path.exists() {
        if let Ok(content) = fs::read_to_string(&settings_path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
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
                            } else if folder_str.starts_with("~/") || folder_str.starts_with("~\\")
                            {
                                home_dir.map(|h| h.join(&folder_str[2..]))
                            } else {
                                Some(PathBuf::from(folder_str))
                            };

                            if let Some(fp) = folder_path {
                                if let Ok(canon_folder) = fs::canonicalize(&fp) {
                                    let mut folder_is_sensitive = false;
                                    if let Some(home) = home_dir {
                                        let canonical_home = fs::canonicalize(home)
                                            .unwrap_or_else(|_| home.to_path_buf());
                                        if is_sensitive_home_subpath(&canon_folder, home)
                                            || is_sensitive_home_subpath(
                                                &canon_folder,
                                                &canonical_home,
                                            )
                                            || is_sensitive_home_subpath(&fp, home)
                                            || is_sensitive_home_subpath(&fp, &canonical_home)
                                        {
                                            folder_is_sensitive = true;
                                        }
                                    }
                                    if is_credential_or_temp_file(
                                        &canon_folder,
                                        auth_file,
                                        &canonical_auth,
                                    ) || is_credential_or_temp_file(
                                        &fp,
                                        auth_file,
                                        &canonical_auth,
                                    ) {
                                        folder_is_sensitive = true;
                                    }

                                    if !folder_is_sensitive && canonical.starts_with(&canon_folder)
                                    {
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
        }
    }

    Ok(canonical)
}

#[tauri::command]
pub async fn lh_fs_sync(app: tauri::AppHandle, op: FsMutationOp) -> Result<(), String> {
    let (data_dir, auth_file, user_data_dir) = resolve_app_dirs(&app);
    apply_op(&op, &data_dir, &auth_file, &user_data_dir)
}

#[tauri::command]
pub async fn lh_fs_read_external(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    let (data_dir, auth_file, _) = resolve_app_dirs(&app);
    let home = dirs_home();
    let safe_path = validate_external_read_path(&path, &data_dir, &auth_file, home.as_deref())?;
    fs::read(&safe_path).map_err(|e| format!("Failed to read {path}: {e}"))
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
    fn allows_path_inside_data_dir() {
        let (_guard, data_dir, auth_file, user_data_dir) = setup_dirs();
        let target = data_dir.join("notes.md");
        let resolved = resolve_allowed(
            target.to_str().unwrap(),
            &data_dir,
            &auth_file,
            &user_data_dir,
        );
        assert!(resolved.is_ok());
    }

    #[test]
    fn rejects_dotdot_escape() {
        let (_guard, data_dir, auth_file, user_data_dir) = setup_dirs();
        let target = data_dir.join("../outside.txt");
        let resolved = resolve_allowed(
            target.to_str().unwrap(),
            &data_dir,
            &auth_file,
            &user_data_dir,
        );
        assert!(resolved.is_err());
    }

    #[test]
    fn rejects_sibling_prefix_dir() {
        let (_guard, data_dir, auth_file, user_data_dir) = setup_dirs();
        let sibling = data_dir
            .parent()
            .unwrap()
            .join("LearnHarness-evil")
            .join("a.json");
        let resolved = resolve_allowed(
            sibling.to_str().unwrap(),
            &data_dir,
            &auth_file,
            &user_data_dir,
        );
        assert!(
            resolved.is_err(),
            "must reject sibling prefix matching directory"
        );
    }

    #[test]
    fn rejects_symlink_escape() {
        let (_guard, data_dir, auth_file, user_data_dir) = setup_dirs();
        let outside = data_dir.parent().unwrap().join("outside_dir");
        fs::create_dir_all(&outside).unwrap();
        let symlink_path = data_dir.join("link_to_outside");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &symlink_path).unwrap();

        let op = FsMutationOp::WriteFile {
            path: symlink_path
                .join("secret.txt")
                .to_str()
                .unwrap()
                .to_string(),
            data_base64: "aGVsbG8=".to_string(),
            mode: None,
        };
        let res = apply_op(&op, &data_dir, &auth_file, &user_data_dir);
        assert!(
            res.is_err(),
            "writeFile through symlink outside data_dir must return Err"
        );
    }

    #[test]
    fn allows_auth_json_and_credentials_files() {
        let (_guard, data_dir, auth_file, user_data_dir) = setup_dirs();
        let res_auth = resolve_allowed(
            auth_file.to_str().unwrap(),
            &data_dir,
            &auth_file,
            &user_data_dir,
        );
        assert!(res_auth.is_ok());

        let chatgpt_cred = user_data_dir.join("chatgpt-credentials.json");
        let res_chatgpt = resolve_allowed(
            chatgpt_cred.to_str().unwrap(),
            &data_dir,
            &auth_file,
            &user_data_dir,
        );
        assert!(res_chatgpt.is_ok());

        let copilot_cred = user_data_dir.join("github-copilot-credentials.json");
        let res_copilot = resolve_allowed(
            copilot_cred.to_str().unwrap(),
            &data_dir,
            &auth_file,
            &user_data_dir,
        );
        assert!(res_copilot.is_ok());
    }

    #[test]
    fn rejects_other_files_in_user_data_dir() {
        let (_guard, data_dir, auth_file, user_data_dir) = setup_dirs();
        let other = user_data_dir.join("malicious.sh");
        let res = resolve_allowed(
            other.to_str().unwrap(),
            &data_dir,
            &auth_file,
            &user_data_dir,
        );
        assert!(res.is_err());

        let other_json = user_data_dir.join("settings_evil.json");
        let res2 = resolve_allowed(
            other_json.to_str().unwrap(),
            &data_dir,
            &auth_file,
            &user_data_dir,
        );
        assert!(res2.is_err());
    }

    #[test]
    #[cfg(unix)]
    fn credentials_written_with_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let (_guard, data_dir, auth_file, user_data_dir) = setup_dirs();

        let op = FsMutationOp::WriteFile {
            path: auth_file.to_str().unwrap().to_string(),
            data_base64: "e30=".to_string(),
            mode: None,
        };
        apply_op(&op, &data_dir, &auth_file, &user_data_dir).unwrap();
        let meta = fs::metadata(&auth_file).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);

        let cred = user_data_dir.join("chatgpt-credentials.json");
        let op_cred = FsMutationOp::WriteFile {
            path: cred.to_str().unwrap().to_string(),
            data_base64: "e30=".to_string(),
            mode: None,
        };
        apply_op(&op_cred, &data_dir, &auth_file, &user_data_dir).unwrap();
        let meta_cred = fs::metadata(&cred).unwrap();
        assert_eq!(meta_cred.permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn rename_overwrites_atomically() {
        let (_guard, data_dir, auth_file, user_data_dir) = setup_dirs();
        let file1 = data_dir.join("file1.txt");
        let file2 = data_dir.join("file2.txt");

        let op1 = FsMutationOp::WriteFile {
            path: file1.to_str().unwrap().to_string(),
            data_base64: "ZmlsZTE=".to_string(), // "file1"
            mode: None,
        };
        apply_op(&op1, &data_dir, &auth_file, &user_data_dir).unwrap();

        let op2 = FsMutationOp::WriteFile {
            path: file2.to_str().unwrap().to_string(),
            data_base64: "ZmlsZTI=".to_string(), // "file2"
            mode: None,
        };
        apply_op(&op2, &data_dir, &auth_file, &user_data_dir).unwrap();

        let op_rename = FsMutationOp::Rename {
            old_path: file1.to_str().unwrap().to_string(),
            new_path: file2.to_str().unwrap().to_string(),
        };
        apply_op(&op_rename, &data_dir, &auth_file, &user_data_dir).unwrap();

        assert!(!file1.exists());
        assert_eq!(fs::read_to_string(&file2).unwrap(), "file1");
    }

    #[test]
    fn nonexistent_initial_directories_created_and_canonicalized() {
        let id = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "lh_nonexistent_{}_{}_{}",
            std::process::id(),
            id,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let data_dir = base.join("nonexistent_data");
        let user_data_dir = base.join("nonexistent_user_data");
        let auth_file = user_data_dir.join("auth.json");

        assert!(!data_dir.exists());
        assert!(!user_data_dir.exists());

        let target = data_dir.join("file.txt");
        let resolved = resolve_allowed(
            target.to_str().unwrap(),
            &data_dir,
            &auth_file,
            &user_data_dir,
        );
        assert!(resolved.is_ok());
        assert!(data_dir.exists());
        assert!(user_data_dir.exists());

        let _ = fs::remove_dir_all(&base);
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
}
