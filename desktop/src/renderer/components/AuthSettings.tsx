import { useId } from "react";
import { KeyRound, ShieldAlert } from "lucide-react";
import type { EnvConfig } from "../../types";
import { Input, Switch } from "../lib/shadcn/ui";
import { useI18n } from "../i18n";

/** Must match the server's acknowledgement phrase for AUTH_METHODS=none. */
const NO_AUTH_ACK = "I_UNDERSTAND_ANYONE_CAN_CONTROL_THIS_PC";
type Method = "bearer" | "query" | "basic" | "none";
const METHODS: Method[] = ["bearer", "query", "basic", "none"];

/** Enabled methods from AUTH_METHODS; an empty value means the default, the header key. */
export function parseAuthMethods(value: string): Set<string> {
  const names = value.split(/[;,\s]+/).map(name => name.trim().toLowerCase()).filter(Boolean);
  return new Set(names.length ? names : ["bearer"]);
}

/** How MCP clients sign in: header key, key in the URL, HTTP Basic, or (explicitly confirmed) no authentication. */
export function AuthSettings({ config, onChange }: { config: EnvConfig; onChange: (config: EnvConfig) => void }) {
  const { t } = useI18n();
  const userId = useId(); const passwordId = useId();
  const enabled = parseAuthMethods(config.AUTH_METHODS ?? "bearer");
  const toggle = (method: Method, on: boolean) => {
    const next = new Set(enabled);
    if (on) next.add(method); else next.delete(method);
    // At least one method stays on: an empty list falls back to the header key.
    if (!next.size) next.add("bearer");
    onChange({ ...config, AUTH_METHODS: METHODS.filter(name => next.has(name)).join(";"), ...(method === "none" && !on ? { ALLOW_NO_AUTH: "" } : {}) });
  };
  const row = (method: Method, label: string, note: string) => <div className="settings-toggle-row mt-3" key={method}>
    <div><label htmlFor={"auth-" + method}>{label}</label><p id={"auth-" + method + "-note"}>{note}</p></div>
    <Switch id={"auth-" + method} checked={enabled.has(method)} onCheckedChange={on => toggle(method, on)} aria-describedby={"auth-" + method + "-note"}/>
  </div>;
  return <div className="settings-field mt-3">
    <label className="flex items-center gap-2"><KeyRound size={15}/> {t("auth.methods")}</label>
    <small>{t("auth.methodsNote")}</small>
    {row("bearer", t("auth.bearer"), t("auth.bearerNote"))}
    {row("query", t("auth.query"), t("auth.queryNote"))}
    {row("basic", t("auth.basic"), t("auth.basicNote"))}
    {enabled.has("basic") && <div className="settings-grid mt-2">
      <div className="settings-field"><label htmlFor={userId}>{t("auth.basicUser")}</label><Input id={userId} autoComplete="username" required value={config.BASIC_AUTH_USER ?? ""} onChange={event => onChange({ ...config, BASIC_AUTH_USER: event.target.value })}/></div>
      <div className="settings-field"><label htmlFor={passwordId}>{t("auth.basicPassword")}</label><Input id={passwordId} type="password" autoComplete="new-password" required minLength={12} value={config.BASIC_AUTH_PASSWORD ?? ""} onChange={event => onChange({ ...config, BASIC_AUTH_PASSWORD: event.target.value })}/></div>
    </div>}
    {row("none", t("auth.none"), t("auth.noneNote"))}
    {enabled.has("none") && <div className="settings-alert settings-error mt-2" role="alert">
      <ShieldAlert/>
      <div className="flex flex-1 items-center justify-between gap-3">
        <p>{t("auth.noneNote")}</p>
        <label className="flex shrink-0 items-center gap-2" htmlFor="auth-none-confirm">
          <Switch id="auth-none-confirm" checked={config.ALLOW_NO_AUTH === NO_AUTH_ACK} onCheckedChange={on => onChange({ ...config, ALLOW_NO_AUTH: on ? NO_AUTH_ACK : "" })}/>
          {t("auth.noneConfirm")}
        </label>
      </div>
    </div>}
  </div>;
}
