use mcp_terminal_core::{GET_CWD, SERVER_NAME, Workspace};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig,
        Tool,
    },
    service::RequestContext,
};
use serde_json::{Value, json};
use std::{borrow::Cow, io, sync::Arc};

#[derive(Clone)]
pub struct NativeTools {
    workspace: Arc<Workspace>,
    descriptor: Tool,
}

impl NativeTools {
    pub fn new(workspace: Workspace) -> io::Result<Self> {
        // The reference is embedded, not read from a mutable file at runtime. Never register all
        // descriptors here: a name is advertised only when a corresponding Rust handler exists.
        let catalog: Vec<Value> =
            serde_json::from_str(include_str!("../../../contracts/tools.json"))?;
        let mut matching = catalog
            .into_iter()
            .filter(|v| v.get("name").and_then(Value::as_str) == Some(GET_CWD));
        let value = matching
            .next()
            .ok_or_else(|| io::Error::other("missing native tool descriptor"))?;
        if matching.next().is_some() {
            return Err(io::Error::other("duplicate native tool descriptor"));
        }
        Ok(Self {
            workspace: Arc::new(workspace),
            descriptor: serde_json::from_value(value)?,
        })
    }
}

impl ServerHandler for NativeTools {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(SERVER_NAME, env!("CARGO_PKG_VERSION")))
    }
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        const SUPPORTED: &[ProtocolVersion] =
            &[ProtocolVersion::V_2025_11_25, ProtocolVersion::V_2026_07_28];
        Cow::Borrowed(SUPPORTED)
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        (self.workspace.listed() && name == GET_CWD).then(|| self.descriptor.clone())
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(
            self.get_tool(GET_CWD).into_iter().collect(),
        ))
    }
    async fn call_tool(
        &self,
        args: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let root = self
            .workspace
            .get_cwd(&args.name)
            .ok_or_else(|| ErrorData::invalid_params("Unknown or disabled tool", None))?;
        let payload = json!({"cwd":root,"files_root":root}).to_string();
        Ok(CallToolResult::success(vec![ContentBlock::text(payload)]).into())
    }
}
