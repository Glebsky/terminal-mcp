import { useEffect, useRef, useState, type FC } from "react";
import { Check, Copy, Key, Link2, Sparkles, AlertCircle, Globe, Eye, EyeOff, Server } from "lucide-react";
import { tunnelProviderLabels, type ServerStatus } from "../../types";
import { useI18n } from "../i18n";

interface NotionCardProps {
  status: ServerStatus;
}

export const NotionCard: FC<NotionCardProps> = ({ status }) => {
  const { t } = useI18n();
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);

  const host = ["0.0.0.0", "::", "[::]"].includes(status.host) ? "127.0.0.1" : status.host || "127.0.0.1";
  const localMcpUrl = `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${status.port}/mcp`;
  const tunnelBaseUrl = status.tunnelUrl || "";
  const providerLabel = tunnelProviderLabels[status.tunnelProvider];
  const publicMcpUrl = tunnelBaseUrl ? `${tunnelBaseUrl}/mcp` : "";

  const [copyError, setCopyError] = useState("");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const copyToClipboard = async (text: string, fieldName: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyError(""); setCopiedField(fieldName);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedField(null), 2000);
    } catch { setCopyError(t("endpoints.clipboardError")); }
  };

  const isLive = status.state === "running";

  return (
    <div className="relative overflow-hidden rounded-2xl liquid-glass-card p-5 border border-white/10 space-y-4">
      {/* Background ambient gradient glow */}
      <div className="absolute -top-12 -right-12 w-48 h-48 bg-gradient-to-br from-violet-600/20 to-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-cyan-500/20 to-violet-500/20 border border-cyan-500/30 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-cyan-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white tracking-wide">{t("endpoints.title")}</h3>
            <p className="text-xs text-slate-400">{t("endpoints.subtitle")}</p>
          </div>
        </div>

        {status.tunnelUrl && isLive ? (
          <span className="endpoint-badge" data-state={status.tunnelState}>
            <span className="endpoint-status-dot" />
            {providerLabel} · {status.tunnelState === "unverified" ? t("tunnel.state.unverified") : t("tunnel.state.connected")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-amber-500/10 border border-amber-500/20 text-amber-400 font-mono">
            <AlertCircle className="w-3.5 h-3.5" />
            {status.state === "offline" || status.state === "error" ? t("endpoints.serverOffline") : status.tunnelState === "error" ? t("endpoints.providerError", { provider: providerLabel }) : status.tunnelState === "starting" ? t("endpoints.providerConnecting", { provider: providerLabel }) : t("endpoints.localOnly")}
          </span>
        )}
      </div>

      {/* Grid of endpoint & auth copy blocks */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* 1. Notion MCP Public URL (Ngrok) */}
        <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-slate-950/60 border border-white/5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1">
              <Link2 className="w-3 h-3 text-cyan-400" />
              {t("endpoints.publicUrl")}
            </span>
            <button
              onClick={() => copyToClipboard(publicMcpUrl, "publicMcpUrl")}
              disabled={!isLive || !publicMcpUrl}
              className="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 transition-colors disabled:opacity-40"
            >
              {copiedField === "publicMcpUrl" ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400 font-medium">{t("endpoints.copied")}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>{t("endpoints.copy")}</span>
                </>
              )}
            </button>
          </div>
          <div className="font-mono text-xs text-slate-200 truncate bg-slate-900/80 px-2.5 py-1.5 rounded-lg border border-white/5 select-all">
            {isLive
              ? publicMcpUrl || status.tunnelError || (status.tunnelState === "starting" ? t("endpoints.connectingTunnel") : t("endpoints.noTunnel"))
              : t("endpoints.offlineUrl")}
          </div>
        </div>

        {/* 2. Local MCP URL */}
        <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-slate-950/60 border border-white/5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1">
              <Server className="w-3 h-3 text-sky-400" />
              {t("endpoints.localUrl")}
            </span>
            <button
              onClick={() => copyToClipboard(localMcpUrl, "localMcpUrl")}
              disabled={!isLive}
              className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300 transition-colors disabled:opacity-40"
            >
              {copiedField === "localMcpUrl" ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400 font-medium">{t("endpoints.copied")}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>{t("endpoints.copy")}</span>
                </>
              )}
            </button>
          </div>
          <div className="font-mono text-xs text-slate-200 truncate bg-slate-900/80 px-2.5 py-1.5 rounded-lg border border-white/5 select-all">
            {isLive ? localMcpUrl : localMcpUrl}
          </div>
        </div>

        {/* 3. Pure API Token (Raw Key without "Bearer ") */}
        <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-slate-950/60 border border-white/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                <Key className="w-3 h-3 text-emerald-400" />
                {t("endpoints.rawToken")}
              </span>
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="text-slate-500 hover:text-slate-300 transition-colors"
                title={showToken ? t("endpoints.hideToken") : t("endpoints.showToken")}
                aria-label={showToken ? t("endpoints.hideToken") : t("endpoints.showToken")}
              >
                {showToken ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
            <button
              onClick={() => copyToClipboard(status.apiKey, "rawKey")}
              disabled={!status.apiKey}
              className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 transition-colors disabled:opacity-40"
            >
              {copiedField === "rawKey" ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400 font-medium">{t("endpoints.copied")}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>{t("endpoints.copyToken")}</span>
                </>
              )}
            </button>
          </div>
          <div className="font-mono text-xs text-slate-200 truncate bg-slate-900/80 px-2.5 py-1.5 rounded-lg border border-white/5 select-all">
            {status.apiKey
              ? showToken
                ? status.apiKey
                : "•".repeat(24) + status.apiKey.slice(-8)
              : t("endpoints.noToken")}
          </div>
        </div>

        {/* 4. Full Authorization Header value ("Bearer <token>") */}
        <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-slate-950/60 border border-white/5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1">
              <Key className="w-3 h-3 text-violet-400" />
              {t("endpoints.header")}
            </span>
            <button
              onClick={() => copyToClipboard(`Bearer ${status.apiKey}`, "header")}
              disabled={!status.apiKey}
              className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 transition-colors disabled:opacity-40"
            >
              {copiedField === "header" ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400 font-medium">{t("endpoints.copied")}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>{t("endpoints.copyHeader")}</span>
                </>
              )}
            </button>
          </div>
          <div className="font-mono text-xs text-slate-200 truncate bg-slate-900/80 px-2.5 py-1.5 rounded-lg border border-white/5 select-all">
            {status.apiKey
              ? showToken
                ? `Bearer ${status.apiKey}`
                : `Bearer ${"•".repeat(20)}${status.apiKey.slice(-8)}`
              : t("endpoints.noToken")}
          </div>
        </div>
      </div>

      {copyError && <p role="alert" className="endpoint-warning">{copyError}</p>}
      {status.tunnelError && <p role="alert" className="endpoint-warning">{status.tunnelError}</p>}
      {status.tunnelUrl && <p className="text-xs text-slate-400">{t("endpoints.publicNote", { provider: providerLabel })}</p>}
      {/* Public tunnel address */}
      {status.tunnelUrl && (
        <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-950/40 border border-white/5 text-xs">
          <div className="flex items-center gap-2 text-slate-400">
            <Globe className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
            <span className="text-[11px]">{t("endpoints.baseDomain", { provider: providerLabel })}</span>
            <span className="font-mono text-slate-300 select-all">{tunnelBaseUrl}</span>
          </div>
          <button
            onClick={() => copyToClipboard(tunnelBaseUrl, "ngrokBase")}
            className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            {copiedField === "ngrokBase" ? (
              <span className="text-emerald-400">{t("endpoints.copiedShort")}</span>
            ) : (
              <span>{t("endpoints.copyDomain")}</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
};
