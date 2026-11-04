pub const SIDEBAR_AUTOCLOSE: f64 = 928.0;

pub fn clamp_zoom(f: f64) -> f64 {
    if f.is_nan() {
        1.0
    } else {
        f.clamp(0.75, 2.0)
    }
}

#[tauri::command]
pub async fn lh_expand_window(window: tauri::Window) -> Result<(), String> {
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
    let logical_width = size.width as f64 / scale_factor;
    if logical_width < SIDEBAR_AUTOCLOSE {
        let new_size =
            tauri::LogicalSize::new(SIDEBAR_AUTOCLOSE, size.height as f64 / scale_factor);
        window.set_size(new_size).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn lh_set_zoom(window: tauri::Window, factor: f64) -> Result<f64, String> {
    use tauri::Emitter;
    let clamped = clamp_zoom(factor);
    let _ = window.emit("lh://zoom", clamped);
    Ok(clamped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_zoom_bounds() {
        assert_eq!(clamp_zoom(0.1), 0.75);
        assert_eq!(clamp_zoom(5.0), 2.0);
        assert_eq!(clamp_zoom(1.25), 1.25);
        assert_eq!(clamp_zoom(f64::NAN), 1.0);
    }
}
