import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

type Hints = Required<Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">>;
// These entries describe behavior to clients. They do not grant permission or replace enforcement.
const readLocal: Hints = { readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false };
const changeLocal: Hints = { ...readLocal, readOnlyHint:false };
const replaceLocal: Hints = { ...changeLocal, destructiveHint:true };
const mutateLocal: Hints = { ...replaceLocal, idempotentHint:false };
const openWeb: Hints = { ...changeLocal, idempotentHint:false, openWorldHint:true };
const interact: Hints = { ...openWeb, destructiveHint:true };
const readWeb: Hints = { ...readLocal, openWorldHint:true };

export const TOOL_ANNOTATIONS = {
  terminal_execute:interact,
  file_read:readLocal, file_list:readLocal, file_stat:readLocal, file_search:readLocal,
  file_write:mutateLocal, file_replace:replaceLocal, file_mkdir:changeLocal,
  file_move:mutateLocal, file_delete:replaceLocal,
  workspace_get_cwd:readLocal, workspace_set_cwd:changeLocal,
  browser_open:openWeb, browser_navigate:openWeb, browser_new_tab:openWeb, browser_connect:openWeb,
  browser_evaluate:interact, browser_click:interact, browser_type:interact,
  browser_get_content:readWeb, browser_list_tabs:readWeb,
  browser_screenshot:{ ...changeLocal, openWorldHint:true },
  browser_select_tab:changeLocal, browser_close:changeLocal,
} satisfies Record<string,Hints>;
