import { AlertTriangle, ExternalLink, Globe, Info } from "lucide-react";
import type { EnvConfig, TunnelProvider } from "../../types";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../lib/shadcn/ui";
import { SettingsField } from "./SettingsField";
import { useI18n, type MessageKey } from "../i18n";

const providerIds: TunnelProvider[] = ["none", "ngrok", "tuna", "cloudflare", "localtunnel"];
const providerDocs: Record<TunnelProvider, string> = {
  none: "",
  ngrok: "https://ngrok.com/docs/",
  tuna: "https://tuna.am/docs/tunnels/http/",
  cloudflare: "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/",
  localtunnel: "https://github.com/localtunnel/localtunnel",
};

export function TunnelSettings({ config, onChange }: { config: EnvConfig; onChange: (config: EnvConfig) => void }) {
  const { t } = useI18n();
  const providers = providerIds.map(id => ({ id, title: t(("tunnel." + id + ".title") as MessageKey), description: t(("tunnel." + id + ".description") as MessageKey), docs: providerDocs[id] }));
  const provider = providers.find(item => item.id === config.TUNNEL_PROVIDER) || providers[0]!;
  const field = { config, onChange };
  return <section className="settings-section" aria-labelledby="tunnel-section">
    <h3 className="settings-section-heading" id="tunnel-section"><Globe/> {t("tunnel.section")}</h3>
    <label className="settings-field" htmlFor="tunnel-provider">{t("tunnel.provider")}</label>
    <Select value={config.TUNNEL_PROVIDER} onValueChange={value => onChange({ ...config, TUNNEL_PROVIDER: value as TunnelProvider })}>
      <SelectTrigger id="tunnel-provider" className="mt-2" aria-describedby="provider-summary"><SelectValue/></SelectTrigger>
      <SelectContent>{providers.map(item => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent>
    </Select>
    <div className="settings-provider" key={config.TUNNEL_PROVIDER}>
      <div className="settings-provider-summary" id="provider-summary"><Info/><p>{provider.description}</p></div>
      {config.TUNNEL_PROVIDER === "ngrok" && <div className="settings-grid">
        <SettingsField {...field} name="NGROK_DOMAIN" label={t("tunnel.ngrokDomain")} placeholder="your-name.ngrok-free.app" note={t("tunnel.ngrokDomainNote")}/>
        <SettingsField {...field} name="NGROK_AUTHTOKEN" label={t("tunnel.ngrokToken")} type="password" autoComplete="new-password" placeholder={t("tunnel.ngrokTokenPlaceholder")}/>
      </div>}
      {config.TUNNEL_PROVIDER === "tuna" && <div className="settings-grid">
        <SettingsField {...field} name="TUNA_SUBDOMAIN" label={t("tunnel.tunaSubdomain")} placeholder="brave-otter-4821" note={t("tunnel.tunaSubdomainNote")}/>
        <SettingsField {...field} name="TUNA_API_KEY" label={t("tunnel.tunaKey")} type="password" autoComplete="new-password" placeholder={t("tunnel.tunaKeyPlaceholder")}/>
        <SettingsField {...field} wide name="TUNA_EXECUTABLE" label={t("tunnel.tunaExecutable")} placeholder="tuna" note={t("tunnel.tunaExecutableNote")}/>
      </div>}
      {config.TUNNEL_PROVIDER === "cloudflare" && <div className="settings-grid">
        <div className="settings-field settings-wide"><label htmlFor="cloudflare-mode">{t("tunnel.cloudflareMode")}</label>
          <Select value={config.CLOUDFLARE_MODE} onValueChange={value => onChange({ ...config, CLOUDFLARE_MODE: value === "named" ? "named" : "quick" })}>
            <SelectTrigger id="cloudflare-mode"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="named">{t("tunnel.cloudflareNamed")}</SelectItem><SelectItem value="quick">{t("tunnel.cloudflareQuick")}</SelectItem></SelectContent>
          </Select>
        </div>
        {config.CLOUDFLARE_MODE === "named" && <>
          <SettingsField {...field} name="CLOUDFLARE_PUBLIC_URL" label={t("tunnel.cloudflareUrl")} required type="url" placeholder="https://mcp.example.com" note={t("tunnel.cloudflareUrlNote")}/>
          <SettingsField {...field} name="CLOUDFLARE_TUNNEL_TOKEN" label={t("tunnel.cloudflareToken")} required type="password" autoComplete="new-password" note={t("tunnel.cloudflareTokenNote")}/>
        </>}
        <SettingsField {...field} wide name="CLOUDFLARED_EXECUTABLE" label={t("tunnel.cloudflaredExecutable")} placeholder="cloudflared"/>
      </div>}
      {config.TUNNEL_PROVIDER === "localtunnel" && <div className="settings-grid">
        <SettingsField {...field} name="LOCALTUNNEL_SUBDOMAIN" label={t("tunnel.localtunnelSubdomain")} placeholder="my-mcp-server" note={t("tunnel.localtunnelSubdomainNote")}/>
        <SettingsField {...field} name="LOCALTUNNEL_EXECUTABLE" label={t("tunnel.localtunnelExecutable")} placeholder="lt" note={t("tunnel.localtunnelExecutableNote")}/>
      </div>}
      {config.TUNNEL_PROVIDER === "cloudflare" && config.CLOUDFLARE_MODE === "quick" && <div className="settings-alert mt-3"><AlertTriangle/><p>{t("tunnel.quickWarning")}</p></div>}
      {config.TUNNEL_PROVIDER === "localtunnel" && <div className="settings-alert mt-3"><AlertTriangle/><p>{t("tunnel.localtunnelWarning")}</p></div>}
      {provider.docs && <Button variant="ghost" size="sm" className="mt-2" onClick={() => window.electronAPI.openExternal(provider.docs)}><ExternalLink/> {t("tunnel.docs")}</Button>}
      <p className="settings-note">{t("tunnel.note")}</p>
    </div>
  </section>;
}
