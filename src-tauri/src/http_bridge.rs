use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body_base64: String,
}

pub fn validate_external_url(url_str: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url_str).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" {
        return Err("Only https URLs are allowed".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URLs with user credentials are not allowed".into());
    }
    if parsed.host_str().is_none() {
        return Err("URL must have a host".into());
    }
    Ok(())
}

static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn get_client() -> &'static reqwest::Client {
    CLIENT.get_or_init(reqwest::Client::new)
}

#[tauri::command]
pub async fn lh_http_fetch(req: HttpRequest) -> Result<HttpResponse, String> {
    let client = get_client();
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|e| format!("Invalid HTTP method: {e}"))?;
    let mut builder = client.request(method, &req.url);
    for (k, v) in req.headers {
        builder = builder.header(k, v);
    }
    if let Some(body_base64) = req.body_base64 {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(body_base64.as_bytes())
            .map_err(|e| format!("Invalid base64 body: {e}"))?;
        builder = builder.body(bytes);
    }

    let response = builder.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let mut headers = Vec::new();
    for (name, value) in response.headers() {
        if let Ok(v_str) = value.to_str() {
            headers.push((name.as_str().to_string(), v_str.to_string()));
        }
    }
    let body_bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let body_base64 = base64::engine::general_purpose::STANDARD.encode(&body_bytes);

    Ok(HttpResponse {
        status,
        headers,
        body_base64,
    })
}

#[tauri::command]
pub async fn lh_open_external(url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    open::that_detached(&url).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_url_https_only() {
        assert!(validate_external_url("https://a.com/x").is_ok());
        assert!(validate_external_url("http://a.com").is_err());
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("https://u:p@a.com").is_err());
    }
}
