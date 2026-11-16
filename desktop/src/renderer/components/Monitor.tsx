import React, { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ArrowLeft, ArrowRight, Users, Radio, Info } from "lucide-react";
import type { MonitorSnapshot, ServerStatus } from "../../types";
import { operationColor } from "./operationColor";
import { useI18n } from "../i18n";

interface Props { snapshot: MonitorSnapshot | null; status: ServerStatus; animation: boolean }
type Direction = "in" | "out";
interface Particle { id: number; dir: Direction; color: string; y0: number; y1: number; size: number; duration: number; delay: number; expires: number }

// Cool colours = inbound (client → server), warm colours = outbound (server → client).
const inboundPalette = ["#70d8ed", "#87aaff", "#80dfb4", "#75d2cb", "#a4dca4", "#9fd0ff", "#6fe3c8", "#b4ecff"] as const;
const outboundPalette = ["#b9a4ff", "#f09fbb", "#ffc77e", "#f69c83", "#e5a8ee", "#d4c477", "#ff9fd6", "#ffb3a1"] as const;
/** Particles spawned per one-second snapshot (both directions together). */
const PARTICLES_PER_SAMPLE = 24;
/** DOM budget for particles in flight. New particles are skipped, live ones are never cut. */
const MAX_LIVE_PARTICLES = 120;

function bytes(value: number): string {
  if (value < 1024) return Math.round(value) + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KiB";
  return (value / 1024 / 1024).toFixed(1) + " MiB";
}
const random = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
const quantumOf = (total: number) => Math.max(1, Math.ceil(total / PARTICLES_PER_SAMPLE));
const particleCount = (value: number, quantum: number) => (value > 0 ? Math.max(1, Math.round(value / quantum)) : 0);

/**
 * Particles live independently from snapshots: every new snapshot only adds particles,
 * and each particle is removed when its flight animation ends (FR-2.5).
 */
function useFlowParticles(snapshot: MonitorSnapshot | null, enabled: boolean) {
  const [particles, setParticles] = useState<Particle[]>([]);
  const nextId = useRef(0);
  const lastSample = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) { setParticles([]); return; }
    if (!snapshot || lastSample.current === snapshot.sampledAt) return;
    lastSample.current = snapshot.sampledAt;
    const quantum = quantumOf(snapshot.received + snapshot.sent);
    const now = performance.now();
    const born: Particle[] = [];
    const spawn = (dir: Direction, count: number) => {
      for (let i = 0; i < count; i++) {
        const duration = random(2.2, 3.6);
        // Spread spawns over the sampled second instead of emitting a burst.
        const delay = random(0, 0.95);
        born.push({ id: ++nextId.current, dir, color: pick(dir === "in" ? inboundPalette : outboundPalette), y0: random(14, 86), y1: random(14, 86), size: random(4, 7.5), duration, delay, expires: now + (duration + delay) * 1000 + 1000 });
      }
    };
    spawn("in", particleCount(snapshot.received, quantum));
    spawn("out", particleCount(snapshot.sent, quantum));
    if (!born.length) return;
    born.sort((a, b) => a.delay - b.delay);
    setParticles(current => {
      const room = Math.max(0, MAX_LIVE_PARTICLES - current.length);
      return room ? current.concat(born.slice(0, room)) : current;
    });
  }, [snapshot, enabled]);

  // Safety net for particles whose animationend never fired (e.g. window hidden).
  const hasParticles = particles.length > 0;
  useEffect(() => {
    if (!hasParticles) return;
    const timer = window.setInterval(() => {
      const now = performance.now();
      setParticles(current => (current.some(p => p.expires <= now) ? current.filter(p => p.expires > now) : current));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasParticles]);

  const remove = useCallback((id: number) => setParticles(current => current.filter(p => p.id !== id)), []);
  return { particles, remove };
}

function staticParticles(snapshot: MonitorSnapshot | null): Particle[] {
  if (!snapshot) return [];
  const quantum = quantumOf(snapshot.received + snapshot.sent);
  const result: Particle[] = [];
  const add = (dir: Direction, count: number) => {
    const palette = dir === "in" ? inboundPalette : outboundPalette;
    for (let i = 0; i < count; i++) {
      const index = result.length;
      result.push({ id: index, dir, color: palette[index % palette.length]!, y0: 18 + (index * 37 % 64), y1: 0, size: 6, duration: 0, delay: 0, expires: 0 });
    }
  };
  add("in", particleCount(snapshot.received, quantum));
  add("out", particleCount(snapshot.sent, quantum));
  return result;
}

export const Monitor: React.FC<Props> = ({ snapshot, status, animation }) => {
  const { t, locale } = useI18n();
  const rx = snapshot?.received || 0;
  const tx = snapshot?.sent || 0;
  const operations = [...(snapshot?.operations || [])].sort((a, b) => b.received + b.sent - a.received - a.sent);
  const quantum = quantumOf(rx + tx);
  const { particles: flying, remove } = useFlowParticles(snapshot, animation);
  const still = animation ? [] : staticParticles(snapshot);
  const idle = animation ? flying.length === 0 : still.length === 0;
  const clients = snapshot?.recentClients ?? [];
  return (
    <section className="monitor-panel liquid-glass-card" aria-label={t("monitor.aria")}>
      <div className="monitor-heading">
        <div><div className="section-eyebrow"><Activity size={14}/> {t("monitor.eyebrow")}</div><h2>{t("monitor.title")}</h2></div>
        <span className="monitor-live"><span className="status-dot"/> {status.state === "running" ? t("monitor.collecting") : t("monitor.offline")}</span>
      </div>
      <div className="monitor-stats">
        <div><span>{t("monitor.activeRequests")}</span><strong>{snapshot?.activeRequests ?? 0}</strong><small>{t("monitor.activeDetail", { sse: snapshot?.activeSse ?? 0, http: snapshot?.activeHttp ?? 0 })}</small></div>
        <div><span>{t("monitor.requestsSeen")}</span><strong>{snapshot?.totalRequests ?? 0}</strong><small>{t("monitor.sinceStart")}</small></div>
        <div><span>{t("monitor.inbound")}</span><strong>{bytes(rx)}<small>{t("monitor.perSecond")}</small></strong><small>{t("monitor.total", { value: bytes(snapshot?.totalReceived ?? 0) })}</small></div>
        <div><span>{t("monitor.outbound")}</span><strong>{bytes(tx)}<small>{t("monitor.perSecond")}</small></strong><small>{t("monitor.total", { value: bytes(snapshot?.totalSent ?? 0) })}</small></div>
      </div>
      <div className="pipe-section">
        <div className="pipe-caption"><span><Radio size={14}/> {t("monitor.dataFlow")} <em>{t("monitor.payloads")}</em></span><span>{t("monitor.perParticle", { size: bytes(quantum) })}</span></div>
        <div className="flow-pipe" aria-label={t("monitor.pipeAria", { rx: bytes(rx), tx: bytes(tx) })}>
          <div className="pipe-start" title={t("monitor.inboundEdge")}><ArrowRight size={17}/></div><div className="pipe-grid"/>
          {animation
            ? flying.map(p => <span key={p.id} className={"flow-particle flow-" + p.dir} onAnimationEnd={() => remove(p.id)} style={{ "--particle-color": p.color, "--particle-size": p.size + "px", "--y0": p.y0 + "%", "--y1": p.y1 + "%", animationDuration: p.duration + "s", animationDelay: p.delay + "s" } as React.CSSProperties}/>)
            : still.map((p, index) => <span key={p.id} className="flow-particle" style={{ "--particle-color": p.color, "--particle-y": p.y0 + "%", "--particle-x": (p.dir === "in" ? 12 + (index * 17 % 36) : 52 + (index * 17 % 36)) + "%" } as React.CSSProperties}/>)}
          {idle && <span className="pipe-idle">{status.state === "running" ? t("monitor.waiting") : t("monitor.startServer")}</span>}
          <div className="pipe-end" title={t("monitor.outboundEdge")}><ArrowLeft size={17}/></div>
        </div>
        <div className="flow-legend">
          <span className="flow-direction"><i className="flow-direction-in"/>{t("monitor.legendInbound")} <b>{bytes(rx)}{t("monitor.perSecond")}</b></span>
          <span className="flow-direction"><i className="flow-direction-out"/>{t("monitor.legendOutbound")} <b>{bytes(tx)}{t("monitor.perSecond")}</b></span>
          {operations.length ? operations.slice(0, 8).map(op => <span key={op.operation}><i style={{ background: operationColor(op.operation) }}/>{op.operation} <b>↓{bytes(op.received)} ↑{bytes(op.sent)}</b></span>) : <span>{t("monitor.noOperations")}</span>}
        </div>
      </div>
      <div className="clients-heading"><span><Users size={14}/> {t("monitor.recentClients")}</span><span>{t("monitor.shown", { count: clients.length })}</span></div>
      <div className="client-list">
        {!clients.length ? <div className="client-empty">{t("monitor.noClients")}</div> : clients.map(client => <div className="client-row" key={client.client}><span className="client-avatar">{client.client.charAt(0).toUpperCase()}</span><span className="client-name" title={client.client}>{client.client}</span><span className="client-operation" style={{ color: operationColor(client.operation) }}>{client.operation}</span><span>{t("monitor.requests", { count: client.requests })}</span><time dateTime={client.lastSeen}>{new Date(client.lastSeen).toLocaleTimeString(locale)}</time></div>)}
      </div>
      <p className="monitor-note"><Info size={13}/> {t("monitor.note")}</p>
    </section>
  );
};
