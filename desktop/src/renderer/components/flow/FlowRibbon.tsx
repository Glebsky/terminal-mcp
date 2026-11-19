import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { FlowRibbonEngine } from "./flowRibbonEngine";

interface Props {
  /** Payload bytes received during the last sampled second. */
  received: number;
  /** Payload bytes sent during the last sampled second. */
  sent: number;
  /** `sampledAt` of the latest snapshot, or null while no snapshots arrive. */
  sampledAt: number | null;
  running: boolean;
  animated: boolean;
  ariaLabel: string;
  inboundTitle: string;
  outboundTitle: string;
  idleText: string;
  onIdleChange?: (idle: boolean) => void;
}

/** SPEC-003 · the DATA FLOW band: canvas ribbon between the inbound and outbound edge nodes. */
export const FlowRibbon: React.FC<Props> = ({ received, sent, sampledAt, running, animated, ariaLabel, inboundTitle, outboundTitle, idleText, onIdleChange }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<FlowRibbonEngine | null>(null);
  const idleListener = useRef(onIdleChange);
  const [idle, setIdle] = useState(true);

  useEffect(() => { idleListener.current = onIdleChange; }, [onIdleChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const engine = new FlowRibbonEngine(canvas, host, { onIdleChange: value => { setIdle(value); idleListener.current?.(value); } });
    engineRef.current = engine;
    const observer = new ResizeObserver(() => engine.resize());
    observer.observe(canvas);
    engine.resize();
    return () => { observer.disconnect(); engine.destroy(); engineRef.current = null; };
  }, []);

  useEffect(() => { engineRef.current?.setAnimated(animated); }, [animated]);
  useEffect(() => { engineRef.current?.setRunning(running); }, [running]);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (sampledAt === null) engine.clearTraffic();
    else engine.setTraffic(received, sent);
  }, [received, sent, sampledAt]);

  return (
    <div ref={hostRef} className={"flow-pipe" + (idle ? " is-idle" : "")} role="img" aria-label={ariaLabel}>
      <canvas ref={canvasRef} className="flow-canvas" aria-hidden="true"/>
      <span className="pipe-idle" aria-hidden="true">{idleText}</span>
      <span className="pipe-node pipe-start" title={inboundTitle}><ArrowRight size={18} strokeWidth={1.75}/></span>
      <span className="pipe-node pipe-end" title={outboundTitle}><ArrowLeft size={18} strokeWidth={1.75}/></span>
    </div>
  );
};
