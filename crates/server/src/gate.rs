use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use mcp_terminal_core::Workspace;
use serde_json::json;
use std::{
    env,
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use subtle::ConstantTimeEq;

#[derive(Clone)]
pub struct Gate {
    key: Arc<str>,
    pub hosts: Vec<String>,
}
pub struct Settings {
    pub port: u16,
    pub gate: Gate,
    pub workspace: Workspace,
}
fn value(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_owned())
}
fn local_directory(p: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::Prefix;
        if !matches!(p.components().next(),Some(Component::Prefix(x)) if matches!(x.kind(),Prefix::Disk(_)|Prefix::VerbatimDisk(_)))
        {
            return false;
        }
    }
    p.is_absolute() && !p.components().any(|c| c == Component::ParentDir) && p.is_dir()
}
impl Settings {
    pub fn read() -> Result<Self, &'static str> {
        if value("MCP_CONTROL", "") != "stdio" {
            return Err("This development server requires a private desktop control pipe");
        }
        if value("HOST", "127.0.0.1") != "127.0.0.1" {
            return Err("This slice supports only the IPv4 loopback host");
        }
        let port = value("PORT", "")
            .parse::<u16>()
            .ok()
            .filter(|p| *p != 0)
            .ok_or("An explicit nonzero local port is required")?;
        if !value("FULL_ACCESS", "false").eq_ignore_ascii_case("false")
            || !value("TUNNEL_PROVIDER", "none").eq_ignore_ascii_case("none")
            || !value("NGROK_ENABLED", "false").eq_ignore_ascii_case("false")
            || !value("AUTH_METHODS", "bearer")
                .trim()
                .eq_ignore_ascii_case("bearer")
        {
            return Err("Unsupported access, tunnel or auth mode for the local migration slice");
        }
        let key = env::var("MCP_API_KEY").map_err(|_| "Missing test credential")?;
        if key.len() < 32 || !key.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("A printable test credential of at least 32 characters is required");
        }
        let root = value("FILES_ROOT", "");
        if !local_directory(Path::new(&root)) {
            return Err("FILES_ROOT must name an existing absolute local directory");
        }
        // Match path.resolve for this absolute, parent-free subset. Do not canonicalize:
        // Windows junction/8.3 spellings reported by the launcher belong in the reply.
        let root = Path::new(&root)
            .components()
            .collect::<PathBuf>()
            .into_os_string()
            .into_string()
            .map_err(|_| "FILES_ROOT must be representable as text")?;
        let mut hosts = vec![format!("127.0.0.1:{port}"), format!("localhost:{port}")];
        if let Ok(allow) = env::var("ALLOWED_HOSTS") {
            if !allow.trim().is_empty() {
                hosts.retain(|h| allow.split(';').any(|a| h.eq_ignore_ascii_case(a.trim())));
            }
        }
        if hosts.is_empty() {
            return Err("No permitted local Host remains");
        }
        // Protect literal values in the only user-controlled output. Do not read an env file or log these values.
        let mut other: Vec<String> = [
            "NGROK_AUTHTOKEN",
            "NGROK_TOKEN",
            "NGROK_API_KEY",
            "TUNA_API_KEY",
            "CLOUDFLARE_TUNNEL_TOKEN",
            "TUNNEL_TOKEN",
        ]
        .iter()
        .filter_map(|k| env::var(k).ok())
        .map(|s| s.trim().to_owned())
        .collect();
        if let Ok(v) = env::var("BASIC_AUTH_PASSWORD") {
            other.push(v)
        }
        let mut private: Vec<&str> = other.iter().map(String::as_str).collect();
        private.push(&key);
        let workspace = Workspace::new(&root, &value("DISABLED_TOOLS", ""), &private);
        Ok(Self {
            port,
            gate: Gate {
                key: Arc::from(key),
                hosts,
            },
            workspace,
        })
    }
}
fn reject(code: StatusCode, message: &'static str) -> Response {
    (code, Json(json!({"error":message}))).into_response()
}
pub async fn authorize(State(gate): State<Gate>, req: Request, next: Next) -> Response {
    let h = req.headers();
    let host = h
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if h.get_all(header::HOST).iter().count() != 1
        || !gate.hosts.iter().any(|a| a.eq_ignore_ascii_case(host))
    {
        return reject(
            StatusCode::MISDIRECTED_REQUEST,
            "Host header is not allowed",
        );
    }
    if let Some(origin) = h.get(header::ORIGIN) {
        if h.get_all(header::ORIGIN).iter().count() != 1
            || origin
                .to_str()
                .ok()
                .is_none_or(|v| !v.eq_ignore_ascii_case(&format!("http://{host}")))
        {
            return reject(StatusCode::FORBIDDEN, "Origin is not allowed");
        }
    }
    if req.uri().path() != "/health" {
        let bearer = h
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split_once(' '))
            .filter(|(k, _)| k.eq_ignore_ascii_case("bearer"))
            .map(|(_, v)| v.trim_start())
            .unwrap_or("");
        let alt = h
            .get("x-api-key")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let matched = gate.key.as_bytes().ct_eq(bearer.as_bytes())
            | gate.key.as_bytes().ct_eq(alt.as_bytes());
        if !bool::from(matched) {
            let mut r = reject(StatusCode::UNAUTHORIZED, "Unauthorized");
            r.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                HeaderValue::from_static("Bearer realm=\"notion-terminal-mcp\""),
            );
            return r;
        }
    }
    next.run(req).await
}
