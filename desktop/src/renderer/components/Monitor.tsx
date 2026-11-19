import React, { useCallback, useState } from "react";
import { Activity, Users, Radio, Info } from "lucide-react";
import type { MonitorSnapshot, ServerStatus } from "../../types";
import { operationColor } from "./operationColor";
import { useI18n } from "../i18n";
import { FlowRibbon } from "./flow/FlowRibbon";
import { EasedValue } from "./flow/EasedValue";

interface Props { snapshot: MonitorSnapshot | null; status: ServerStatus; animation: boolean }

function bytes(value: number): string {
  if (value < 1024) return Math.round(value) + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KiB";
  return (value / 1024 / 1024).toFixed(1) + " MiB";
}

export const Monitor: React.FC<Props> = ({ snapshot, status, animation }) => {
  const { t, locale } = useI18n();
  const [flowIdle, setFlowIdle] = useState(true);
  const rx = snapshot?.received || 0;
  const tx = snapshot?.sent || 0;
  const running = status.state === "running";
  const operations = [...(snapshot?.operations || [])].sort((a, b) => b.received + b.sent - a.received - a.sent);
  const clients = snapshot?.recentClients ?? [];
  const perSecond = t("monitor.perSecond");
  const throughput = useCallback((value: number) => t("monitor.throughput", { size: bytes(value) }), [t]);
  return (
    <section className="monitor-panel liquid-glass-card" aria-label={t("monitor.aria")}>
      <div className="monitor-heading">
        <div><div className="section-eyebrow"><Activity size={14}/> {t("monitor.eyebrow")}</div><h2>{t("monitor.title")}</h2></div>
        <span className="monitor-live"><span className="status-dot"/> {running ? t("monitor.collecting") : t("monitor.offline")}</span>
      </div>
      <div className="monitor-stats">
        <div><span>{t("monitor.activeRequests")}</span><strong>{snapshot?.activeRequests ?? 0}</strong><small>{t("monitor.activeDetail", { sse: snapshot?.activeSse ?? 0, http: snapshot?.activeHttp ?? 0 })}</small></div>
        <div><span>{t("monitor.requestsSeen")}</span><strong>{snapshot?.totalRequests ?? 0}</strong><small>{t("monitor.sinceStart")}</small></div>
        <div><span>{t("monitor.inbound")}</span><strong><EasedValue value={rx} animated={animation} format={bytes}/><small>{perSecond}</small></strong><small>{t("monitor.total", { value: bytes(snapshot?.totalReceived ?? 0) })}</small></div>
        <div><span>{t("monitor.outbound")}</span><strong><EasedValue value={tx} animated={animation} format={bytes}/><small>{perSecond}</small></strong><small>{t("monitor.total", { value: bytes(snapshot?.totalSent ?? 0) })}</small></div>
      </div>
      <div className="pipe-section">
        <div className={"pipe-caption" + (flowIdle ? " is-idle" : "")}>
          <span><Radio size={14}/> {t("monitor.dataFlow")} <em>{t("monitor.payloads")}</em></span>
          <span className="flow-rate"><i className="flow-live-dot"/><EasedValue value={rx + tx} animated={animation} format={throughput}/></span>
        </div>
        <FlowRibbon
          received={rx}
          sent={tx}
          sampledAt={snapshot?.sampledAt ?? null}
          running={running}
          animated={animation}
          ariaLabel={t("monitor.pipeAria", { rx: bytes(rx), tx: bytes(tx) })}
          inboundTitle={t("monitor.inboundEdge")}
          outboundTitle={t("monitor.outboundEdge")}
          idleText={running ? t("monitor.waiting") : t("monitor.startServer")}
          onIdleChange={setFlowIdle}
        />
        <div className="flow-legend">
          <span className="flow-direction"><i className="flow-direction-in"/>{t("monitor.legendInbound")} <b><EasedValue value={rx} animated={animation} format={bytes}/>{perSecond}</b></span>
          <span className="flow-direction"><i className="flow-direction-out"/>{t("monitor.legendOutbound")} <b><EasedValue value={tx} animated={animation} format={bytes}/>{perSecond}</b></span>
          {operations.length ? operations.slice(0, 8).map(op => <span key={op.operation}><i style={{ background: operationColor(op.operation) }}/>{op.operation} <b>↓{bytes(op.received)} ↑{bytes(op.sent)}</b></span>) : <span key="none">{t("monitor.noOperations")}</span>}
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
