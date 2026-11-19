/**
 * Dev-only bench for the DATA FLOW band (SPEC-003). Not part of the app bundle.
 * Run `npx vite` and open http://localhost:5173/preview/flow.html (add #heavy, #trickle… to pick a scenario).
 */
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "../src/renderer/i18n";
import { Monitor } from "../src/renderer/components/Monitor";
import type { MonitorSnapshot, ServerStatus } from "../src/types";
import "../src/renderer/appTheme.css";
import "../src/renderer/styles/liquid-glass.css";
import "../src/renderer/styles/settings.css";

type Scenario = "idle" | "trickle" | "steady" | "bursts" | "heavy" | "upload" | "offline";
const scenarios: Scenario[] = ["idle", "trickle", "steady", "bursts", "heavy", "upload", "offline"];
const r = (min: number, max: number) => min + Math.random() * (max - min);
let tick = 0;
const traffic: Record<Scenario, () => [number, number]> = {
  idle: () => [0, 0],
  trickle: () => (Math.random() < 0.6 ? [r(120, 700), r(200, 1400)] : [0, 0]),
  steady: () => [r(1500, 4000), r(9000, 22000)],
  bursts: () => (tick % 4 === 0 ? [r(4000, 9000), r(200000, 600000)] : tick % 4 === 1 ? [r(800, 2000), r(4000, 9000)] : [0, 0]),
  heavy: () => [r(40000, 90000), r(1200000, 2600000)],
  upload: () => [r(900000, 2200000), r(2000, 5000)],
  offline: () => [0, 0],
};
const base: ServerStatus = { state: "running", port: 3100, host: "127.0.0.1", tunnelProvider: "none", tunnelState: "disabled", ngrokEnabled: false, apiKey: "", fullAccess: false, filesRoot: "./workspace" };

function Bench() {
  const [scenario, setScenario] = useState<Scenario>(() => (scenarios.find(s => "#" + s === location.hash) ?? "steady"));
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [animation, setAnimation] = useState(true);
  useEffect(() => { (window as unknown as { setScenario: (s: Scenario) => void }).setScenario = setScenario; }, []);
  useEffect(() => {
    if (scenario === "offline") { setSnapshot(null); return; }
    let totalIn = 0, totalOut = 0, requests = 0;
    const emit = () => {
      tick++;
      const [received, sent] = traffic[scenario]();
      totalIn += received; totalOut += sent; if (received) requests++;
      const operations = received ? [{ operation: "file_read", received: received * 0.7, sent: sent * 0.8 }, { operation: "terminal_execute", received: received * 0.3, sent: sent * 0.2 }] : [];
      setSnapshot({ received, sent, totalReceived: totalIn, totalSent: totalOut, totalRequests: requests, activeRequests: received ? 1 : 0, activeSse: 1, activeHttp: received ? 1 : 0, sampledAt: Date.now(), recentClients: [{ client: "claude-desktop", operation: "file_read", lastSeen: new Date().toISOString(), requests }], operations });
    };
    emit();
    const timer = window.setInterval(emit, 1000);
    return () => window.clearInterval(timer);
  }, [scenario]);
  const status = scenario === "offline" ? { ...base, state: "offline" as const } : base;
  return (
    <div className={"app-shell" + (animation ? "" : " motion-off")}>
      <div className="aurora aurora-one"/><div className="aurora aurora-two"/><div className="aurora aurora-three"/>
      <main className="dashboard">
        <div className="workspace-tabs" style={{ alignSelf: "flex-start" }}>
          {scenarios.map(s => <button key={s} aria-selected={s === scenario} onClick={() => setScenario(s)}>{s}</button>)}
          <button aria-selected={!animation} onClick={() => setAnimation(v => !v)}>no motion</button>
        </div>
        <div className="workspace-body"><Monitor snapshot={snapshot} status={status} animation={animation}/></div>
      </main>
    </div>
  );
}

/** Bench probes: band thickness / colour per column and total light, for headless checks. */
function probe() {
  const c = document.querySelector<HTMLCanvasElement>(".flow-canvas")!;
  const W = c.width, H = c.height;
  const d = c.getContext("2d")!.getImageData(0, 0, W, H).data;
  const at = (x: number, y: number) => (y * W + x) * 4;
  const columns = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map(f => {
    const x0 = Math.floor(f * W) - 8;
    let top = -1, bottom = -1, r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < H; y++) {
      let peak = 0;
      for (let x = x0; x < x0 + 16; x++) {
        const i = at(x, y);
        const v = (d[i + 3]! / 255) * (d[i]! + d[i + 1]! + d[i + 2]!) / 765;
        if (v > peak) peak = v;
        if (Math.abs(y - H / 2) < 4 && d[i + 3]! > 20) { r += d[i]!; g += d[i + 1]!; b += d[i + 2]!; n++; }
      }
      if (peak > 0.12) { if (top < 0) top = y; bottom = y; }
    }
    return `${f}:h${top < 0 ? 0 : bottom - top + 1}:${n ? [r, g, b].map(v => Math.round(v / n)).join(",") : "-"}`;
  });
  let energy = 0;
  for (let i = 0; i < d.length; i += 16) energy += d[i + 3]! * (d[i]! + d[i + 1]! + d[i + 2]!);
  const pipe = document.querySelector<HTMLElement>(".flow-pipe")!;
  return { columns: columns.join(" "), energy: Math.round(energy / 1e6), pipe: pipe.className, label: getComputedStyle(document.querySelector(".pipe-idle")!).opacity, glow: [pipe.style.getPropertyValue("--flow-in"), pipe.style.getPropertyValue("--flow-out")].join("/"), rate: document.querySelector(".flow-rate")!.textContent };
}
const probes = window as unknown as { probe: () => string; record: (scenario: Scenario, ms: number) => string; recording: string[] };
probes.probe = () => JSON.stringify(probe());
probes.recording = [];
/** Switches scenario and records energy every 250 ms (read window.recording afterwards). */
probes.record = (scenario, ms) => {
  probes.recording = [];
  (window as unknown as { setScenario: (s: Scenario) => void }).setScenario(scenario);
  const started = performance.now();
  const timer = window.setInterval(() => {
    const p = probe();
    probes.recording.push(`${Math.round(performance.now() - started)}ms e${p.energy} ${p.pipe.includes("is-idle") ? "IDLE" : "live"} label${Number(p.label).toFixed(2)} glow${p.glow}`);
    if (performance.now() - started > ms) window.clearInterval(timer);
  }, 250);
  return "recording";
};

document.documentElement.classList.add(location.search.includes("light") ? "light" : "dark");
ReactDOM.createRoot(document.getElementById("root")!).render(<I18nProvider><Bench/></I18nProvider>);
