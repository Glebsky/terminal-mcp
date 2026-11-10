import React from "react";
import { Minus, Square, X, Shield, Globe, ArrowDownToLine } from "lucide-react";
import stationIcon from "../../../icon-32.svg";
import { tunnelProviderLabels, type ServerStatus } from "../../types";



interface TitleBarProps {
  status: ServerStatus;
  onOpenSettings: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({ status, onOpenSettings }) => {
  const isRunning = status.state === "running";

  return (
    <header className="drag-region h-12 w-full flex items-center justify-between px-4 border-b border-white/5 bg-slate-950/40 select-none">
      {/* App Branding */}
      <div className="flex items-center gap-3 no-drag">
        <div className="relative flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-tr from-violet-600 to-cyan-500 shadow-lg shadow-violet-500/20 border border-white/20">
          <img src={stationIcon} alt="" className="w-full h-full rounded-lg" />
          {isRunning && (
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-slate-950 animate-pulse" />
          )}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-bold text-sm tracking-tight text-white/90">MCP Terminal</span>
          <span className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded bg-white/5 text-slate-400 border border-white/5">
            v2.0.0
          </span>
        </div>
      </div>

      {/* Center Status Pill */}
      <div className="flex items-center gap-2 no-drag">
        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900/60 border border-white/5 text-xs">
          <span
            className={`w-2 h-2 rounded-full ${
              status.state === "running"
                ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
                : status.state === "starting"
                  ? "bg-amber-400 animate-ping"
                  : status.state === "error"
                    ? "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)]"
                    : "bg-slate-500"
            }`}
          />
          <span className="font-mono uppercase text-[11px] font-semibold text-slate-300">
            {status.state}
          </span>
          <span className="text-white/20">|</span>
          <span className="text-[11px] text-slate-400 font-mono">Port {status.port}</span>
        </div>

        {status.tunnelUrl && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-cyan-950/40 border border-cyan-500/20 text-cyan-400 text-xs font-mono">
            <Globe className="w-3 h-3 text-cyan-400" />
            <span className="text-[11px] font-medium">{tunnelProviderLabels[status.tunnelProvider]} · {status.tunnelState === "unverified" ? "Unverified" : "Connected"}</span>
          </div>
        )}

        {status.fullAccess ? (
          <div className="flex items-center gap-1 px-2 py-1 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-mono">
            <Shield className="w-3 h-3" />
            <span>FULL ACCESS</span>
          </div>
        ) : (
          <div className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800/40 border border-white/5 text-slate-400 text-[10px] font-mono">
            <Shield className="w-3 h-3 text-emerald-400/80" />
            <span>SANDBOX</span>
          </div>
        )}
      </div>

      {/* Window Controls */}
      <div className="flex items-center gap-1 no-drag">
        <button
          onClick={() => window.electronAPI.minimizeWindow()}
          className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
          title="Свернуть на панель задач"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => window.electronAPI.hideToTray()}
          className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-white/10 text-slate-400 hover:text-cyan-400 transition-colors"
          title="Свернуть в трей (скрыть с панели задач)"
        >
          <ArrowDownToLine className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => window.electronAPI.maximizeWindow()}
          className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
          title="Развернуть"
        >
          <Square className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => window.electronAPI.closeWindow()}
          className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-rose-500/20 hover:text-rose-400 text-slate-400 transition-colors"
          title="Закрыть (свернуть в трей)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
