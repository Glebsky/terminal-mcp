import { useEffect, useState } from "react";
import { useMotionPreferences } from "./hooks/useMotionPreferences";
import { Button } from "./lib/shadcn/ui";
import "./appTheme.css";
import { Activity, Pause, Play, Terminal } from "lucide-react";
import { TitleBar } from "./components/TitleBar";
import { NotionCard } from "./components/NotionCard";
import { Controls } from "./components/Controls";
import { LogViewer } from "./components/LogViewer";
import { SettingsModal } from "./components/SettingsModal";
import { Monitor } from "./components/Monitor";
import type { LogEntry, MonitorSnapshot, ServerStatus } from "../types";
import { useI18n } from "./i18n";

export const App = () => {
  const { t } = useI18n();
  const [status, setStatus] = useState<ServerStatus>({ state: "offline", port: 3100, host: "127.0.0.1", tunnelProvider: "none", tunnelState: "disabled", ngrokEnabled: false, apiKey: "", fullAccess: false, filesRoot: "./workspace" });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const { animation, setAnimation, backgroundAnimation, setBackgroundAnimation, reducedMotion, interfaceMotion, backgroundMotion } = useMotionPreferences();
  const [needsRestart, setNeedsRestart] = useState(false);
  const [monitoring, setMonitoring] = useState(() => localStorage.getItem("mcp-terminal-monitoring") !== "false");
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [tab, setTab] = useState<"logs" | "monitor">("monitor");

  useEffect(() => {
    void window.electronAPI.getServerStatus().then(setStatus);
    const unsubStatus = window.electronAPI.onStatusChange(setStatus);
    const unsubLogs = window.electronAPI.onLog((log) => setLogs((prev) => [...prev.slice(-999), log]));
    const unsubMonitor = window.electronAPI.onMonitoring(setSnapshot);
    return () => { unsubStatus(); unsubLogs(); unsubMonitor(); };
  }, []);
  useEffect(() => { if (status.state === "starting") setNeedsRestart(false); }, [status.state]);
  useEffect(() => {
    localStorage.setItem("mcp-terminal-monitoring", String(monitoring));
    setSnapshot(null);
    void window.electronAPI.setMonitoring(monitoring);
  }, [monitoring]);
  useEffect(() => { if (status.state !== "running") setSnapshot(null); }, [status.state]);

  const toggleMonitor = () => { setMonitoring((value) => !value); if (monitoring) setTab("logs"); else setTab("monitor"); };
  return (
    <div className={`app-shell ${interfaceMotion ? "" : "motion-off"} ${backgroundMotion ? "" : "background-motion-off"}`}>
      <div className="aurora aurora-one"/><div className="aurora aurora-two"/><div className="aurora aurora-three"/>
      <TitleBar status={status} onOpenSettings={() => setIsSettingsOpen(true)} />
      <main className="dashboard">
        {status.error && <div className="settings-alert settings-error" role="alert">{status.error}</div>}
        {needsRestart && <div className="settings-restart-note" role="status"><span>{t("app.restartNotice")}</span><Button size="sm" variant="ghost" onClick={() => setNeedsRestart(false)}>{t("app.dismiss")}</Button></div>}
        <Controls status={status} onStart={() => void window.electronAPI.startServer()} onStop={() => void window.electronAPI.stopServer()} onRestart={() => void window.electronAPI.restartServer()} onOpenSettings={() => setIsSettingsOpen(true)} />
        <NotionCard status={status}/>
        <div className="workspace-nav">
          <div className="workspace-tabs" role="tablist" aria-label={t("app.tabsLabel")}>
            <button role="tab" aria-selected={tab === "monitor"} onClick={() => setTab("monitor")}><Activity size={15}/> {t("app.tabMonitor")}</button>
            <button role="tab" aria-selected={tab === "logs"} onClick={() => setTab("logs")}><Terminal size={15}/> {t("app.tabLogs")} <span>{logs.length}</span></button>
          </div>
          <button className="monitor-toggle" onClick={toggleMonitor} aria-pressed={monitoring}>{monitoring ? <Pause size={13}/> : <Play size={13}/>} {monitoring ? t("app.pauseMonitoring") : t("app.enableMonitoring")}</button>
        </div>
        <div className="workspace-body">
          {tab === "monitor" ? monitoring ? <Monitor snapshot={snapshot} status={status} animation={interfaceMotion}/> : <div className="monitor-paused liquid-glass-card"><Pause size={25}/><h2>{t("app.pausedTitle")}</h2><p>{t("app.pausedText")}</p><button className="liquid-glass-btn" onClick={toggleMonitor}>{t("app.enableMonitoring")}</button></div> : <LogViewer logs={logs} onClear={() => { setLogs([]); void window.electronAPI.clearLogs(); }}/>}
        </div>
      </main>
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} onSaved={() => { setNeedsRestart(true); void window.electronAPI.getServerStatus().then(setStatus); }} animation={animation} onAnimationChange={setAnimation} backgroundAnimation={backgroundAnimation} onBackgroundAnimationChange={setBackgroundAnimation} reducedMotion={reducedMotion}/>
    </div>
  );
};
export default App;
