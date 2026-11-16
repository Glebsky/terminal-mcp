import React from "react";
import { Play, Square, RotateCw, Settings, FolderOpen } from "lucide-react";
import type { ServerStatus } from "../../types";
import { Button } from "../lib/shadcn/ui";
import { useI18n } from "../i18n";



interface ControlsProps {
  status: ServerStatus;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onOpenSettings: () => void;
}

export const Controls: React.FC<ControlsProps> = ({
  status,
  onStart,
  onStop,
  onRestart,
  onOpenSettings,
}) => {
  const { t } = useI18n();
  const isRunning = status.state === "running";
  const isStarting = status.state === "starting";

  return (
    <div className="flex items-center justify-between gap-4 p-3 rounded-2xl liquid-glass-card border border-white/10">
      {/* Action Buttons */}
      <div className="flex items-center gap-2">
        {!isRunning ? (
          <button
            onClick={onStart}
            disabled={isStarting}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-semibold text-xs tracking-wide shadow-lg shadow-emerald-500/20 border border-emerald-400/30 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
          >
            <Play className={`w-4 h-4 fill-white ${isStarting ? "animate-spin functional-motion" : ""}`} />
            <span>{isStarting ? t("controls.starting") : t("controls.start")}</span>
          </button>
        ) : (
          <button
            onClick={onStop}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white font-semibold text-xs tracking-wide shadow-lg shadow-rose-500/20 border border-rose-400/30 transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <Square className="w-4 h-4 fill-white" />
            <span>{t("controls.stop")}</span>
          </button>
        )}

        <button
          onClick={onRestart}
          disabled={!isRunning || isStarting}
          className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl liquid-glass-btn text-xs font-medium text-slate-300 hover:text-white disabled:opacity-40"
          title={t("controls.restartTitle")}
        >
          <RotateCw className="w-3.5 h-3.5" />
          <span>{t("controls.restart")}</span>
        </button>
      </div>

      {/* Info Badges & Settings Trigger */}
      <div className="flex items-center gap-3">
        {/* Workspace Path Info */}
        <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-950/40 border border-white/5 text-[11px] font-mono text-slate-400 max-w-[280px] truncate">
          <FolderOpen className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          <span className="truncate">{status.filesRoot}</span>
        </div>

        {/* Settings Button */}
        <Button onClick={onOpenSettings} aria-haspopup="dialog"><Settings size={16}/><span>{t("controls.settings")}</span></Button>
      </div>
    </div>
  );
};
