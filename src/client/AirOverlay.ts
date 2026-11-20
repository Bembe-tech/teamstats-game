// TeamStats.Pro "Airports and Planes" (lobby option `airports`), the drawing.
//
// In this mode troop "boats", trade ships and warships are planes (see
// core/game/Airports.ts). UnitPass skips them and this canvas overlay draws
// them instead: owner-colored airplane silhouettes turned to their heading,
// moved smoothly between ticks, with a ground shadow, a fading contrail, the
// landing line of troop planes, fighter gunfire and a puff where a plane is
// shot down. Purely visual: nothing here feeds the simulation.
import { UnitType } from "../core/game/Game";
import { FogOfWar } from "./FogOfWar";
import {
  airplanePath,
  fighterPath,
  transportPlanePath,
} from "./render/gl/utils/Airplane";
import type { GameView, UnitView } from "./view";

const PLANE_TYPES = [
  UnitType.TransportShip,
  UnitType.TradeShip,
  UnitType.Warship,
] as const;

/** Plane length in tiles, by type. */
const LENGTH_TILES: Record<string, number> = {
  [UnitType.TransportShip]: 7,
  [UnitType.TradeShip]: 6,
  [UnitType.Warship]: 5,
};
const SHAPE_LENGTH = 52;
const TRAIL_POINTS = 10;
const PUFF_MS = 700;

interface Track {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  at: number;
  heading: number;
  tile: number;
  trail: { x: number; y: number }[];
  lastTrailAt: number;
  seen: number;
}

export class AirOverlay {
  static current: AirOverlay | null = null;

  private overlay: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private readonly tracks = new Map<number, Track>();
  private readonly puffs: { x: number; y: number; at: number }[] = [];
  private readonly shapes = {
    [UnitType.TransportShip]: transportPlanePath(),
    [UnitType.TradeShip]: airplanePath(),
    [UnitType.Warship]: fighterPath(),
  } as Record<string, Path2D>;
  /** Unit ids some fighter was shooting at in the last frame. */
  private targeted = new Set<number>();
  private frame = 0;
  private wasEmpty = true;

  constructor(
    private readonly game: GameView,
    private readonly tickMs: number,
  ) {}

  drawOverlay(
    glCanvas: HTMLCanvasElement,
    centerX: number,
    centerY: number,
    scale: number,
  ): void {
    if (this.overlay === null) {
      const c = document.createElement("canvas");
      c.style.cssText =
        "position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none";
      glCanvas.insertAdjacentElement("afterend", c);
      this.overlay = c;
      this.ctx = c.getContext("2d");
    }
    const c = this.overlay;
    const ctx = this.ctx;
    if (ctx === null) return;
    const cssW = glCanvas.clientWidth;
    const cssH = glCanvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (
      c.width !== Math.round(cssW * dpr) ||
      c.height !== Math.round(cssH * dpr)
    ) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
    }

    const now = performance.now();
    this.frame++;
    const planes = this.game.units(...PLANE_TYPES);
    if (planes.length === 0 && this.puffs.length === 0) {
      if (!this.wasEmpty) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, c.width, c.height);
        this.wasEmpty = true;
      }
      this.forgetMissing(now);
      return;
    }
    this.wasEmpty = false;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const s = scale * dpr;
    const tx = (cssW / 2) * dpr - centerX * s;
    const ty = (cssH / 2) * dpr - centerY * s;
    const toScreen = (x: number, y: number): [number, number] => [
      (x + 0.5) * s + tx,
      (y + 0.5) * s + ty,
    ];
    const fog = FogOfWar.current;
    const me = this.game.myPlayer();
    const nextTargeted = new Set<number>();
    const positions = new Map<number, [number, number]>();

    // Pass 1: positions, trails and shadows
    const drawn: { u: UnitView; t: Track; sx: number; sy: number }[] = [];
    for (const u of planes) {
      if (!u.isActive()) continue;
      const t = this.track(u, now);
      const k = Math.min(1, (now - t.at) / this.tickMs);
      const wx = t.fromX + (t.toX - t.fromX) * k;
      const wy = t.fromY + (t.toY - t.fromY) * k;
      if (now - t.lastTrailAt > 90) {
        t.trail.push({ x: wx, y: wy });
        if (t.trail.length > TRAIL_POINTS) t.trail.shift();
        t.lastTrailAt = now;
      }
      positions.set(u.id(), [wx, wy]);
      if (fog?.hidesTile(u.tile())) continue;
      const [sx, sy] = toScreen(wx, wy);
      if (sx < -200 || sy < -200 || sx > c.width + 200 || sy > c.height + 200) {
        continue;
      }
      drawn.push({ u, t, sx, sy });
    }

    const size = (u: UnitView) =>
      Math.max(10 * dpr, Math.min(56 * dpr, (LENGTH_TILES[u.type()] ?? 6) * s));

    // Contrails
    ctx.lineCap = "round";
    for (const { u, t } of drawn) {
      if (t.trail.length < 2) continue;
      const w = Math.max(1, size(u) * 0.08);
      for (let i = 1; i < t.trail.length; i++) {
        const [ax, ay] = toScreen(t.trail[i - 1].x, t.trail[i - 1].y);
        const [bx, by] = toScreen(t.trail[i].x, t.trail[i].y);
        ctx.strokeStyle = `rgba(255,255,255,${(0.35 * i) / t.trail.length})`;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    }

    // Landing lines of troop planes (own ones, and ones flying at us)
    ctx.setLineDash([6 * dpr, 6 * dpr]);
    for (const { u, sx, sy } of drawn) {
      if (u.type() !== UnitType.TransportShip) continue;
      const dst = u.targetTile();
      if (dst === undefined) continue;
      const mine = me !== null && u.owner().id() === me.id();
      const atMe =
        me !== null &&
        this.game.owner(dst).isPlayer() &&
        this.game.owner(dst).id() === me.id();
      if (!mine && !atMe) continue;
      const [dx, dy] = toScreen(this.game.x(dst), this.game.y(dst));
      ctx.strokeStyle = atMe ? "rgba(255,80,80,0.8)" : "rgba(255,255,255,0.7)";
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(dx, dy);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(dx, dy, 4 * dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Shadows, then bodies
    for (const { u, t, sx, sy } of drawn) {
      const len = size(u);
      const k = len / SHAPE_LENGTH;
      const off = len * 0.35;
      ctx.setTransform(
        k * Math.cos(t.heading),
        k * Math.sin(t.heading),
        -k * Math.sin(t.heading),
        k * Math.cos(t.heading),
        sx + off,
        sy + off,
      );
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.fill(this.shapes[u.type()]);
    }
    for (const { u, t, sx, sy } of drawn) {
      const len = size(u);
      const k = len / SHAPE_LENGTH;
      ctx.setTransform(
        k * Math.cos(t.heading),
        k * Math.sin(t.heading),
        -k * Math.sin(t.heading),
        k * Math.cos(t.heading),
        sx,
        sy,
      );
      const shape = this.shapes[u.type()];
      ctx.fillStyle = u.owner().territoryColor().toHex();
      ctx.fill(shape);
      ctx.lineWidth = 2.2 / k;
      ctx.strokeStyle = "rgba(15,18,26,0.9)";
      ctx.stroke(shape);
      if (u.type() === UnitType.Warship && u.hasHealth()) {
        // health bar under the fighter, in screen space
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const frac = Math.max(0, Math.min(1, u.health() / 1000));
        if (frac < 1) {
          const w = len * 0.8;
          ctx.fillStyle = "rgba(0,0,0,0.6)";
          ctx.fillRect(sx - w / 2, sy + len * 0.6, w, 3 * dpr);
          ctx.fillStyle =
            frac > 0.5 ? "#5bd16a" : frac > 0.25 ? "#f5b800" : "#ff5b5b";
          ctx.fillRect(sx - w / 2, sy + len * 0.6, w * frac, 3 * dpr);
        }
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Fighter gunfire
    for (const { u, sx, sy } of drawn) {
      if (u.type() !== UnitType.Warship) continue;
      const tid = u.targetUnitId();
      if (tid === undefined) continue;
      const target = positions.get(tid);
      if (target === undefined) continue;
      nextTargeted.add(tid);
      const [txs, tys] = toScreen(target[0], target[1]);
      const d = Math.hypot(txs - sx, tys - sy);
      if (d > 12 * s + 40 * dpr) continue;
      if ((this.frame + u.id()) % 4 < 2) {
        ctx.strokeStyle = "rgba(255,220,90,0.95)";
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([3 * dpr, 4 * dpr]);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(txs, tys);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Puffs where planes went down
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      const k = (now - p.at) / PUFF_MS;
      if (k >= 1) {
        this.puffs.splice(i, 1);
        continue;
      }
      const [px, py] = toScreen(p.x, p.y);
      const r = (4 + 10 * k) * Math.max(dpr, s * 0.6);
      ctx.fillStyle = `rgba(255,${Math.round(180 - 120 * k)},40,${0.85 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(60,60,60,${0.5 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(px + r * 0.3, py - r * 0.4, r * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }

    this.forgetMissing(now);
    this.targeted = nextTargeted;
  }

  private track(u: UnitView, now: number): Track {
    const tile = u.tile();
    const x = this.game.x(tile);
    const y = this.game.y(tile);
    let t = this.tracks.get(u.id());
    if (t === undefined) {
      const last = u.lastTile();
      const lx = this.game.x(last);
      const ly = this.game.y(last);
      t = {
        fromX: x,
        fromY: y,
        toX: x,
        toY: y,
        at: now,
        heading:
          lx === x && ly === y ? 0 : Math.atan2(y - ly, x - lx) + Math.PI / 2,
        tile,
        trail: [],
        lastTrailAt: 0,
        seen: this.frame,
      };
      this.tracks.set(u.id(), t);
    } else if (t.tile !== tile) {
      const k = Math.min(1, (now - t.at) / this.tickMs);
      t.fromX = t.fromX + (t.toX - t.fromX) * k;
      t.fromY = t.fromY + (t.toY - t.fromY) * k;
      t.toX = x;
      t.toY = y;
      t.at = now;
      t.tile = tile;
      if (x !== t.fromX || y !== t.fromY) {
        t.heading = Math.atan2(y - t.fromY, x - t.fromX) + Math.PI / 2;
      }
    }
    t.seen = this.frame;
    return t;
  }

  /** Drops planes that are gone; ones a fighter was shooting at leave a puff. */
  private forgetMissing(now: number): void {
    for (const [id, t] of this.tracks) {
      if (t.seen === this.frame) continue;
      if (this.targeted.has(id)) {
        this.puffs.push({ x: t.toX, y: t.toY, at: now });
      }
      this.tracks.delete(id);
    }
  }

  dispose(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.ctx = null;
    this.tracks.clear();
  }
}
