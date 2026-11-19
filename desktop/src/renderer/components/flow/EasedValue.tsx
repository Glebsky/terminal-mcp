import { useEffect, useRef, useState } from "react";

interface Props {
  value: number;
  animated: boolean;
  format: (value: number) => string;
  durationMs?: number;
}

/**
 * Counts towards each new value (ease-out cubic) instead of jumping once per snapshot.
 * Renders text only, so it inherits the styles of whatever element wraps it.
 */
export function EasedValue({ value, animated, format, durationMs = 650 }: Props) {
  const [shown, setShown] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    if (!animated) { current.current = value; setShown(value); return; }
    const from = current.current;
    if (from === value) return;
    const started = performance.now();
    let frame = requestAnimationFrame(function step(now: number) {
      const k = Math.min(1, (now - started) / durationMs);
      const next = from + (value - from) * (1 - (1 - k) ** 3);
      current.current = next;
      setShown(next);
      if (k < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, animated, durationMs]);
  return <>{format(shown)}</>;
}
