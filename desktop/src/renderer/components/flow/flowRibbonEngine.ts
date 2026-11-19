/**
 * SPEC-003 - DATA FLOW band renderer.
 *
 * One luminous blue -> violet ribbon drawn on a 2D canvas. Its thickness follows the payload
 * volume of the last second on a log scale: a trickle is a thin thread, a file transfer fills
 * the pipe. Inbound swells travel left -> right (client -> server), outbound swells right -> left.
 *
 * Nothing ever jumps: a snapshot only moves a target, an attack/release envelope follows it,
 * and a history buffer carries that envelope along the pipe. When traffic stops (or snapshots
 * stop arriving) the envelope releases and the band fades out on its own; packets already in
 * flight always finish their trip.
 */

export type FlowDirection = "in" | "out";

export interface FlowRibbonOptions {
  /** Called when the band settles into (or leaves) its quiet carrier state. */
  onIdleChange?: (idle: boolean) => void;
}

interface Packet { dir: FlowDirection; distance: number; speed: number; lane: number; length: number; brightness: number }

const DIRECTIONS: readonly FlowDirection[] = ["in", "out"];
/** Band palette, client edge (left) -> server edge (right). Keep in sync with .flow-direction-* in liquid-glass.css. */
const BAND_STOPS: ReadonlyArray<readonly [number, string]> = [[0, "#3cc8ff"], [0.32, "#4a92ff"], [0.62, "#6a6dff"], [1, "#b26bff"]];
const PACKET_HEAD: Record<FlowDirection, string> = { in: "#d8f6ff", out: "#efe2ff" };
const PACKET_TAIL: Record<FlowDirection, string> = { in: "rgba(60, 200, 255, 0)", out: "rgba(178, 107, 255, 0)" };
/** Tip fade, top -> bottom: tall bars dissolve towards the pipe walls. */
const TIP_FADE: ReadonlyArray<readonly [number, number]> = [[0, 0], [0.1, 0.18], [0.3, 0.8], [0.5, 1], [0.7, 0.8], [0.9, 0.18], [1, 0]];
/** Bar brightness tiers by relative height: quiet / medium / loud. */
const TIER_ALPHA = [0.4, 0.68, 0.95] as const;

const BAR_PITCH = 4;
const BAR_WIDTH = 2;
const GLOW_WIDTH = 5;
const SAMPLE_STEP = 2;
/** Time a swell needs to cross the whole pipe. */
const CROSSING_SECONDS = 3.4;
const ATTACK_SECONDS = 0.3;
const RELEASE_SECONDS = 0.95;
const POWER_SECONDS = 0.8;
/** No snapshot for this long -> the stream is treated as stopped and the band releases. */
const STALE_MS = 1800;
const IDLE_DELAY_MS = 400;
/** Envelope below this reads as "no traffic" (the band is only a faint tail by then). */
const IDLE_PEAK = 0.05;
/** Bars are hidden under the edge nodes and reach full opacity a bit further in. */
const EDGE_HIDDEN = 40;
const EDGE_SOLID = 92;
/** The soft body under the bars is painted at 1/BODY_SCALE resolution; upscaling blurs it for free. */
const BODY_SCALE = 5;
const BODY_ALPHA = 0.34;
const MAX_PACKETS = 56;
const MIN_LEVEL = 0.12;
const FULL_SCALE_BYTES = 4 * 1024 * 1024;
/** The quiet carrier needs no 60 fps. */
const IDLE_FRAME_MS = 1000 / 30;
const TAU = Math.PI * 2;

/** Bytes per second -> band thickness 0..1 (log scale; any traffic is at least a visible thread). */
export function levelOf(bytesPerSecond: number): number {
  if (!(bytesPerSecond > 0)) return 0;
  const scaled = Math.log1p(bytesPerSecond / 256) / Math.log1p(FULL_SCALE_BYTES / 256);
  return MIN_LEVEL + (1 - MIN_LEVEL) * Math.min(1, scaled);
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smoothstep = (from: number, to: number, value: number) => { const k = clamp01((value - from) / (to - from)); return k * k * (3 - 2 * k); };
const random = (min: number, max: number) => min + Math.random() * (max - min);
const currentDpr = () => Math.min(3, window.devicePixelRatio || 1);

function hash(index: number): number {
  let x = Math.imul(index | 0, 0x27d4eb2d) ^ 0x165667b1;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}
/** Smooth 1-D value noise in [0, 1): neighbouring bars differ, yet every bar changes continuously. */
function noise(u: number, seed: number): number {
  const i = Math.floor(u);
  const f = u - i;
  const a = hash(i + seed * 7919);
  const b = hash(i + 1 + seed * 7919);
  return a + (b - a) * f * f * (3 - 2 * f);
}
/** Swells soften as they travel and are absorbed by the far node. */
const travelFade = (progress: number) => (1 - 0.22 * progress) * (1 - smoothstep(0.88, 1, progress));

/** One direction: an attack/release envelope plus the history that carries it along the pipe. */
class Lane {
  level = 0;
  target = 0;
  private buffer = new Float32Array(4);
  private head = 0;
  /** Distance travelled since the newest sample was written (0 .. SAMPLE_STEP). */
  private travelled = 0;

  resize(pathLength: number): void {
    const size = Math.ceil(pathLength / SAMPLE_STEP) + 4;
    if (size === this.buffer.length) return;
    const next = new Float32Array(size);
    for (let k = 0; k < Math.min(size, this.buffer.length); k++) next[k] = this.at(k);
    this.buffer = next;
    this.head = 0;
  }

  step(dt: number, speed: number): void {
    const tau = this.target > this.level ? ATTACK_SECONDS : RELEASE_SECONDS;
    this.level += (this.target - this.level) * (1 - Math.exp(-dt / tau));
    if (this.target === 0 && this.level < 1e-4) this.level = 0;
    this.travelled += speed * dt;
    const size = this.buffer.length;
    while (this.travelled >= SAMPLE_STEP) {
      this.travelled -= SAMPLE_STEP;
      this.head = (this.head - 1 + size) % size;
      this.buffer[this.head] = this.level;
    }
  }

  /** Envelope at `distance` px from this lane's entry edge, linearly interpolated. */
  sample(distance: number): number {
    if (distance <= this.travelled) {
      const newest = this.at(0);
      return this.travelled > 0 ? this.level + (newest - this.level) * (distance / this.travelled) : newest;
    }
    const u = (distance - this.travelled) / SAMPLE_STEP;
    const k = Math.floor(u);
    const f = u - k;
    return this.at(k) * (1 - f) + this.at(k + 1) * f;
  }

  /** Steady state for the static (no-motion) rendering. */
  fill(value: number): void {
    this.level = value;
    this.buffer.fill(value);
    this.travelled = 0;
  }

  private at(k: number): number {
    const size = this.buffer.length;
    return this.buffer[(this.head + Math.min(k, size - 1)) % size] ?? 0;
  }
}

export class FlowRibbonEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly host: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly body: HTMLCanvasElement;
  private readonly bodyCtx: CanvasRenderingContext2D;
  private readonly onIdleChange: ((idle: boolean) => void) | undefined;
  private readonly lanes: Record<FlowDirection, Lane> = { in: new Lane(), out: new Lane() };
  private readonly spawnBudget: Record<FlowDirection, number> = { in: 0.6, out: 0.6 };
  private readonly glow: Record<FlowDirection, number> = { in: -1, out: -1 };
  private packets: Packet[] = [];
  private envelope = new Float32Array(0);
  private width = 0;
  private height = 0;
  private dpr = 1;
  private scaleX = 1;
  private scaleY = 1;
  private barStart = 0;
  private bandStroke: CanvasGradient | null = null;
  private bodyFill: CanvasGradient | null = null;
  private tipMask: CanvasGradient | null = null;
  private edgeMask: CanvasGradient | null = null;
  private animated = false;
  private destroyed = false;
  private frame = 0;
  private lastTime = 0;
  private clock = 0;
  /** 0 .. 1: how awake the carrier is (dim while the server is offline, eases in on start). */
  private power = 0;
  private powerTarget = 0.35;
  private lastSampleAt = 0;
  private idle = true;
  private quietSince = 0;

  constructor(canvas: HTMLCanvasElement, host: HTMLElement, options: FlowRibbonOptions = {}) {
    const ctx = canvas.getContext("2d");
    const body = document.createElement("canvas");
    const bodyCtx = body.getContext("2d");
    if (!ctx || !bodyCtx) throw new Error("Canvas 2D is not available");
    this.canvas = canvas;
    this.host = host;
    this.ctx = ctx;
    this.body = body;
    this.bodyCtx = bodyCtx;
    this.onIdleChange = options.onIdleChange;
  }

  /** One monitoring snapshot: payload bytes received / sent during the last second. */
  setTraffic(received: number, sent: number): void {
    this.lanes.in.target = levelOf(received);
    this.lanes.out.target = levelOf(sent);
    this.lastSampleAt = performance.now();
    if (!this.animated) this.paintStatic();
  }

  /** Snapshots stopped (server down, monitoring reset): let the band release. */
  clearTraffic(): void {
    this.lanes.in.target = 0;
    this.lanes.out.target = 0;
    this.lastSampleAt = 0;
    if (!this.animated) this.paintStatic();
  }

  setRunning(running: boolean): void {
    this.powerTarget = running ? 1 : 0.35;
    if (!this.animated) this.paintStatic();
  }

  setAnimated(animated: boolean): void {
    if (this.destroyed) return;
    this.animated = animated;
    if (!animated) { this.stop(); this.paintStatic(); return; }
    if (!this.frame) { this.lastTime = 0; this.frame = requestAnimationFrame(this.tick); }
  }

  resize(): void {
    if (this.destroyed) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const dpr = currentDpr();
    if (width < 1 || height < 1) return;
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.scaleX = this.canvas.width / width;
    this.scaleY = this.canvas.height / height;
    this.body.width = Math.max(1, Math.ceil(width / BODY_SCALE));
    this.body.height = Math.max(1, Math.ceil(height / BODY_SCALE));
    const count = Math.max(0, Math.floor((width - 1) / BAR_PITCH));
    this.envelope = new Float32Array(count);
    this.barStart = Math.round((width - (count - 1) * BAR_PITCH) / 2);
    this.lanes.in.resize(width);
    this.lanes.out.resize(width);
    this.buildPaint();
    if (this.animated) this.draw(); else this.paintStatic();
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
  }

  private readonly tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick);
    if (this.idle && this.lastTime && now - this.lastTime < IDLE_FRAME_MS) return;
    const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 1 / 60;
    this.lastTime = now;
    if (currentDpr() !== this.dpr) this.resize();
    this.update(dt, now);
    const peak = this.draw();
    this.trackIdle(peak, now);
    this.publishGlow();
  };

  private stop(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private update(dt: number, now: number): void {
    if (this.lastSampleAt && now - this.lastSampleAt > STALE_MS) { this.lanes.in.target = 0; this.lanes.out.target = 0; }
    this.clock += dt;
    this.power += (this.powerTarget - this.power) * (1 - Math.exp(-dt / POWER_SECONDS));
    const speed = this.width / CROSSING_SECONDS;
    for (const dir of DIRECTIONS) {
      const lane = this.lanes[dir];
      lane.step(dt, speed);
      if (lane.target > 0) {
        // Packet rate follows the envelope, so the first packets lead the swell in.
        this.spawnBudget[dir] += (1.2 + 10 * lane.level) * dt;
        while (this.spawnBudget[dir] >= 1) {
          this.spawnBudget[dir] -= 1;
          if (this.packets.length < MAX_PACKETS) this.packets.push(this.makePacket(dir, speed, lane.level));
        }
      } else {
        this.spawnBudget[dir] = 0.6;
      }
    }
    // Packets are never cut: each one leaves only after it has crossed the pipe.
    const limit = this.width + 24;
    let kept = 0;
    for (const packet of this.packets) {
      packet.distance += packet.speed * dt;
      if (packet.distance < limit + packet.length) this.packets[kept++] = packet;
    }
    this.packets.length = kept;
  }

  private makePacket(dir: FlowDirection, speed: number, level: number): Packet {
    return { dir, distance: random(-16, 0), speed: speed * random(1.15, 1.65), lane: random(-0.85, 0.85), length: random(14, 30) * (0.75 + level), brightness: random(0.65, 1) };
  }

  private buildPaint(): void {
    const { ctx, bodyCtx, width: w, height: h } = this;
    const horizontal = (target: CanvasRenderingContext2D) => {
      const gradient = target.createLinearGradient(0, 0, w, 0);
      for (const [offset, color] of BAND_STOPS) gradient.addColorStop(offset, color);
      return gradient;
    };
    this.bandStroke = horizontal(ctx);
    this.bodyFill = horizontal(bodyCtx);
    const tip = ctx.createLinearGradient(0, 0, 0, h);
    for (const [offset, alpha] of TIP_FADE) tip.addColorStop(offset, `rgba(0, 0, 0, ${alpha})`);
    this.tipMask = tip;
    const hidden = Math.min(0.3, EDGE_HIDDEN / w);
    const solid = Math.min(0.48, Math.max(hidden + 0.01, EDGE_SOLID / w));
    const edge = ctx.createLinearGradient(0, 0, w, 0);
    const stops: Array<[number, number]> = [[0, 0], [hidden, 0], [(hidden + solid) / 2, 0.3], [solid, 1], [1 - solid, 1], [1 - (hidden + solid) / 2, 0.3], [1 - hidden, 0], [1, 0]];
    for (const [offset, alpha] of stops) edge.addColorStop(offset, `rgba(0, 0, 0, ${alpha})`);
    this.edgeMask = edge;
  }

  /** Paints one frame and returns the loudest envelope value (0 .. 1). */
  private draw(): number {
    const { ctx, width: w, height: h, bandStroke, tipMask, edgeMask } = this;
    const count = this.envelope.length;
    if (!w || !h || !count || !bandStroke || !tipMask || !edgeMask) return 0;
    const cy = h / 2;
    const maxHalf = cy - 6;
    const t = this.clock;
    const speed = w / CROSSING_SECONDS;
    const presence = 0.5 + 0.5 * this.power;
    const breathing = this.power * (0.85 + 0.15 * Math.sin(t * 1.3));
    const tiers = [new Path2D(), new Path2D(), new Path2D()] as const;
    let peak = 0;

    for (let i = 0; i < count; i++) {
      const x = this.barStart + i * BAR_PITCH;
      const progress = x / w;
      const aIn = this.lanes.in.sample(x) * travelFade(progress);
      const aOut = this.lanes.out.sample(w - x) * travelFade(1 - progress);
      const a = 1 - (1 - aIn) * (1 - aOut);
      this.envelope[i] = a;
      if (a > peak) peak = a;
      // Quiet carrier: a faint, slowly drifting thread that keeps the pipe alive.
      let half = breathing * (1 + 1.6 * noise(x / 9 - t * 0.7, 5));
      const weight = aIn + aOut;
      if (weight > 1e-4) {
        // Fine texture drifts with each direction, coarse clusters ride at the flow speed.
        const textureIn = 0.6 * noise(x / 5.5 - t * 6, 1) + 0.4 * noise((x - speed * t) / 36, 2);
        const textureOut = 0.6 * noise(x / 5.5 + t * 6, 3) + 0.4 * noise((x + speed * t) / 36, 4);
        // Contrast stretch: the sum of two noises hugs 0.5, a waveform needs real peaks and valleys.
        const texture = 0.14 + 0.86 * smoothstep(0.16, 0.9, (aIn * textureIn + aOut * textureOut) / weight);
        half = Math.max(half, a * maxHalf * texture);
      }
      const relative = half / maxHalf;
      const path = tiers[relative < 0.2 ? 0 : relative < 0.5 ? 1 : 2];
      path.moveTo(x, cy - half);
      path.lineTo(x, cy + half);
    }

    ctx.setTransform(this.scaleX, 0, 0, this.scaleY, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);

    // Bars: a faint glow pass and a crisp core pass per brightness tier.
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.strokeStyle = bandStroke;
    for (let tier = 0; tier < tiers.length; tier++) {
      const path = tiers[tier as 0 | 1 | 2];
      const alpha = TIER_ALPHA[tier as 0 | 1 | 2] * presence;
      ctx.lineWidth = GLOW_WIDTH;
      ctx.globalAlpha = alpha * 0.1;
      ctx.stroke(path);
      ctx.lineWidth = BAR_WIDTH;
      ctx.globalAlpha = alpha;
      ctx.stroke(path);
    }
    // Centre thread brightens with traffic.
    ctx.lineWidth = 1;
    ctx.globalAlpha = (0.14 + 0.42 * peak) * presence;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.stroke();

    ctx.globalCompositeOperation = "destination-in";
    ctx.globalAlpha = 1;
    ctx.fillStyle = tipMask;
    ctx.fillRect(0, 0, w, h);

    // Soft body of the band, behind the bars: this is what visibly widens with volume.
    if (peak > 0.002) {
      this.paintBody(cy, maxHalf);
      ctx.globalCompositeOperation = "destination-over";
      ctx.globalAlpha = BODY_ALPHA * presence;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.body, 0, 0, w, h);
    }

    if (this.packets.length) {
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 1.5;
      for (const packet of this.packets) {
        const progress = packet.distance / w;
        const fade = smoothstep(0.02, 0.1, progress) * (1 - smoothstep(0.84, 0.97, progress)) * packet.brightness;
        if (fade <= 0.001) continue;
        const sign = packet.dir === "in" ? 1 : -1;
        const x = packet.dir === "in" ? packet.distance : w - packet.distance;
        const index = Math.min(count - 1, Math.max(0, Math.round((x - this.barStart) / BAR_PITCH)));
        const y = cy + packet.lane * (1.5 + (this.envelope[index] ?? 0) * maxHalf * 0.55);
        const tail = x - sign * packet.length;
        const streak = ctx.createLinearGradient(tail, y, x, y);
        streak.addColorStop(0, PACKET_TAIL[packet.dir]);
        streak.addColorStop(1, PACKET_HEAD[packet.dir]);
        ctx.strokeStyle = streak;
        ctx.globalAlpha = fade * 0.85;
        ctx.beginPath();
        ctx.moveTo(tail, y);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.fillStyle = PACKET_HEAD[packet.dir];
        ctx.globalAlpha = fade * 0.18;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = fade;
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, TAU);
        ctx.fill();
      }
    }

    // Dissolve both ends under the edge nodes.
    ctx.globalCompositeOperation = "destination-in";
    ctx.globalAlpha = 1;
    ctx.fillStyle = edgeMask;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    return peak;
  }

  private paintBody(cy: number, maxHalf: number): void {
    const { bodyCtx: b, body, width: w, height: h, bodyFill } = this;
    if (!bodyFill) return;
    const count = this.envelope.length;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, body.width, body.height);
    b.setTransform(body.width / w, 0, 0, body.height / h, 0, 0);
    b.beginPath();
    b.moveTo(this.barStart, cy);
    for (let i = 0; i < count; i++) b.lineTo(this.barStart + i * BAR_PITCH, cy - (this.envelope[i] ?? 0) * maxHalf * 0.9);
    for (let i = count - 1; i >= 0; i--) b.lineTo(this.barStart + i * BAR_PITCH, cy + (this.envelope[i] ?? 0) * maxHalf * 0.9);
    b.closePath();
    b.fillStyle = bodyFill;
    b.fill();
  }

  private trackIdle(peak: number, now: number): void {
    // The caption fades in while the last tail dissolves; trailing packets may still finish their trip.
    const quiet = peak < IDLE_PEAK && this.lanes.in.target === 0 && this.lanes.out.target === 0;
    if (!quiet) { this.quietSince = 0; this.setIdle(false); return; }
    if (!this.quietSince) this.quietSince = now;
    if (now - this.quietSince >= IDLE_DELAY_MS) this.setIdle(true);
  }

  private setIdle(idle: boolean): void {
    if (idle === this.idle) return;
    this.idle = idle;
    this.onIdleChange?.(idle);
  }

  /** Edge nodes glow with their direction's envelope (CSS vars --flow-in / --flow-out). */
  private publishGlow(): void {
    for (const dir of DIRECTIONS) {
      const value = Math.round(this.lanes[dir].level * 200) / 200;
      if (value === this.glow[dir]) continue;
      this.glow[dir] = value;
      this.host.style.setProperty(dir === "in" ? "--flow-in" : "--flow-out", String(value));
    }
  }

  private paintStatic(): void {
    for (const dir of DIRECTIONS) this.lanes[dir].fill(this.lanes[dir].target);
    this.packets = [];
    this.clock = 0;
    this.power = this.powerTarget;
    this.draw();
    this.publishGlow();
    this.setIdle(this.lanes.in.target === 0 && this.lanes.out.target === 0);
  }
}
