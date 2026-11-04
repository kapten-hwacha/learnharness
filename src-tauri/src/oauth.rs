use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthRequestPayload {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
}

pub struct OAuthResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

struct PendingOAuth {
    #[allow(dead_code)]
    port: u16,
    shutdown: Arc<AtomicBool>,
    response_sender: Arc<Mutex<Option<mpsc::Sender<OAuthResponse>>>>,
}

static OAUTH_STATE: Mutex<Option<PendingOAuth>> = Mutex::new(None);

pub fn start_oauth_listener_internal(
    on_request: Option<Box<dyn Fn(OAuthRequestPayload) + Send + 'static>>,
) -> Result<u16, String> {
    let mut lock = OAUTH_STATE.lock().unwrap();
    if lock.is_some() {
        return Err("OAuth listener already running".into());
    }

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let shutdown = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<OAuthResponse>();
    let response_sender = Arc::new(Mutex::new(Some(tx)));

    *lock = Some(PendingOAuth {
        port,
        shutdown: shutdown.clone(),
        response_sender: response_sender.clone(),
    });

    thread::spawn(move || {
        while !shutdown.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    handle_connection(&mut stream, &shutdown, &rx, &on_request);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(std::time::Duration::from_millis(25));
                }
                Err(_) => {
                    if shutdown.load(Ordering::SeqCst) {
                        break;
                    }
                }
            }
        }
    });

    Ok(port)
}

fn handle_connection(
    stream: &mut TcpStream,
    shutdown: &Arc<AtomicBool>,
    rx: &mpsc::Receiver<OAuthResponse>,
    on_request: &Option<Box<dyn Fn(OAuthRequestPayload) + Send + 'static>>,
) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(5)));

    let mut buf = [0u8; 4096];
    let mut total_bytes = Vec::new();

    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                total_bytes.extend_from_slice(&buf[..n]);
                if total_bytes.windows(4).any(|w| w == b"\r\n\r\n") || total_bytes.len() > 16384 {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    let req_str = String::from_utf8_lossy(&total_bytes);
    let mut lines = req_str.lines();
    let req_line = match lines.next() {
        Some(l) => l,
        None => return,
    };

    let parts: Vec<&str> = req_line.split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0].to_uppercase();
    let url_raw = parts[1];

    let path_part = url_raw.split('?').next().unwrap_or(url_raw);

    if method != "GET" || path_part != "/auth/callback" {
        let resp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        let _ = stream.shutdown(std::net::Shutdown::Write);
        return;
    }

    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_lowercase(), v.trim().to_string()));
        }
    }

    let payload = OAuthRequestPayload {
        method,
        url: url_raw.to_string(),
        headers,
    };

    if let Some(ref cb) = on_request {
        cb(payload);
    }

    match rx.recv_timeout(std::time::Duration::from_secs(60)) {
        Ok(resp) => {
            let status_line = format!("HTTP/1.1 {} OK\r\n", resp.status);
            let mut head_str = status_line;
            for (k, v) in resp.headers {
                head_str.push_str(&format!("{k}: {v}\r\n"));
            }
            head_str.push_str(&format!(
                "Content-Length: {}\r\nConnection: close\r\n\r\n",
                resp.body.len()
            ));
            let _ = stream.write_all(head_str.as_bytes());
            let _ = stream.write_all(resp.body.as_bytes());
            let _ = stream.flush();
            let _ = stream.shutdown(std::net::Shutdown::Write);
        }
        Err(_) => {
            let resp =
                "HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
            let _ = stream.shutdown(std::net::Shutdown::Write);
        }
    }

    shutdown.store(true, Ordering::SeqCst);
    let mut lock = OAUTH_STATE.lock().unwrap();
    *lock = None;
}

pub fn start_oauth_listener() -> Result<u16, String> {
    start_oauth_listener_internal(None)
}

pub fn close_oauth_listener() {
    let mut lock = OAUTH_STATE.lock().unwrap();
    if let Some(pending) = lock.take() {
        pending.shutdown.store(true, Ordering::SeqCst);
    }
}

pub fn respond_oauth(
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
) -> Result<(), String> {
    let sender_opt = {
        let lock = OAUTH_STATE.lock().unwrap();
        lock.as_ref()
            .and_then(|p| p.response_sender.lock().unwrap().take())
    };
    if let Some(sender) = sender_opt {
        sender
            .send(OAuthResponse {
                status,
                headers,
                body,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("No pending OAuth response channel".into())
    }
}

#[tauri::command]
pub async fn lh_oauth_listen_start(app: tauri::AppHandle) -> Result<u16, String> {
    let app_clone = app.clone();
    start_oauth_listener_internal(Some(Box::new(move |payload| {
        let _ = app_clone.emit("lh://oauth-request", payload);
    })))
}

#[tauri::command]
pub async fn lh_oauth_listen_close() -> Result<(), String> {
    close_oauth_listener();
    Ok(())
}

#[tauri::command]
pub async fn lh_oauth_respond(
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
) -> Result<(), String> {
    respond_oauth(status, headers, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::Mutex;

    static TEST_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn second_start_fails_while_pending() {
        let _guard = TEST_MUTEX.lock().unwrap();
        let port = start_oauth_listener().expect("first listen succeeds");
        assert!(port > 0);
        let second = start_oauth_listener();
        assert!(second.is_err(), "second listen while pending must fail");
        close_oauth_listener();
    }

    #[test]
    fn unsolicited_path_gets_404_without_consuming() {
        let _guard = TEST_MUTEX.lock().unwrap();
        let port = start_oauth_listener().expect("listen succeeds");
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect succeeds");
        stream
            .write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .expect("write succeeds");
        let mut resp = String::new();
        stream.read_to_string(&mut resp).expect("read succeeds");
        assert!(
            resp.starts_with("HTTP/1.1 404"),
            "expected 404 response, got: {resp}"
        );
        assert!(start_oauth_listener().is_err());
        close_oauth_listener();
    }
}
