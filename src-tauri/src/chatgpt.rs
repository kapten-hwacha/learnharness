//! Native-only ChatGPT credential storage. No command exposes this state to
//! the webview; the OAuth owner and authenticated transport use it directly.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CREDENTIAL_FILE: &str = "chatgpt-credentials.json";
const ISSUER: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPES: [&str; 6] = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "resource.invoke",
    "chatgpt.tokens.use.direct",
];
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct LoginAttempt {
    verifier: String,
    nonce: String,
    state: String,
    redirect_uri: String,
    authorization_url: url::Url,
}

fn random_string() -> Result<String, &'static str> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "Secure random generation failed")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn random_uuid() -> Result<String, &'static str> {
    let mut b = [0u8; 16];
    SystemRandom::new()
        .fill(&mut b)
        .map_err(|_| "Secure random generation failed")?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

fn make_login_attempt(
    port: u16,
    host_id: &str,
    selected: Option<&Value>,
) -> Result<LoginAttempt, &'static str> {
    let verifier = random_string()?;
    let nonce = random_string()?;
    let state = random_string()?;
    let redirect_uri = format!("http://127.0.0.1:{port}/auth/callback");
    let client_id = selected
        .and_then(|v| v.get("clientId"))
        .and_then(Value::as_str)
        .unwrap_or("dynamic_agent_client");
    let challenge = URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, verifier.as_bytes()));
    let mut authorization_url = url::Url::parse("https://auth.openai.com/api/accounts/authorize")
        .map_err(|_| "Invalid authorization URL")?;
    {
        let mut query = authorization_url.query_pairs_mut();
        query.append_pair("client_id", client_id);
        if selected.is_none() {
            query.append_pair("agent_name_hint", "LearnHarness");
        }
        query.append_pair("ext_agent_host_id", host_id);
        if let Some(id_token) = selected
            .and_then(|v| v.pointer("/tokens/idToken"))
            .and_then(Value::as_str)
        {
            query.append_pair("id_token_hint", id_token);
        }
        if let Some(email) = selected
            .and_then(|v| v.get("email"))
            .and_then(Value::as_str)
        {
            query.append_pair("login_hint", email);
        }
        query.append_pair("response_type", "code");
        query.append_pair("redirect_uri", &redirect_uri);
        query.append_pair("scope", &SCOPES.join(" "));
        query.append_pair("resource", RESOURCE);
        query.append_pair("state", &state);
        query.append_pair("nonce", &nonce);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("code_challenge", &challenge);
    }
    Ok(LoginAttempt {
        verifier,
        nonce,
        state,
        redirect_uri,
        authorization_url,
    })
}

/// Preserve a revocation handle even if the provider omitted plan scopes.
fn token_set(body: &Value, previous: Option<&Value>, now_ms: u64) -> Result<Value, &'static str> {
    let invalid = || "ChatGPT token response could not be verified";
    let scopes: Vec<String> = match body.get("scope").and_then(Value::as_str) {
        Some(scope) => scope.split_whitespace().map(str::to_owned).collect(),
        None => previous
            .and_then(|p| p.get("scopes"))
            .and_then(Value::as_array)
            .ok_or_else(invalid)?
            .iter()
            .map(|v| v.as_str().map(str::to_owned).ok_or_else(invalid))
            .collect::<Result<_, _>>()?,
    };
    let id_token = body
        .get("id_token")
        .or_else(|| previous.and_then(|p| p.get("idToken")))
        .ok_or_else(invalid)?;
    if !nonempty(Some(id_token)) {
        return Err(invalid());
    }
    let refresh = body
        .get("refresh_token")
        .filter(|v| nonempty(Some(v)))
        .or_else(|| {
            previous
                .and_then(|p| p.get("refreshToken"))
                .filter(|v| nonempty(Some(v)))
        });
    let has_plan = SCOPES.iter().all(|scope| scopes.iter().any(|s| s == scope));
    if !has_plan {
        let mut result = serde_json::json!({"idToken": id_token, "scopes": scopes, "expiresAt": 0});
        if let Some(refresh) = refresh {
            result["refreshToken"] = refresh.clone();
        }
        return Ok(result);
    }
    let access = body
        .get("access_token")
        .filter(|v| nonempty(Some(v)))
        .and_then(Value::as_str)
        .filter(|s| !s.starts_with("sk-"))
        .ok_or_else(invalid)?;
    if !body
        .get("token_type")
        .and_then(Value::as_str)
        .is_some_and(|s| s.eq_ignore_ascii_case("bearer"))
    {
        return Err(invalid());
    }
    let duration = body
        .get("expires_in")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .ok_or_else(invalid)?;
    let expires = now_ms
        .checked_add(duration.checked_mul(1000).ok_or_else(invalid)?)
        .ok_or_else(invalid)?;
    let usable_refresh = body
        .get("refresh_token")
        .filter(|v| !v.is_null())
        .or_else(|| previous.and_then(|p| p.get("refreshToken")))
        .filter(|v| nonempty(Some(v)))
        .ok_or_else(invalid)?;
    Ok(
        serde_json::json!({"idToken":id_token,"scopes":scopes,"accessToken":access,"refreshToken":usable_refresh,"expiresAt":expires}),
    )
}

/// Validate a token only against keys fetched from the fixed OpenAI JWKS URL.
fn verify_identity(
    token: &str,
    jwks: &Value,
    client_id: &str,
    nonce: Option<&str>,
    expected_subject: Option<&str>,
    now: u64,
) -> Result<(String, Option<String>), &'static str> {
    let invalid = || "ChatGPT identity could not be verified";
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(invalid());
    }
    let decode = |s: &str| URL_SAFE_NO_PAD.decode(s).map_err(|_| invalid());
    let header: Value = serde_json::from_slice(&decode(parts[0])?).map_err(|_| invalid())?;
    if header.get("alg").and_then(Value::as_str) != Some("RS256")
        || header.get("crit").is_some()
        || header.get("b64").is_some_and(|v| v.as_bool() != Some(true))
        || header.get("kid").is_some_and(|v| !v.is_string())
    {
        return Err(invalid());
    }
    let kid = header.get("kid").and_then(Value::as_str);
    let keys = jwks
        .get("keys")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let matching: Vec<&Value> = keys
        .iter()
        .filter(|key| {
            key.get("kty").and_then(Value::as_str) == Some("RSA")
                && kid.map_or(true, |id| {
                    key.get("kid").and_then(Value::as_str) == Some(id)
                })
                && key.get("alg").map_or(true, |v| v.as_str() == Some("RS256"))
                && key.get("use").map_or(true, |v| v.as_str() == Some("sig"))
                && key.get("key_ops").map_or(true, |v| {
                    v.as_array()
                        .is_some_and(|ops| ops.iter().any(|op| op.as_str() == Some("verify")))
                })
        })
        .collect();
    if matching.len() != 1 {
        return Err(invalid());
    }
    let key = matching[0];
    let n = decode(key.get("n").and_then(Value::as_str).ok_or_else(invalid)?)?;
    let e = decode(key.get("e").and_then(Value::as_str).ok_or_else(invalid)?)?;
    let signed = format!("{}.{}", parts[0], parts[1]);
    ring::signature::RsaPublicKeyComponents { n: &n, e: &e }
        .verify(
            &ring::signature::RSA_PKCS1_2048_8192_SHA256,
            signed.as_bytes(),
            &decode(parts[2])?,
        )
        .map_err(|_| invalid())?;
    let claims: Value = serde_json::from_slice(&decode(parts[1])?).map_err(|_| invalid())?;
    let subject = claims
        .get("sub")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(invalid)?;
    let audience = claims.get("aud").ok_or_else(invalid)?;
    let audiences: Vec<&str> = if let Some(s) = audience.as_str() {
        vec![s]
    } else {
        audience
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .map(|v| v.as_str().ok_or_else(invalid))
            .collect::<Result<_, _>>()?
    };
    let azp = claims.get("azp");
    let exp = claims
        .get("exp")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    let _iat = claims
        .get("iat")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    if claims.get("iss").and_then(Value::as_str) != Some(ISSUER)
        || !audiences.contains(&client_id)
        || exp.saturating_add(5) <= now
        || claims
            .get("nbf")
            .is_some_and(|v| v.as_u64().map_or(true, |n| n > now.saturating_add(5)))
        || nonce.is_some_and(|n| claims.get("nonce").and_then(Value::as_str) != Some(n))
        || expected_subject.is_some_and(|s| s != subject)
        || azp.is_some_and(|v| v.as_str() != Some(client_id))
        || (audiences.len() > 1 && azp.and_then(Value::as_str) != Some(client_id))
    {
        return Err(invalid());
    }
    Ok((
        subject.to_owned(),
        claims
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_owned),
    ))
}

#[derive(Debug, PartialEq, Eq)]
struct Callback {
    code: Option<String>,
    client_id: Option<String>,
    error: Option<String>,
}

/// Reject unsolicited callbacks before consuming a pending sign-in.
fn validate_callback(
    method: &str,
    request_target: &str,
    host: &str,
    port: u16,
    expected_state: &str,
) -> Result<Callback, &'static str> {
    let invalid = || "Invalid ChatGPT OAuth callback";
    let origin = format!("http://127.0.0.1:{port}");
    if method != "GET"
        || host != format!("127.0.0.1:{port}")
        || !request_target.starts_with('/')
        || request_target.starts_with("//")
    {
        return Err(invalid());
    }
    let url = url::Url::parse(&format!("{origin}{request_target}")).map_err(|_| invalid())?;
    if url.origin().ascii_serialization() != origin
        || url.path() != "/auth/callback"
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let mut state = None;
    let mut code = None;
    let mut client_id = None;
    let mut error = None;
    for (key, value) in url.query_pairs() {
        let target = match key.as_ref() {
            "state" => &mut state,
            "code" => &mut code,
            "client_id" => &mut client_id,
            "error" => &mut error,
            _ => continue,
        };
        if target.replace(value.into_owned()).is_some() {
            return Err(invalid());
        }
    }
    if state.as_deref() != Some(expected_state) {
        return Err(invalid());
    }
    Ok(Callback {
        code,
        client_id,
        error,
    })
}

fn nonempty(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty() && !s.chars().any(|c| (c as u32) <= 32 || c == '\u{7f}'))
}

/// Match the existing subscription owner's version-1 file validation. Keep
/// unknown fields intact so records can round-trip across runtimes.
fn validate_state(state: &Value) -> Result<(), &'static str> {
    let invalid = || "Invalid ChatGPT credential file";
    let root = state.as_object().ok_or_else(invalid)?;
    if root.get("version").and_then(Value::as_u64) != Some(1)
        || !nonempty(root.get("hostId"))
        || !(root.get("activeId").is_some_and(Value::is_null) || nonempty(root.get("activeId")))
        || root
            .get("allowBackgroundUse")
            .is_some_and(|v| !v.is_boolean())
    {
        return Err(invalid());
    }
    let registrations = root
        .get("registrations")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let mut ids = HashSet::new();
    let mut clients = HashSet::new();
    for entry in registrations {
        let record = entry.as_object().ok_or_else(invalid)?;
        if !nonempty(record.get("id"))
            || !nonempty(record.get("clientId"))
            || !nonempty(record.get("subject"))
            || record.get("issuer").and_then(Value::as_str) != Some(ISSUER)
            || record.get("email").is_some_and(|v| !v.is_string())
            || record.get("background").is_some_and(|v| !v.is_boolean())
            || record
                .get("reconnectRequired")
                .is_some_and(|v| v.as_bool() != Some(true))
        {
            return Err(invalid());
        }
        let id = record["id"].as_str().ok_or_else(invalid)?;
        let client = record["clientId"].as_str().ok_or_else(invalid)?;
        if client == "dynamic_agent_client" || !ids.insert(id) || !clients.insert(client) {
            return Err(invalid());
        }
        if let Some(tokens) = record.get("tokens") {
            let tokens = tokens.as_object().ok_or_else(invalid)?;
            let scopes = tokens
                .get("scopes")
                .and_then(Value::as_array)
                .ok_or_else(invalid)?;
            if !nonempty(tokens.get("idToken"))
                || scopes.iter().any(|v| !nonempty(Some(v)))
                || !tokens
                    .get("expiresAt")
                    .and_then(Value::as_f64)
                    .is_some_and(|v| v.is_finite() && v >= 0.0)
                || tokens.get("accessToken").is_some_and(|v| {
                    !nonempty(Some(v)) || v.as_str().is_some_and(|s| s.starts_with("sk-"))
                })
                || tokens
                    .get("refreshToken")
                    .is_some_and(|v| !nonempty(Some(v)))
            {
                return Err(invalid());
            }
        }
    }
    if let Some(id) = root["activeId"].as_str() {
        if !ids.contains(id) {
            return Err(invalid());
        }
    }
    Ok(())
}

fn read_credentials(directory: &Path) -> Result<Option<Value>, String> {
    let bytes = match fs::read(directory.join(CREDENTIAL_FILE)) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("ChatGPT credentials could not be read".into()),
    };
    let state: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid ChatGPT credential file")?;
    validate_state(&state)?;
    Ok(Some(state))
}

fn write_credentials(directory: &Path, state: &Value) -> Result<(), String> {
    validate_state(state)?;
    fs::create_dir_all(directory)
        .map_err(|_| "ChatGPT credential directory could not be created")?;
    let path = directory.join(format!(
        ".chatgpt-credentials.json.{}.{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| "ChatGPT credentials could not be saved")?;
    let result = (|| -> Result<(), String> {
        serde_json::to_writer(&mut file, state)
            .map_err(|_| "ChatGPT credentials could not be saved")?;
        file.write_all(b"\n")
            .and_then(|_| file.sync_all())
            .map_err(|_| "ChatGPT credentials could not be saved")?;
        drop(file);
        fs::rename(&path, directory.join(CREDENTIAL_FILE))
            .map_err(|_| "ChatGPT credentials could not be saved")?;
        #[cfg(unix)]
        fs::File::open(directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| "ChatGPT credential directory could not be synced")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

/// Native OAuth HTTP never follows redirects and never accepts endpoints from
/// the webview. The owner serializes state changes through this mutex.
pub struct ChatGptOwner {
    directory: PathBuf,
    client: reqwest::Client,
    stream_client: reqwest::Client,
    inner: tokio::sync::Mutex<OwnerState>,
    streams: std::sync::Mutex<StreamRegistry>,
}

#[derive(Default)]
struct StreamRegistry {
    requests: HashMap<String, (tokio::task::AbortHandle, bool)>,
    controls: usize,
}

struct ControlGuard<'a>(&'a std::sync::Mutex<StreamRegistry>);
impl Drop for ControlGuard<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap().controls -= 1;
    }
}

struct OwnerState {
    credentials: Option<Value>,
    pending: bool,
    login_task: Option<tokio::task::AbortHandle>,
    epoch: u64,
    authority_revision: u64,
    revision: u64,
    error: Option<String>,
    catalog_error: Option<String>,
    catalog: Vec<Value>,
    storage_denied: bool,
    prepared: HashMap<String, PreparedStream>,
}

struct PreparedStream {
    token: String,
    body: Vec<u8>,
    background: bool,
    epoch: u64,
    authority_revision: u64,
    expires: std::time::Instant,
}

impl ChatGptOwner {
    fn abort_streams(&self, app: &tauri::AppHandle, background_only: bool, reason: &str) {
        let mut registry = self.streams.lock().unwrap();
        let ids: Vec<String> = registry
            .requests
            .iter()
            .filter(|(_, (_, background))| !background_only || *background)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some((handle, _)) = registry.requests.remove(&id) {
                handle.abort();
                let _ = app.emit(
                    "lh://chatgpt-stream",
                    serde_json::json!({"id":id,"type":"error","error":reason}),
                );
            }
        }
    }

    fn begin_control<'a>(
        &'a self,
        app: &tauri::AppHandle,
        background_only: bool,
    ) -> ControlGuard<'a> {
        {
            let mut registry = self.streams.lock().unwrap();
            registry.controls += 1;
        }
        self.abort_streams(app, background_only, "ChatGPT request cancelled");
        ControlGuard(&self.streams)
    }
    fn save_locked(
        &self,
        app: &tauri::AppHandle,
        inner: &mut OwnerState,
        state: &Value,
    ) -> Result<(), String> {
        if let Err(error) = write_credentials(&self.directory, state) {
            inner.storage_denied = true;
            inner.pending = false;
            inner.error = Some(
                "ChatGPT credentials could not be read or saved. Reconnect before making requests."
                    .into(),
            );
            inner.epoch += 1;
            inner.authority_revision += 1;
            inner.catalog.clear();
            self.abort_streams(app, false, "ChatGPT credential storage failed");
            inner.revision += 1;
            Self::emit(app, inner, "all");
            return Err(error);
        }
        Ok(())
    }
    pub fn new(directory: PathBuf) -> Result<Arc<Self>, String> {
        let (credentials, storage_error) = match read_credentials(&directory) {
            Ok(value) => (value, None),
            Err(error) => (None, Some(error)),
        };
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|_| "ChatGPT network client could not be initialized")?;
        let stream_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|_| "ChatGPT network client could not be initialized")?;
        Ok(Arc::new(Self {
            directory,
            client,
            stream_client,
            streams: std::sync::Mutex::new(StreamRegistry::default()),
            inner: tokio::sync::Mutex::new(OwnerState {
                credentials,
                pending: false,
                login_task: None,
                epoch: 0,
                authority_revision: 0,
                revision: 0,
                error: storage_error.clone(),
                catalog_error: None,
                catalog: Vec::new(),
                storage_denied: storage_error.is_some(),
                prepared: HashMap::new(),
            }),
        }))
    }

    async fn json_request(
        &self,
        method: reqwest::Method,
        endpoint: &str,
        fields: Option<&[(String, String)]>,
        bearer: Option<&str>,
    ) -> Result<Value, String> {
        // Do not accept arbitrary URLs, including from provider discovery.
        if !matches!(
            endpoint,
            "https://auth.openai.com/api/accounts/oauth/token"
                | "https://auth.openai.com/.well-known/jwks.json"
                | "https://auth.openai.com/.well-known/openid-configuration"
                | "https://api.openai.com/v1/models"
        ) {
            return Err("Unsupported ChatGPT endpoint".into());
        }
        let mut request = self
            .client
            .request(method, endpoint)
            .header("accept", "application/json");
        if let Some(fields) = fields {
            let body: String = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(fields.iter().map(|(k, v)| (k.as_str(), v.as_str())))
                .finish();
            request = request
                .header("content-type", "application/x-www-form-urlencoded")
                .body(body);
        }
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .await
            .map_err(|_| "ChatGPT could not be reached")?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "ChatGPT response could not be read")?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("ChatGPT response was too large".into());
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "ChatGPT response was invalid")?;
        if !status.is_success() {
            return Err(
                if value.get("error").and_then(Value::as_str) == Some("invalid_grant") {
                    "invalid_grant"
                } else {
                    "ChatGPT rejected the request"
                }
                .into(),
            );
        }
        Ok(value)
    }

    async fn revoke(&self, account: &Value) -> bool {
        let Some(token) = account
            .pointer("/tokens/refreshToken")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return false;
        };
        let Some(client) = account.get("clientId").and_then(Value::as_str) else {
            return false;
        };
        let Ok(discovery) = self
            .json_request(
                reqwest::Method::GET,
                "https://auth.openai.com/.well-known/openid-configuration",
                None,
                None,
            )
            .await
        else {
            return false;
        };
        if discovery.get("issuer").and_then(Value::as_str) != Some(ISSUER) {
            return false;
        }
        let Some(endpoint) = discovery
            .get("revocation_endpoint")
            .and_then(Value::as_str)
            .and_then(|s| url::Url::parse(s).ok())
        else {
            return false;
        };
        if endpoint.origin().ascii_serialization() != ISSUER
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return false;
        }
        let body: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("token", token)
            .append_pair("token_type_hint", "refresh_token")
            .append_pair("client_id", client)
            .finish();
        for attempt in 0..2 {
            if attempt != 0 {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let response = self
                .client
                .post(endpoint.clone())
                .timeout(std::time::Duration::from_secs(5))
                .header("content-type", "application/x-www-form-urlencoded")
                .body(body.clone())
                .send()
                .await;
            match response {
                Ok(response) if response.status().as_u16() == 200 => return true,
                Ok(response) if response.status().as_u16() < 500 => return false,
                _ => {}
            }
        }
        false
    }

    fn status_locked(inner: &OwnerState) -> Value {
        let empty = Vec::new();
        let credentials = inner.credentials.as_ref();
        let registrations = credentials
            .and_then(|s| s.get("registrations"))
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let active_id = credentials
            .and_then(|s| s.get("activeId"))
            .cloned()
            .unwrap_or(Value::Null);
        let mut grouped: Vec<&Value> = Vec::new();
        for record in registrations {
            let existing = grouped.iter().position(|other| {
                other.get("issuer") == record.get("issuer")
                    && other.get("subject") == record.get("subject")
            });
            if let Some(index) = existing {
                let currently_active = grouped[index].get("id") == Some(&active_id);
                let usable = |r: &Value| {
                    r.get("reconnectRequired") != Some(&Value::Bool(true))
                        && nonempty(r.pointer("/tokens/accessToken"))
                        && r.pointer("/tokens/scopes")
                            .and_then(Value::as_array)
                            .is_some_and(|s| {
                                SCOPES
                                    .iter()
                                    .all(|required| s.iter().any(|v| v.as_str() == Some(required)))
                            })
                };
                if record.get("id") == Some(&active_id)
                    || (!currently_active && !usable(grouped[index]) && usable(record))
                {
                    grouped[index] = record;
                }
            } else {
                grouped.push(record);
            }
        }
        let accounts: Vec<Value> = grouped.iter().map(|record| {
            let scopes = record.pointer("/tokens/scopes").and_then(Value::as_array);
            let valid = record.get("reconnectRequired") != Some(&Value::Bool(true))
                && nonempty(record.pointer("/tokens/accessToken"))
                && scopes.is_some_and(|s| SCOPES.iter().all(|required| s.iter().any(|v| v.as_str() == Some(required))));
            serde_json::json!({"id":record["id"],"email":record.get("email").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("ChatGPT account"),
                "registration":record["clientId"],"connected":valid,"planEnabled":valid,"canSignInAgain":!valid})
        }).collect();
        serde_json::json!({"available":!inner.storage_denied,"pending":inner.pending,"allowBackgroundUse":credentials.and_then(|s| s.get("allowBackgroundUse")).and_then(Value::as_bool).unwrap_or(true),
            "activeId":active_id,"accounts":accounts,"error":inner.error,"catalogError":inner.catalog_error})
    }

    pub async fn status(&self) -> Value {
        let inner = self.inner.lock().await;
        Self::status_locked(&inner)
    }

    pub async fn snapshot(&self) -> Value {
        let inner = self.inner.lock().await;
        serde_json::json!({"status":Self::status_locked(&inner),"epoch":inner.epoch,"authorityRevision":inner.authority_revision,"revision":inner.revision})
    }

    async fn access_token_locked(
        &self,
        app: &tauri::AppHandle,
        inner: &mut OwnerState,
        background: bool,
    ) -> Result<(String, String), String> {
        if inner.storage_denied {
            return Err("ChatGPT credentials could not be saved".into());
        }
        let mut state = inner
            .credentials
            .clone()
            .ok_or("ChatGPT account is unavailable")?;
        if background && state.get("allowBackgroundUse").and_then(Value::as_bool) == Some(false) {
            return Err("ChatGPT background use is off".into());
        }
        let active = state["activeId"]
            .as_str()
            .ok_or("ChatGPT account is disconnected")?
            .to_owned();
        let record = state["registrations"]
            .as_array()
            .and_then(|v| v.iter().find(|r| r["id"].as_str() == Some(&active)))
            .ok_or("ChatGPT account is disconnected")?
            .clone();
        if record.get("reconnectRequired") == Some(&Value::Bool(true)) {
            return Err("ChatGPT sign-in must be repeated".into());
        }
        let tokens = record
            .get("tokens")
            .ok_or("ChatGPT account is disconnected")?;
        if !tokens
            .get("scopes")
            .and_then(Value::as_array)
            .is_some_and(|s| {
                SCOPES
                    .iter()
                    .all(|scope| s.iter().any(|v| v.as_str() == Some(scope)))
            })
        {
            return Err("ChatGPT plan permission is missing".into());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "System clock is invalid")?
            .as_secs();
        if tokens["expiresAt"].as_u64().unwrap_or(0) <= now.saturating_add(60).saturating_mul(1000)
        {
            let client = record["clientId"]
                .as_str()
                .ok_or("ChatGPT client is invalid")?;
            let refresh = tokens["refreshToken"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("ChatGPT session expired")?;
            let fields = vec![
                ("grant_type".into(), "refresh_token".into()),
                ("client_id".into(), client.into()),
                ("refresh_token".into(), refresh.into()),
                ("resource".into(), RESOURCE.into()),
            ];
            let body = match self
                .json_request(
                    reqwest::Method::POST,
                    "https://auth.openai.com/api/accounts/oauth/token",
                    Some(&fields),
                    None,
                )
                .await
            {
                Ok(body) => body,
                Err(e) if e == "invalid_grant" => {
                    if let Some(r) = state["registrations"]
                        .as_array_mut()
                        .and_then(|v| v.iter_mut().find(|r| r["id"].as_str() == Some(&active)))
                    {
                        r.as_object_mut()
                            .ok_or("Invalid ChatGPT account")?
                            .remove("tokens");
                    }
                    state["activeId"] = Value::Null;
                    self.save_locked(app, inner, &state)?;
                    inner.credentials = Some(state);
                    inner.epoch += 1;
                    inner.authority_revision += 1;
                    inner.catalog.clear();
                    inner.prepared.clear();
                    return Err("ChatGPT session expired".into());
                }
                Err(e) => return Err(e),
            };
            let verified = async {
                if let Some(id) = body.get("id_token") {
                    let id = id
                        .as_str()
                        .ok_or("ChatGPT identity could not be verified")?;
                    let keys = self
                        .json_request(
                            reqwest::Method::GET,
                            "https://auth.openai.com/.well-known/jwks.json",
                            None,
                            None,
                        )
                        .await?;
                    verify_identity(id, &keys, client, None, record["subject"].as_str(), now)
                        .map_err(str::to_owned)?;
                }
                token_set(&body, Some(tokens), now.saturating_mul(1000)).map_err(str::to_owned)
            }
            .await;
            let new_tokens = match verified {
                Ok(tokens) => tokens,
                Err(error) => {
                    if let Some(r) = state["registrations"]
                        .as_array_mut()
                        .and_then(|v| v.iter_mut().find(|r| r["id"].as_str() == Some(&active)))
                    {
                        r["reconnectRequired"] = Value::Bool(true);
                        if let Some(refresh) =
                            body.get("refresh_token").filter(|v| nonempty(Some(v)))
                        {
                            r["tokens"]["refreshToken"] = refresh.clone();
                        }
                    }
                    self.save_locked(app, inner, &state)?;
                    inner.credentials = Some(state);
                    inner.epoch += 1;
                    inner.authority_revision += 1;
                    inner.catalog.clear();
                    return Err(error);
                }
            };
            if let Some(r) = state["registrations"]
                .as_array_mut()
                .and_then(|v| v.iter_mut().find(|r| r["id"].as_str() == Some(&active)))
            {
                r["tokens"] = new_tokens;
            }
            self.save_locked(app, inner, &state)?;
            inner.credentials = Some(state.clone());
        }
        let current = state["registrations"]
            .as_array()
            .and_then(|v| v.iter().find(|r| r["id"].as_str() == Some(&active)))
            .and_then(|r| r.pointer("/tokens/accessToken"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && !s.starts_with("sk-"))
            .ok_or("ChatGPT plan permission is missing")?;
        Ok((active, current.to_owned()))
    }

    async fn checked_access_token(
        &self,
        app: &tauri::AppHandle,
        inner: &mut OwnerState,
        background: bool,
    ) -> Result<(String, String), String> {
        let before = inner.epoch;
        let result = self.access_token_locked(app, inner, background).await;
        if inner.epoch != before {
            inner.error = result.as_ref().err().cloned();
            inner.revision += 1;
            self.abort_streams(app, false, "ChatGPT connection changed");
            Self::emit(app, inner, "all");
        }
        result
    }

    pub async fn models(&self, app: &tauri::AppHandle) -> Result<Value, String> {
        let mut inner = self.inner.lock().await;
        let (account, token) = self.checked_access_token(app, &mut inner, false).await?;
        let body = self
            .json_request(
                reqwest::Method::GET,
                "https://api.openai.com/v1/models",
                None,
                Some(&token),
            )
            .await;
        let body = match body {
            Ok(body) if body.get("models").is_some_and(Value::is_array) => body,
            _ => {
                if !inner.catalog.is_empty() {
                    inner.catalog.clear();
                    inner.authority_revision += 1;
                }
                inner.catalog_error = Some("The ChatGPT account model catalog is unavailable. Retry the connection; no API-key fallback was used.".into());
                inner.revision += 1;
                Self::emit(app, &inner, "all");
                return Err("ChatGPT model catalog is unavailable".into());
            }
        };
        let models: Vec<Value> = body.get("models").and_then(Value::as_array).ok_or("ChatGPT model catalog is unavailable")?.iter().filter_map(|m| {
            if m.get("visibility").and_then(Value::as_str) != Some("list") || !nonempty(m.get("slug")) { return None; }
            Some(serde_json::json!({"id":m.get("slug")?,"name":m.get("display_name")?.as_str()?}))
        }).collect();
        if inner.catalog != models || inner.catalog_error.is_some() {
            let changed = inner.catalog != models;
            inner.catalog = models;
            if changed {
                inner.authority_revision += 1;
            }
            inner.catalog_error = None;
            inner.revision += 1;
            Self::emit(app, &inner, "none");
        }
        Ok(
            serde_json::json!({"epoch":inner.epoch,"authorityRevision":inner.authority_revision,"revision":inner.revision,"status":Self::status_locked(&inner),"accountId":account,"models":inner.catalog}),
        )
    }

    pub async fn stream_prepare(
        self: &Arc<Self>,
        app: tauri::AppHandle,
        id: String,
        scope: Value,
        background: bool,
        payload: Value,
    ) -> Result<(), String> {
        if id.is_empty()
            || id.len() > 128
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("Invalid ChatGPT stream ID".into());
        }
        let model = scope
            .get("selectedModelId")
            .and_then(Value::as_str)
            .ok_or("ChatGPT model is unavailable")?;
        let object = payload.as_object().ok_or("Invalid ChatGPT request")?;
        const ALLOWED: &[&str] = &[
            "model",
            "store",
            "stream",
            "input",
            "tools",
            "instructions",
            "reasoning",
            "include",
            "text",
            "tool_choice",
            "parallel_tool_calls",
            "prompt_cache_key",
        ];
        if object.keys().any(|key| !ALLOWED.contains(&key.as_str()))
            || payload.get("model").and_then(Value::as_str) != Some(model)
            || payload.get("store").and_then(Value::as_bool) != Some(false)
            || payload.get("stream").and_then(Value::as_bool) != Some(true)
            || !payload.get("input").is_some_and(Value::is_array)
        {
            return Err("Invalid ChatGPT request".into());
        }
        let body = serde_json::to_vec(&payload).map_err(|_| "Invalid ChatGPT request")?;
        if body.len() > 16 * 1024 * 1024 {
            return Err("ChatGPT request is too large".into());
        }
        let mut inner = self.inner.lock().await;
        inner
            .prepared
            .retain(|_, request| request.expires > std::time::Instant::now());
        if inner.prepared.len() >= 32 {
            return Err("Too many ChatGPT requests".into());
        }
        let unavailable = {
            let registry = self.streams.lock().unwrap();
            registry.controls != 0 || registry.requests.contains_key(&id)
        };
        if unavailable
            || inner.prepared.contains_key(&id)
            || scope.get("epoch").and_then(Value::as_u64) != Some(inner.epoch)
            || scope.get("authorityRevision").and_then(Value::as_u64)
                != Some(inner.authority_revision)
            || !inner
                .catalog
                .iter()
                .any(|m| m["id"].as_str() == Some(model))
        {
            return Err("ChatGPT model authority changed".into());
        }
        let (account, token) = self
            .checked_access_token(&app, &mut inner, background)
            .await?;
        if scope.get("accountId").and_then(Value::as_str) != Some(&account)
            || scope.get("epoch").and_then(Value::as_u64) != Some(inner.epoch)
            || scope.get("authorityRevision").and_then(Value::as_u64)
                != Some(inner.authority_revision)
        {
            return Err("ChatGPT model authority changed".into());
        }
        if self.streams.lock().unwrap().controls != 0 {
            return Err("ChatGPT connection is changing".into());
        }
        let epoch = inner.epoch;
        let authority_revision = inner.authority_revision;
        inner.prepared.insert(
            id.clone(),
            PreparedStream {
                token,
                body,
                background,
                epoch,
                authority_revision,
                expires: std::time::Instant::now() + std::time::Duration::from_secs(30),
            },
        );
        let owner = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            if let Some(owner) = owner.upgrade() {
                let mut inner = owner.inner.lock().await;
                if inner
                    .prepared
                    .get(&id)
                    .is_some_and(|request| request.expires <= std::time::Instant::now())
                {
                    inner.prepared.remove(&id);
                }
            }
        });
        Ok(())
    }

    pub async fn stream_start(
        self: &Arc<Self>,
        app: tauri::AppHandle,
        id: String,
    ) -> Result<(), String> {
        use base64::engine::general_purpose::STANDARD;
        let mut inner = self.inner.lock().await;
        let prepared = inner
            .prepared
            .remove(&id)
            .ok_or("ChatGPT request is no longer available")?;
        if inner.storage_denied
            || prepared.expires <= std::time::Instant::now()
            || prepared.epoch != inner.epoch
            || prepared.authority_revision != inner.authority_revision
            || (prepared.background
                && inner
                    .credentials
                    .as_ref()
                    .and_then(|s| s.get("allowBackgroundUse"))
                    .and_then(Value::as_bool)
                    == Some(false))
        {
            return Err("ChatGPT model authority changed".into());
        }
        let PreparedStream {
            token,
            body,
            background,
            ..
        } = prepared;
        let owner = Arc::clone(self);
        let task_id = id.clone();
        let task_app = app.clone();
        let (start, ready) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            if ready.await.is_err() {
                return;
            }
            let result: Result<(), String> = async {
                let mut response = owner.stream_client.post("https://api.openai.com/v1/responses")
                    .bearer_auth(token).header("content-type", "application/json").body(body).send().await.map_err(|_| "ChatGPT request failed")?;
                let status = response.status().as_u16();
                let _ = task_app.emit("lh://chatgpt-stream", serde_json::json!({"id":task_id,"type":"response","status":status}));
                while let Some(chunk) = response.chunk().await.map_err(|_| "ChatGPT stream failed")? {
                    let _ = task_app.emit("lh://chatgpt-stream", serde_json::json!({"id":task_id,"type":"chunk","data":STANDARD.encode(chunk)}));
                }
                Ok(())
            }.await;
            let _ = task_app.emit("lh://chatgpt-stream", serde_json::json!({"id":task_id,"type":if result.is_ok(){"end"}else{"error"},"error":result.err()}));
            owner.streams.lock().unwrap().requests.remove(&task_id);
        });
        let mut registry = self.streams.lock().unwrap();
        if registry.controls != 0 {
            task.abort();
            return Err("ChatGPT connection is changing".into());
        }
        registry
            .requests
            .insert(id, (task.abort_handle(), background));
        drop(registry);
        let _ = start.send(());
        Ok(())
    }

    pub async fn stream_cancel(&self, app: &tauri::AppHandle, id: &str) {
        let request = self.streams.lock().unwrap().requests.remove(id);
        if let Some((handle, _)) = request {
            handle.abort();
            let _ = app.emit(
                "lh://chatgpt-stream",
                serde_json::json!({"id":id,"type":"error","error":"ChatGPT request cancelled"}),
            );
        }
        self.inner.lock().await.prepared.remove(id);
    }

    pub async fn control(
        &self,
        app: &tauri::AppHandle,
        op: &str,
        id: Option<&str>,
        enabled: Option<bool>,
    ) -> Result<Value, String> {
        let _control = if matches!(op, "select" | "disconnect" | "logout")
            || (op == "consent" && enabled == Some(false))
        {
            Some(self.begin_control(app, op == "consent"))
        } else {
            None
        };
        let mut inner = self.inner.lock().await;
        if inner.storage_denied && op != "status" {
            return Err("ChatGPT credentials could not be saved".into());
        }
        if matches!(op, "cancel" | "select" | "disconnect" | "logout") {
            if let Some(task) = inner.login_task.take() {
                task.abort();
            }
        }
        match op {
            "status" => return Ok(Self::status_locked(&inner)),
            "cancel" => {
                if inner.pending {
                    inner.pending = false;
                    inner.epoch += 1;
                    inner.error = Some("ChatGPT sign-in cancelled.".into());
                }
            }
            "consent" => {
                let enabled = enabled.ok_or("Invalid consent")?;
                let mut state = inner
                    .credentials
                    .clone()
                    .ok_or("ChatGPT account is unavailable")?;
                state["allowBackgroundUse"] = Value::Bool(enabled);
                self.save_locked(app, &mut inner, &state)?;
                inner.credentials = Some(state);
            }
            "select" => {
                let id = id.ok_or("ChatGPT account is unavailable")?;
                let mut state = inner
                    .credentials
                    .clone()
                    .ok_or("ChatGPT account is unavailable")?;
                let record = state["registrations"]
                    .as_array()
                    .and_then(|r| r.iter().find(|r| r["id"].as_str() == Some(id)))
                    .ok_or("ChatGPT account is unavailable")?;
                if record.get("tokens").is_none() {
                    return Err("ChatGPT account is disconnected".into());
                }
                state["activeId"] = Value::String(id.into());
                self.save_locked(app, &mut inner, &state)?;
                inner.credentials = Some(state);
                inner.pending = false;
                inner.epoch += 1;
                inner.authority_revision += 1;
                inner.catalog.clear();
                inner.catalog_error = None;
                inner.error = None;
            }
            "disconnect" | "logout" => {
                let id = id.ok_or("ChatGPT account is unavailable")?;
                let mut state = inner
                    .credentials
                    .clone()
                    .ok_or("ChatGPT account is unavailable")?;
                let active_id = state["activeId"].as_str().map(str::to_owned);
                let records = state["registrations"]
                    .as_array_mut()
                    .ok_or("ChatGPT account is unavailable")?;
                let record = records
                    .iter()
                    .find(|r| r["id"].as_str() == Some(id))
                    .ok_or("ChatGPT account is unavailable")?
                    .clone();
                let members: Vec<Value> = if op == "disconnect" {
                    records
                        .iter()
                        .filter(|r| {
                            r["issuer"] == record["issuer"] && r["subject"] == record["subject"]
                        })
                        .cloned()
                        .collect()
                } else {
                    vec![record.clone()]
                };
                // Stop all admitted work before waiting on remote revocation.
                if op == "logout"
                    || members
                        .iter()
                        .any(|r| r["id"].as_str() == active_id.as_deref())
                {
                    self.abort_streams(app, false, "ChatGPT request cancelled");
                }
                let mut revoked = true;
                for member in &members {
                    revoked &= self.revoke(member).await;
                }
                if op == "disconnect" {
                    records.retain(|r| {
                        r["issuer"] != record["issuer"] || r["subject"] != record["subject"]
                    });
                } else if let Some(record) =
                    records.iter_mut().find(|r| r["id"].as_str() == Some(id))
                {
                    record
                        .as_object_mut()
                        .ok_or("Invalid ChatGPT account")?
                        .remove("tokens");
                }
                if state["activeId"].as_str() == Some(id)
                    || (op == "disconnect"
                        && !state["registrations"]
                            .as_array()
                            .is_some_and(|r| r.iter().any(|r| r["id"] == state["activeId"])))
                {
                    state["activeId"] = Value::Null;
                }
                self.save_locked(app, &mut inner, &state)?;
                inner.credentials = Some(state);
                inner.pending = false;
                inner.epoch += 1;
                inner.authority_revision += 1;
                inner.catalog.clear();
                inner.catalog_error = None;
                inner.error = if revoked {
                    None
                } else {
                    Some(
                        "Account disconnected locally. Remote revocation could not be confirmed."
                            .into(),
                    )
                };
            }
            _ => return Err("Unsupported ChatGPT control".into()),
        }
        if matches!(op, "select" | "disconnect" | "logout")
            || (op == "consent" && enabled == Some(false))
        {
            if op == "consent" {
                inner.prepared.retain(|_, request| !request.background);
            } else {
                inner.prepared.clear();
            }
        }
        inner.revision += 1;
        Self::emit(
            app,
            &inner,
            if op == "consent" && enabled == Some(false) {
                "background"
            } else if matches!(op, "select" | "disconnect" | "logout") {
                "all"
            } else {
                "none"
            },
        );
        Ok(Self::status_locked(&inner))
    }

    fn emit(app: &tauri::AppHandle, inner: &OwnerState, invalidate: &str) {
        let packet = serde_json::json!({"channel":"lh:chatgpt", "kind":"state", "stamp":{"epoch":inner.epoch,"authorityRevision":inner.authority_revision,"revision":inner.revision},"status":Self::status_locked(inner),"invalidate":invalidate});
        let _ = app.emit("lh://chatgpt-state", packet);
    }

    pub async fn login(
        self: &Arc<Self>,
        app: tauri::AppHandle,
        account_id: Option<String>,
    ) -> Result<Value, String> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "ChatGPT callback listener could not start")?;
        let port = listener
            .local_addr()
            .map_err(|_| "ChatGPT callback listener could not start")?
            .port();
        let mut inner = self.inner.lock().await;
        if inner.storage_denied {
            return Err("ChatGPT credentials could not be saved".into());
        }
        if inner.pending {
            return Err("A ChatGPT sign-in is already pending".into());
        }
        if inner.credentials.is_none() {
            let state = serde_json::json!({"version":1,"hostId":format!("urn:uuid:{}", random_uuid()?),"activeId":null,"registrations":[]});
            self.save_locked(&app, &mut inner, &state)?;
            inner.credentials = Some(state);
        }
        let state = inner
            .credentials
            .as_ref()
            .ok_or("ChatGPT credentials unavailable")?;
        let selected = match account_id.as_ref() {
            Some(id) => Some(
                state["registrations"]
                    .as_array()
                    .and_then(|entries| entries.iter().find(|r| r["id"].as_str() == Some(id)))
                    .ok_or("ChatGPT account is unavailable")?
                    .clone(),
            ),
            None => None,
        };
        let attempt = make_login_attempt(
            port,
            state["hostId"]
                .as_str()
                .ok_or("ChatGPT credentials unavailable")?,
            selected.as_ref(),
        )?;
        inner.pending = true;
        inner.epoch += 1;
        inner.revision += 1;
        inner.error = None;
        let generation = inner.epoch;
        let status = Self::status_locked(&inner);
        Self::emit(&app, &inner, "none");
        drop(inner);
        if open::that_detached(attempt.authorization_url.as_str()).is_err() {
            let mut inner = self.inner.lock().await;
            if inner.epoch == generation {
                inner.pending = false;
                inner.error = Some("The browser could not be opened.".into());
                inner.revision += 1;
                Self::emit(&app, &inner, "none");
            }
            return Err("The browser could not be opened".into());
        }
        let owner = Arc::clone(self);
        let (start, ready) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            if ready.await.is_err() {
                return;
            }
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(180),
                owner.finish_login(
                    &app,
                    listener,
                    port,
                    &attempt,
                    selected.as_ref(),
                    generation,
                ),
            )
            .await;
            let mut inner = owner.inner.lock().await;
            if inner.epoch != generation {
                return;
            }
            inner.login_task = None;
            inner.pending = false;
            if let Err(error) = result.unwrap_or_else(|_| Err("ChatGPT sign-in timed out".into())) {
                inner.error = Some(error);
            }
            inner.revision += 1;
            Self::emit(&app, &inner, "all");
        });
        let mut inner = self.inner.lock().await;
        if inner.epoch != generation || !inner.pending {
            task.abort();
            return Err("ChatGPT sign-in cancelled".into());
        }
        inner.login_task = Some(task.abort_handle());
        let _ = start.send(());
        Ok(status)
    }

    async fn receive_callback(
        &self,
        listener: tokio::net::TcpListener,
        port: u16,
        expected_state: &str,
        generation: u64,
    ) -> Result<Callback, String> {
        loop {
            let (mut stream, _) = listener
                .accept()
                .await
                .map_err(|_| "ChatGPT callback listener failed")?;
            let read_headers = async {
                let mut data = Vec::new();
                let mut chunk = [0u8; 2048];
                while data.len() < 16_384 {
                    let n = stream.read(&mut chunk).await?;
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&chunk[..n]);
                    if data.windows(4).any(|w| w == b"\r\n\r\n") {
                        return Ok::<_, std::io::Error>(data);
                    }
                }
                Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Invalid callback request",
                ))
            };
            let data =
                match tokio::time::timeout(std::time::Duration::from_secs(5), read_headers).await {
                    Ok(Ok(bytes)) => bytes,
                    _ => continue,
                };
            let text = String::from_utf8_lossy(&data);
            let mut lines = text.split("\r\n");
            let first = lines.next().unwrap_or("");
            let mut parts = first.split_whitespace();
            let method = parts.next().unwrap_or("");
            let target = parts.next().unwrap_or("");
            let hosts: Vec<&str> = lines
                .filter_map(|line| line.split_once(':'))
                .filter_map(|(k, v)| k.eq_ignore_ascii_case("host").then_some(v.trim()))
                .collect();
            let parsed = if hosts.len() == 1 {
                validate_callback(method, target, hosts[0], port, expected_state).ok()
            } else {
                None
            };
            let (status, message) = if parsed.is_some() {
                (
                    "200 OK",
                    "Return to LearnHarness to view the sign-in result. You may close this tab.",
                )
            } else {
                ("400 Bad Request", "Sign-in could not be verified.")
            };
            let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{message}", message.len());
            let _ = stream.write_all(response.as_bytes()).await;
            if let Some(parsed) = parsed {
                return Ok(parsed);
            }
            if self.inner.lock().await.epoch != generation {
                return Err("ChatGPT sign-in cancelled".into());
            }
        }
    }

    async fn finish_login(
        &self,
        app: &tauri::AppHandle,
        listener: tokio::net::TcpListener,
        port: u16,
        attempt: &LoginAttempt,
        selected: Option<&Value>,
        generation: u64,
    ) -> Result<(), String> {
        let callback = self
            .receive_callback(listener, port, &attempt.state, generation)
            .await?;
        if callback.error.is_some() {
            return Err("ChatGPT sign-in was cancelled or rejected".into());
        }
        let code = callback
            .code
            .filter(|s| !s.is_empty())
            .ok_or("ChatGPT callback did not include a code")?;
        let selected_client = selected.and_then(|s| s["clientId"].as_str());
        let client = callback
            .client_id
            .as_deref()
            .or(selected_client)
            .filter(|s| {
                !s.is_empty()
                    && *s != "dynamic_agent_client"
                    && s.len() <= 512
                    && !s.chars().any(char::is_whitespace)
            })
            .ok_or("ChatGPT client could not be verified")?;
        if selected_client.is_some_and(|s| s != client) {
            return Err("ChatGPT client could not be verified".into());
        }
        let fields = vec![
            ("grant_type".into(), "authorization_code".into()),
            ("client_id".into(), client.into()),
            ("code".into(), code),
            ("code_verifier".into(), attempt.verifier.clone()),
            ("redirect_uri".into(), attempt.redirect_uri.clone()),
            ("resource".into(), RESOURCE.into()),
        ];
        let body = self
            .json_request(
                reqwest::Method::POST,
                "https://auth.openai.com/api/accounts/oauth/token",
                Some(&fields),
                None,
            )
            .await?;
        let id_token = body
            .get("id_token")
            .and_then(Value::as_str)
            .ok_or("ChatGPT identity could not be verified")?;
        let keys = self
            .json_request(
                reqwest::Method::GET,
                "https://auth.openai.com/.well-known/jwks.json",
                None,
                None,
            )
            .await?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "System clock is invalid")?
            .as_secs();
        let (subject, email) = verify_identity(
            id_token,
            &keys,
            client,
            Some(&attempt.nonce),
            selected.and_then(|s| s["subject"].as_str()),
            now,
        )?;
        let tokens = token_set(&body, None, now.saturating_mul(1000))?;
        let mut inner = self.inner.lock().await;
        if inner.epoch != generation || !inner.pending {
            return Err("ChatGPT sign-in cancelled".into());
        }
        let mut credentials = inner
            .credentials
            .clone()
            .ok_or("ChatGPT credentials unavailable")?;
        let records = credentials["registrations"]
            .as_array_mut()
            .ok_or("ChatGPT credentials unavailable")?;
        let existing = records
            .iter()
            .find(|r| r["clientId"].as_str() == Some(client));
        if existing.is_some_and(|r| r["subject"].as_str() != Some(subject.as_str())) {
            return Err("ChatGPT identity could not be verified".into());
        }
        let id = match existing.and_then(|r| r["id"].as_str()) {
            Some(id) => id.to_owned(),
            None => random_uuid()?.to_owned(),
        };
        records.retain(|r| r["id"].as_str() != Some(id.as_str()));
        let mut record = serde_json::json!({"id":id,"clientId":client,"issuer":ISSUER,"subject":subject,"tokens":tokens});
        if let Some(email) = email {
            record["email"] = Value::String(email);
        }
        records.push(record);
        credentials["activeId"] = Value::String(id);
        self.save_locked(app, &mut inner, &credentials)?;
        inner.credentials = Some(credentials);
        inner.prepared.clear();
        self.abort_streams(app, false, "ChatGPT connection changed");
        inner.catalog.clear();
        inner.catalog_error = None;
        inner.authority_revision += 1;
        inner.error = if nonempty(tokens.get("accessToken")) {
            None
        } else {
            Some(
                "ChatGPT plan permission is missing. Reconnect and authorize ChatGPT plan use."
                    .into(),
            )
        };
        Ok(())
    }
}

#[tauri::command]
pub async fn lh_chatgpt_control(
    app: tauri::AppHandle,
    owner: tauri::State<'_, Arc<ChatGptOwner>>,
    op: String,
    id: Option<String>,
    enabled: Option<bool>,
) -> Result<Value, String> {
    if op == "login" {
        owner.inner().login(app, id).await
    } else {
        owner.control(&app, &op, id.as_deref(), enabled).await
    }
}

#[tauri::command]
pub async fn lh_chatgpt_models(
    app: tauri::AppHandle,
    owner: tauri::State<'_, Arc<ChatGptOwner>>,
) -> Result<Value, String> {
    owner.models(&app).await
}

#[tauri::command]
pub async fn lh_chatgpt_snapshot(
    owner: tauri::State<'_, Arc<ChatGptOwner>>,
) -> Result<Value, String> {
    Ok(owner.snapshot().await)
}

#[tauri::command]
pub async fn lh_chatgpt_stream_prepare(
    app: tauri::AppHandle,
    owner: tauri::State<'_, Arc<ChatGptOwner>>,
    id: String,
    scope: Value,
    background: bool,
    payload: Value,
) -> Result<(), String> {
    owner
        .inner()
        .stream_prepare(app, id, scope, background, payload)
        .await
}

#[tauri::command]
pub async fn lh_chatgpt_stream_start(
    app: tauri::AppHandle,
    owner: tauri::State<'_, Arc<ChatGptOwner>>,
    id: String,
) -> Result<(), String> {
    owner.inner().stream_start(app, id).await
}

#[tauri::command]
pub async fn lh_chatgpt_stream_cancel(
    app: tauri::AppHandle,
    owner: tauri::State<'_, Arc<ChatGptOwner>>,
    id: String,
) -> Result<(), String> {
    owner.stream_cancel(&app, &id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn callback_listener_rejects_unsolicited_requests_and_accepts_valid_callback() {
        let dir = tempfile::tempdir().unwrap();
        let owner = ChatGptOwner::new(dir.path().into()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task =
            tokio::spawn(
                async move { owner.receive_callback(listener, port, "expected", 0).await },
            );
        async fn request(port: u16, path: &str) -> String {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            stream
                .write_all(
                    format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes(),
                )
                .await
                .unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await.unwrap();
            String::from_utf8(response).unwrap()
        }
        assert!(request(port, "/auth/callback?state=wrong&code=bad")
            .await
            .starts_with("HTTP/1.1 400"));
        assert!(request(
            port,
            "/auth/callback?state=expected&code=good&client_id=client"
        )
        .await
        .starts_with("HTTP/1.1 200"));
        let callback = task.await.unwrap().unwrap();
        assert_eq!(callback.code.as_deref(), Some("good"));
        assert_eq!(callback.client_id.as_deref(), Some("client"));
    }

    #[tokio::test]
    async fn native_status_never_returns_tokens_or_subjects() {
        let dir = tempfile::tempdir().unwrap();
        let state = json!({"version":1,"hostId":"urn:uuid:test","activeId":"a","registrations":[{"id":"a","clientId":"client","issuer":ISSUER,"subject":"private-subject","email":"person@example.invalid","tokens":{"idToken":"private-id","scopes":SCOPES,"expiresAt":42,"accessToken":"private-access","refreshToken":"private-refresh"}}]});
        write_credentials(dir.path(), &state).unwrap();
        let owner = ChatGptOwner::new(dir.path().into()).unwrap();
        let status = owner.status().await;
        assert_eq!(status["accounts"][0]["connected"], true);
        let rendered = status.to_string();
        for secret in [
            "private-subject",
            "private-id",
            "private-access",
            "private-refresh",
        ] {
            assert!(!rendered.contains(secret));
        }
    }

    #[test]
    fn token_response_requires_entitlement_and_preserves_revocation_handle() {
        let body = json!({"id_token":"id", "scope":SCOPES.join(" "), "access_token":"access", "refresh_token":"refresh", "token_type":"Bearer", "expires_in":3600});
        let saved = token_set(&body, None, 1_000).unwrap();
        assert_eq!(saved["expiresAt"], 3_601_000);
        let mut missing = body.clone();
        missing["scope"] = json!("openid");
        let restricted = token_set(&missing, None, 1_000).unwrap();
        assert!(restricted.get("accessToken").is_none());
        assert_eq!(restricted["refreshToken"], "refresh");
        let mut bad = body.clone();
        bad["access_token"] = json!("sk-not-a-subscription");
        assert!(token_set(&bad, None, 1_000).is_err());
        bad = body.clone();
        bad["refresh_token"] = json!("");
        assert!(token_set(&bad, Some(&saved), 1_000).is_err());
    }

    #[test]
    fn login_attempt_binds_pkce_nonce_and_loopback_callback() {
        let a = make_login_attempt(3421, "urn:uuid:host", None).unwrap();
        let b = make_login_attempt(3421, "urn:uuid:host", None).unwrap();
        assert_ne!(a.state, b.state);
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.nonce, b.nonce);
        let query: std::collections::HashMap<_, _> =
            a.authorization_url.query_pairs().into_owned().collect();
        assert_eq!(query["redirect_uri"], a.redirect_uri);
        assert_eq!(query["state"], a.state);
        assert_eq!(query["nonce"], a.nonce);
        assert_eq!(
            query["code_challenge"],
            URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, a.verifier.as_bytes()))
        );
        assert_eq!(query["resource"], RESOURCE);
        assert_eq!(query["scope"], SCOPES.join(" "));
    }

    #[test]
    fn identity_requires_a_valid_signed_token_and_bound_claims() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/chatgpt-jwt.json")).unwrap();
        let token = fixture["token"].as_str().unwrap();
        let keys = &fixture["jwks"];
        assert_eq!(
            verify_identity(token, keys, "client", Some("nonce"), Some("subject"), 2000)
                .unwrap()
                .0,
            "subject"
        );
        assert!(verify_identity(token, keys, "other", Some("nonce"), None, 2000).is_err());
        assert!(verify_identity(token, keys, "client", Some("wrong"), None, 2000).is_err());
        assert!(verify_identity(token, keys, "client", None, Some("wrong"), 2000).is_err());
        assert!(verify_identity(token, keys, "client", None, None, 4_000_000_006).is_err());
        let mut corrupt = token.as_bytes().to_vec();
        let i = corrupt.len() - 4;
        corrupt[i] = if corrupt[i] == b'A' { b'B' } else { b'A' };
        assert!(verify_identity(
            std::str::from_utf8(&corrupt).unwrap(),
            keys,
            "client",
            None,
            None,
            2000
        )
        .is_err());
        assert!(verify_identity(token, &json!({"keys": []}), "client", None, None, 2000).is_err());
        let mut restricted_keys = keys.clone();
        restricted_keys["keys"][0]["key_ops"] = json!(["encrypt"]);
        assert!(verify_identity(token, &restricted_keys, "client", None, None, 2000).is_err());
    }

    #[test]
    fn callback_rejects_wrong_origin_state_and_duplicate_parameters() {
        let validate = |target, host| validate_callback("GET", target, host, 1234, "expected");
        assert_eq!(
            validate("/auth/callback?state=expected&code=abc", "127.0.0.1:1234")
                .unwrap()
                .code
                .as_deref(),
            Some("abc")
        );
        assert!(validate("/auth/callback?state=wrong&code=abc", "127.0.0.1:1234").is_err());
        assert!(validate(
            "/auth/callback?state=expected&state=expected",
            "127.0.0.1:1234"
        )
        .is_err());
        assert!(validate(
            "/auth/callback?state=expected&code=a&code=b",
            "127.0.0.1:1234"
        )
        .is_err());
        assert!(validate("/auth/callback?state=expected", "localhost:1234").is_err());
        assert!(validate("//evil.test/auth/callback?state=expected", "127.0.0.1:1234").is_err());
        assert!(validate("/other?state=expected", "127.0.0.1:1234").is_err());
    }

    #[test]
    fn credential_store_round_trips_and_rejects_invalid_state() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_credentials(dir.path()).unwrap().is_none());
        let state = json!({"version":1,"hostId":"urn:uuid:test","activeId":"a","registrations":[{"id":"a","clientId":"client","issuer":ISSUER,"subject":"subject","tokens":{"idToken":"id","scopes":["openid"],"expiresAt":42,"accessToken":"token","refreshToken":"refresh"}}]});
        write_credentials(dir.path(), &state).unwrap();
        assert_eq!(read_credentials(dir.path()).unwrap(), Some(state.clone()));
        let mut invalid = state.clone();
        invalid["registrations"][0]["tokens"]["accessToken"] = json!("sk-secret");
        assert!(write_credentials(dir.path(), &invalid).is_err());
        assert_eq!(read_credentials(dir.path()).unwrap(), Some(state));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.path().join(CREDENTIAL_FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
