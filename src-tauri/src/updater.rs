use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub status: String,
    pub version: Option<String>,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateEvent {
    Checking,
    Downloading { version: Option<String> },
    UpToDate,
    Downloaded { version: Option<String> },
    Error(String),
}

#[derive(Debug, Clone)]
pub struct UpdateMachine {
    state: UpdateState,
    is_packaged: bool,
}

impl UpdateMachine {
    pub fn new(is_packaged: bool) -> Self {
        Self {
            state: UpdateState {
                status: if is_packaged { "idle" } else { "disabled" }.to_string(),
                version: None,
                revision: 0,
            },
            is_packaged,
        }
    }

    pub fn state(&self) -> &UpdateState {
        &self.state
    }

    pub fn on_event(&mut self, ev: UpdateEvent) -> UpdateState {
        if !self.is_packaged || self.state.status == "disabled" {
            return self.state.clone();
        }

        if self.state.status == "downloaded" {
            match &ev {
                UpdateEvent::Checking | UpdateEvent::Error(_) => {
                    return self.state.clone();
                }
                _ => {}
            }
        }

        let (new_status, new_version) = match ev {
            UpdateEvent::Checking => ("checking".to_string(), self.state.version.clone()),
            UpdateEvent::Downloading { version } => (
                "downloading".to_string(),
                version.or(self.state.version.clone()),
            ),
            UpdateEvent::UpToDate => ("up-to-date".to_string(), self.state.version.clone()),
            UpdateEvent::Downloaded { version } => (
                "downloaded".to_string(),
                version.or(self.state.version.clone()),
            ),
            UpdateEvent::Error(_) => ("error".to_string(), self.state.version.clone()),
        };

        if new_status != self.state.status || new_version != self.state.version {
            self.state.status = new_status;
            self.state.version = new_version;
            self.state.revision += 1;
        }

        self.state.clone()
    }
}

static UPDATER_MACHINE: Mutex<Option<UpdateMachine>> = Mutex::new(None);

pub fn init_updater_machine(is_packaged: bool) {
    let mut lock = UPDATER_MACHINE.lock().unwrap();
    *lock = Some(UpdateMachine::new(is_packaged));
}

fn with_machine<F, R>(f: F) -> R
where
    F: FnOnce(&mut UpdateMachine) -> R,
{
    let mut lock = UPDATER_MACHINE.lock().unwrap();
    if lock.is_none() {
        *lock = Some(UpdateMachine::new(cfg!(not(debug_assertions))));
    }
    f(lock.as_mut().unwrap())
}

#[tauri::command]
pub async fn lh_update_get() -> Result<UpdateState, String> {
    Ok(with_machine(|m| m.state().clone()))
}

#[tauri::command]
pub async fn lh_update_check(app: tauri::AppHandle) -> Result<(), String> {
    let current_status = with_machine(|m| m.state().status.clone());
    if current_status == "disabled" {
        return Ok(());
    }

    let next_state = with_machine(|m| m.on_event(UpdateEvent::Checking));
    let _ = app.emit("lh://update-status", &next_state);

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_updater::UpdaterExt;
        let updater_res = app_handle.updater();
        match updater_res {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => {
                    let version = Some(update.version.clone());
                    let downloading_state = with_machine(|m| {
                        m.on_event(UpdateEvent::Downloading {
                            version: version.clone(),
                        })
                    });
                    let _ = app_handle.emit("lh://update-status", &downloading_state);

                    match update.download_and_install(|_, _| {}, || {}).await {
                        Ok(()) => {
                            let downloaded_state =
                                with_machine(|m| m.on_event(UpdateEvent::Downloaded { version }));
                            let _ = app_handle.emit("lh://update-status", &downloaded_state);
                        }
                        Err(e) => {
                            let err_state =
                                with_machine(|m| m.on_event(UpdateEvent::Error(e.to_string())));
                            let _ = app_handle.emit("lh://update-status", &err_state);
                        }
                    }
                }
                Ok(None) => {
                    let uptodate_state = with_machine(|m| m.on_event(UpdateEvent::UpToDate));
                    let _ = app_handle.emit("lh://update-status", &uptodate_state);
                }
                Err(e) => {
                    let err_state = with_machine(|m| m.on_event(UpdateEvent::Error(e.to_string())));
                    let _ = app_handle.emit("lh://update-status", &err_state);
                }
            },
            Err(e) => {
                let err_state = with_machine(|m| m.on_event(UpdateEvent::Error(e.to_string())));
                let _ = app_handle.emit("lh://update-status", &err_state);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn lh_update_install(app: tauri::AppHandle) -> Result<(), String> {
    let current_status = with_machine(|m| m.state().status.clone());
    if current_status == "downloaded" {
        app.restart();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloaded_is_sticky() {
        let mut m = UpdateMachine::new(true);
        m.on_event(UpdateEvent::Downloaded {
            version: Some("1.2.3".into()),
        });
        assert_eq!(m.state().status, "downloaded");
        m.on_event(UpdateEvent::Checking);
        assert_eq!(m.state().status, "downloaded");
        m.on_event(UpdateEvent::Error("failed".into()));
        assert_eq!(m.state().status, "downloaded");
    }

    #[test]
    fn disabled_when_unpackaged() {
        let mut m = UpdateMachine::new(false);
        assert_eq!(m.state().status, "disabled");
        m.on_event(UpdateEvent::Checking);
        assert_eq!(m.state().status, "disabled");
    }

    #[test]
    fn revision_increments_per_change() {
        let mut m = UpdateMachine::new(true);
        assert_eq!(m.state().revision, 0);
        m.on_event(UpdateEvent::Checking);
        assert_eq!(m.state().revision, 1);
        m.on_event(UpdateEvent::Downloading {
            version: Some("2.0.0".into()),
        });
        assert_eq!(m.state().revision, 2);
    }
}
