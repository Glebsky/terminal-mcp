import React, { useEffect, useRef, useState } from "react";
import { Terminal, Trash2, Filter, ArrowDown, Search } from "lucide-react";
import { operationColor, logOperation } from "./operationColor";
import type { LogEntry } from "../../types";
import { useI18n, type MessageKey } from "../i18n";



interface LogViewerProps {
  logs: LogEntry[];
  onClear: () => void;
}

export const LogViewer: React.FC<LogViewerProps> = ({ logs, onClear }) => {
  const { t } = useI18n();
  const [filter, setFilter] = useState<"all" | "audit" | "command" | "file" | "error">("all");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filteredLogs = logs.filter((log) => {
    if (filter === "audit" && log.type !== "audit") return false;
    if (filter === "command" && log.category !== "command") return false;
    if (filter === "file" && log.category !== "file") return false;
    if (filter === "error" && log.type !== "error") return false;

    if (search.trim()) {
      return log.message.toLowerCase().includes(search.toLowerCase());
    }
    return true;
  });

  useEffect(() => {
    if (autoScroll) {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  return (
    <div className="flex-1 flex flex-col min-h-0 rounded-2xl liquid-glass-card overflow-hidden border border-white/10">
      {/* Log Header Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-slate-950/40">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-cyan-400" />
          <span className="text-xs font-bold text-white uppercase tracking-wider">{t("logs.title")}</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-white/10 text-slate-400">
            {t("logs.events", { count: filteredLogs.length })}
          </span>
        </div>

        {/* Filters & Actions */}
        <div className="flex items-center gap-2">
          {/* Search Box */}
          <div className="relative flex items-center">
            <Search className="w-3 h-3 text-slate-500 absolute left-2.5 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("logs.search")}
              className="w-32 focus:w-48 transition-all h-7 pl-7 pr-2 rounded-lg bg-slate-900/90 border border-white/5 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500/40"
            />
          </div>

          {/* Filter Pills */}
          <div className="flex items-center gap-1 bg-slate-900/60 p-0.5 rounded-lg border border-white/5 text-[11px]">
            {(["all", "audit", "command", "file", "error"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className={`px-2 py-0.5 rounded-md font-medium capitalize transition-colors ${
                  filter === tab
                    ? "bg-gradient-to-r from-violet-600/80 to-cyan-600/80 text-white shadow-sm"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {t(("logs.filter." + tab) as MessageKey)}
              </button>
            ))}
          </div>

          {/* Clear Logs Button */}
          <button
            onClick={onClear}
            className="p-1.5 rounded-lg hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition-colors border border-transparent hover:border-rose-500/20"
            title={t("logs.clear")}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Log Output */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1.5 bg-slate-950/70 select-text">
        {filteredLogs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 text-xs py-12 gap-2">
            <Terminal className="w-8 h-8 text-slate-700 stroke-1" />
            <span>{t("logs.empty")}</span>
          </div>
        ) : (
          filteredLogs.map((log) => {
            const isAudit = log.type === "audit";
            const isError = log.type === "error";
            const isMcp = log.type === "mcp";
            const operation = logOperation(log.message, log.type);
            const color = operationColor(operation);

            return (
              <div
                key={log.id}
                style={{ borderLeft: `3px solid ${color}` }}
                className={`group flex items-start gap-3 py-1 px-2 rounded-lg transition-colors ${
                  isAudit
                    ? "bg-violet-950/20 border border-violet-500/10 text-violet-200"
                    : isError
                      ? "bg-rose-950/20 border border-rose-500/10 text-rose-300"
                      : isMcp
                        ? "bg-cyan-950/20 border border-cyan-500/10 text-cyan-200"
                        : "text-slate-300 hover:bg-white/[0.02]"
                }`}
              >
                <span className="text-[10px] text-slate-500 select-none shrink-0 pt-0.5 font-mono">
                  {log.timestamp}
                </span>

                {isAudit && (
                  <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-violet-500/20 text-violet-300 border border-violet-500/30 uppercase shrink-0">
                    AUDIT
                  </span>
                )}
                {isError && (
                  <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30 uppercase shrink-0">
                    ERR
                  </span>
                )}
                {isMcp && (
                  <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 uppercase shrink-0">
                    MCP
                  </span>
                )}

                <span className="operation-label" style={{ color }}>{operation}</span>
                <span className="break-all whitespace-pre-wrap leading-relaxed">{log.message}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
