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

pub fn validate_fetch_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("Invalid URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Only http and https schemes are allowed".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with user credentials are not allowed".into());
    }
    let host = url
        .host()
        .ok_or_else(|| "URL must have a host".to_string())?;
    match host {
        url::Host::Domain(domain) => {
            let d = domain.trim_end_matches('.');
            if d.eq_ignore_ascii_case("metadata.google.internal") || d == "0.0.0.0" {
                return Err("Access to host is forbidden".into());
            }
        }
        url::Host::Ipv4(ip) => {
            if ip.is_unspecified() {
                return Err("Unspecified IP address (0.0.0.0) is forbidden".into());
            }
            if ip.is_link_local() {
                return Err("Link-local address (169.254.0.0/16) is forbidden".into());
            }
        }
        url::Host::Ipv6(ip) => {
            if ip.is_unspecified() {
                return Err("Unspecified IPv6 address (::) is forbidden".into());
            }
            // fe80::/10 unicast link-local
            if (ip.segments()[0] & 0xffc0) == 0xfe80 {
                return Err("IPv6 link-local address is forbidden".into());
            }
            // IPv4-mapped link-local or unspecified: ::ffff:a.b.c.d
            let seg = ip.segments();
            if seg[0] == 0
                && seg[1] == 0
                && seg[2] == 0
                && seg[3] == 0
                && seg[4] == 0
                && seg[5] == 0xffff
            {
                let oct = ip.octets();
                let ipv4 = std::net::Ipv4Addr::new(oct[12], oct[13], oct[14], oct[15]);
                if ipv4.is_unspecified() {
                    return Err("IPv4-mapped unspecified address is forbidden".into());
                }
                if ipv4.is_link_local() {
                    return Err("IPv4-mapped link-local address is forbidden".into());
                }
            }
        }
    }
    Ok(url)
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
    CLIENT.get_or_init(|| {
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                return attempt.error("Too many redirects (max 10)");
            }
            if let Err(e) = validate_fetch_url(attempt.url().as_str()) {
                return attempt.error(e);
            }
            attempt.follow()
        });
        reqwest::Client::builder()
            .redirect(policy)
            .build()
            .expect("Failed to build reqwest client")
    })
}

#[tauri::command]
pub async fn lh_http_fetch(req: HttpRequest) -> Result<HttpResponse, String> {
    validate_fetch_url(&req.url)?;
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

    #[test]
    fn test_validate_fetch_url() {
        // Blocked cases
        assert!(validate_fetch_url("file:///etc/passwd").is_err());
        assert!(validate_fetch_url("http://169.254.169.254/latest/meta-data/").is_err());
        assert!(validate_fetch_url("http://metadata.google.internal").is_err());
        assert!(validate_fetch_url("http://metadata.google.internal.").is_err());
        assert!(validate_fetch_url("http://0.0.0.0:8080").is_err());
        assert!(validate_fetch_url("http://[fe80::1]:8080").is_err());
        assert!(validate_fetch_url("http://[::]:8080").is_err());
        assert!(validate_fetch_url("http://[::ffff:169.254.1.1]:8080").is_err());
        assert!(validate_fetch_url("http://user:pass@127.0.0.1:8080").is_err());

        // Allowed cases
        assert!(validate_fetch_url("https://api.openai.com/v1/models").is_ok());
        assert!(validate_fetch_url("http://127.0.0.1:11434/api/tags").is_ok());
        assert!(validate_fetch_url("http://localhost:3000/api").is_ok());
        assert!(validate_fetch_url("http://192.168.1.100:8000/").is_ok());
        assert!(validate_fetch_url("http://[::1]:8080/test").is_ok());
    }
}
