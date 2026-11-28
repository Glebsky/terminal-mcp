#![forbid(unsafe_code)]
mod control;
mod gate;
mod handler;

use axum::{Json, Router, middleware, routing::get};
use mcp_terminal_core::SERVER_NAME;
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use serde_json::{Value, json};
use std::{future::IntoFuture, io, net::Ipv4Addr, process::ExitCode, time::Duration};
use tokio_util::sync::CancellationToken;
use tower_http::limit::RequestBodyLimitLayer;

struct Failure {
    code: &'static str,
    port: u16,
    message: &'static str,
}
async fn health() -> Json<Value> {
    Json(json!({"status":"ok","server":SERVER_NAME,"version":env!("CARGO_PKG_VERSION")}))
}
async fn run() -> Result<(), Failure> {
    let settings = gate::Settings::read().map_err(|message| Failure {
        code: "INVALID_CONFIG",
        port: 0,
        message,
    })?;
    let port = settings.port;
    let fail = |message| Failure {
        code: "START_FAILED",
        port,
        message,
    };
    let tools = handler::NativeTools::new(settings.workspace)
        .map_err(|_| fail("Cannot build the native tool catalog"))?;
    let stop = CancellationToken::new();
    let options = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_allowed_hosts(settings.gate.hosts.clone())
        .with_cancellation_token(stop.child_token());
    let svc: StreamableHttpService<handler::NativeTools, LocalSessionManager> =
        StreamableHttpService::new(move || Ok(tools.clone()), Default::default(), options);
    let app = Router::new()
        .route("/health", get(health))
        .nest_service("/mcp", svc)
        .layer(RequestBodyLimitLayer::new(64 * 1024))
        .layer(middleware::from_fn_with_state(
            settings.gate,
            gate::authorize,
        ));
    let socket = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|e| Failure {
            code: if e.kind() == io::ErrorKind::AddrInUse {
                "EADDRINUSE"
            } else {
                "LISTEN_FAILED"
            },
            port,
            message: "Cannot bind local HTTP listener",
        })?;
    control::watch_parent(stop.clone())
        .map_err(|_| fail("Cannot watch the desktop control pipe"))?;
    control::emit(json!({"type":"server:ready"}))
        .map_err(|_| fail("Desktop control output closed"))?;
    control::emit(json!({"type":"tunnel:status","provider":"none","state":"disabled"}))
        .map_err(|_| fail("Desktop control output closed"))?;
    let serve = axum::serve(socket, app)
        .with_graceful_shutdown(stop.clone().cancelled_owned())
        .into_future();
    tokio::pin!(serve);
    tokio::select! {
        result=&mut serve => result.map_err(|_|fail("HTTP listener stopped unexpectedly")),
        _=stop.cancelled() => match tokio::time::timeout(Duration::from_secs(3),&mut serve).await {
            Ok(result)=>result.map_err(|_|fail("HTTP listener failed during shutdown")),
            Err(_)=>Ok(()), // Drop the listener and remaining connections on process exit, like the TS grace bound.
        }
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            if std::env::var("MCP_CONTROL").as_deref() == Ok("stdio") {
                let _ = control::emit(
                    json!({"type":"server:error","code":e.code,"port":e.port,"message":e.message}),
                );
            }
            eprintln!("{}: {}", e.code, e.message);
            ExitCode::FAILURE
        }
    }
}
