// TeamStats.Pro "OpenFront 4D" (lobby option `timeWarp`), the client half.
// The simulation half (the Time Echo) is src/core/game/TimeWarp.ts.
//
// Nothing here touches the game: every browser keeps simulating as usual.
// This only changes what the local player is SHOWN:
//   - PAST VIEW: the map as it was up to PAST_VIEW_MAX_SECONDS ago. Every tick
//     the territory changes the player was shown (after Fog of War, so the
//     past never reveals more than you saw) go into a delta log: tile, old
//     value, new value. Looking back copies the current map and undoes the
//     log back to the chosen moment; while the look lasts, the view keeps
//     moving forward with the same delay (a delayed live view). Ships and
//     structures come from small snapshots taken every 2 s. The log has a
//     fixed memory budget (LOG_CAPACITY entries, 8 bytes each): in a huge
//     war the window just gets shorter.
//   - FORECAST: where things get to in FORECAST_TICKS. Transport boats show
//     their remaining path, landing spot and time to land (exact: the game
//     sends their motion plans). Land attacks you make or take show the land
//     that falls in the next 10 s at the current speed, capped by the troops
//     the attack has left; troops lost per tile is measured, not guessed.

import { UnitType } from "../core/game/Game";
import { PAST_VIEW_MAX_SECONDS } from "../core/game/TimeWarp";
import { OWNER_MASK } from "./render/gl/utils/TileCodec";
import type { FrameData, UnitState } from "./render/types";
import type { GameView } from "./view";

/** Max delta entries kept (8 bytes each: 16 MB). */
const LOG_CAPACITY = 1 << 21;
const MAX_TICKS = PAST_VIEW_MAX_SECONDS * 10;
const SNAPSHOT_EVERY = 20; // ticks between unit snapshots
const FORECAST_TICKS = 100; // 10 s
const FORECAST_EVERY = 5; // ticks between forecast recomputes
const RATE_TICKS = 30; // attack speed measured over the last 3 s
const CELL = 2; // forecast image cell, in tiles

// Unit types kept in past snapshots (trade ships and trains are left out:
// many of them, and they say little about the war)
const SNAP_TYPES = new Set<string>([
  UnitType.TransportShip,
  UnitType.Warship,
  UnitType.City,
  UnitType.Port,
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
  UnitType.Factory,
]);

interface TickGroup {
  tick: number;
  start: number; // absolute log position of the first entry
  end: number; // absolute, exclusive
}

interface AttackTrack {
  samples: { tick: number; troops: number; taken: number }[];
}

export interface BoatForecast {
  path: number[]; // remaining tiles (sampled)
  land: number; // landing tile
  etaS: number;
  mine: boolean;
  hostile: boolean; // heading for your (or a friend's) land, not yours
}

export interface FrontForecast {
  incoming: boolean;
  tiles: number;
  endsInS: number | null; // the attack runs out of troops in ~N s
  labelX: number;
  labelY: number;
}

export class TimeWarp {
  /** The running game's 4D state, for the HUD panel. */
  static current: TimeWarp | null = null;

  // ── history ──
  private readonly shadow: Uint16Array; // last shown territory
  private readonly logRef = new Int32Array(LOG_CAPACITY);
  private readonly logOld = new Uint16Array(LOG_CAPACITY);
  private readonly logNew = new Uint16Array(LOG_CAPACITY);
  private writePos = 0; // absolute
  private groups: TickGroup[] = [];
  private snaps: { tick: number; units: Map<number, UnitState> }[] = [];
  private initialized = false;
  private lastTick = -1;

  // ── past view ──
  private offsetTicks = 0; // requested look-back, 0 = live
  private viewing = false;
  private viewBuf: Uint16Array;
  private viewTick = 0;
  private viewSnapTick = -1;
  private needExitUpload = false;

  // ── forecast ──
  forecastOn = true;
  private readonly fcCw: number;
  private readonly fcCh: number;
  private readonly fcCells: Uint8Array; // 0 none, 1 loss, 2 gain
  private readonly fcImage: HTMLCanvasElement;
  private readonly fcData: ImageData;
  private fcDirty = true;
  boats: BoatForecast[] = [];
  fronts: FrontForecast[] = [];
  private attackTracks = new Map<string, AttackTrack>();
  private readonly bfsMark: Uint16Array;
  private bfsStamp = 0;

  private overlay: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private lastCam = "";

  /** Milliseconds spent in record + view + forecast, last 100 ticks (perf). */
  readonly perf = { recordMs: 0, viewMs: 0, forecastMs: 0, ticks: 0 };

  constructor(
    private readonly w: number,
    private readonly h: number,
  ) {
    this.shadow = new Uint16Array(w * h);
    this.viewBuf = new Uint16Array(0); // allocated on first look back
    this.fcCw = Math.ceil(w / CELL);
    this.fcCh = Math.ceil(h / CELL);
    this.fcCells = new Uint8Array(this.fcCw * this.fcCh);
    this.bfsMark = new Uint16Array(w * h);
    this.fcImage = document.createElement("canvas");
    this.fcImage.width = this.fcCw;
    this.fcImage.height = this.fcCh;
    this.fcData = new ImageData(this.fcCw, this.fcCh);
  }

  // ── public API (HUD) ──

  /** Seconds of history the past view can show right now. */
  availableSeconds(): number {
    if (this.groups.length === 0) return 0;
    const oldest = this.groups[0].tick;
    return Math.max(0, Math.floor((this.lastTick - oldest) / 10));
  }

  /** Look `seconds` back (0 = live). */
  setPast(seconds: number): void {
    const ticks = Math.max(0, Math.min(MAX_TICKS, Math.round(seconds * 10)));
    if (ticks === this.offsetTicks) return;
    this.offsetTicks = ticks;
    this.viewing = false; // rebuilt on the next frame
    if (ticks === 0) this.needExitUpload = true;
  }

  pastSeconds(): number {
    return this.offsetTicks / 10;
  }

  isViewingPast(): boolean {
    return this.offsetTicks > 0;
  }

  /** Bytes held by the history (log + shadow + view + snapshots, rough). */
  memoryBytes(): number {
    let units = 0;
    for (const s of this.snaps) units += s.units.size;
    return (
      LOG_CAPACITY * 8 +
      this.shadow.byteLength +
      this.viewBuf.byteLength +
      this.bfsMark.byteLength +
      this.fcCells.byteLength +
      units * 320
    );
  }

  logEntries(): number {
    if (this.groups.length === 0) return 0;
    return this.writePos - this.groups[0].start;
  }

  // ── per tick ──

  /**
   * Called with the frame the renderer is about to get (after Fog of War).
   * Records history and returns the frame to show (the past, while looking
   * back; the frame itself otherwise).
   */
  filter(gameView: GameView, frame: FrameData): FrameData {
    const t0 = performance.now();
    this.record(frame);
    const t1 = performance.now();
    if (
      this.forecastOn &&
      !this.isViewingPast() &&
      frame.tick % FORECAST_EVERY === 0
    ) {
      this.computeForecast(gameView, frame);
    } else if (!this.forecastOn && (this.boats.length || this.fronts.length)) {
      this.clearForecast();
    }
    const t2 = performance.now();
    const out = this.view(frame);
    const t3 = performance.now();
    this.perf.recordMs += t1 - t0;
    this.perf.forecastMs += t2 - t1;
    this.perf.viewMs += t3 - t2;
    this.perf.ticks++;
    return out;
  }

  private record(frame: FrameData): void {
    const tiles = frame.tileState;
    const tick = frame.tick;
    if (tick !== this.lastTick || this.groups.length === 0) {
      this.groups.push({ tick, start: this.writePos, end: this.writePos });
      this.lastTick = tick;
    }
    const g = this.groups[this.groups.length - 1];
    if (!this.initialized) {
      this.shadow.set(tiles);
      this.initialized = true;
    } else if (frame.changedTiles === null) {
      for (let i = 0; i < tiles.length; i++) {
        if (this.shadow[i] !== tiles[i]) this.push(i, tiles[i]);
      }
    } else {
      for (const ref of frame.changedTiles) {
        if (this.shadow[ref] !== tiles[ref]) this.push(ref, tiles[ref]);
      }
    }
    g.end = this.writePos;

    // Drop groups that are too old or were overwritten in the ring
    const minTick = tick - MAX_TICKS;
    const minPos = this.writePos - LOG_CAPACITY;
    let drop = 0;
    while (
      drop < this.groups.length - 1 &&
      (this.groups[drop].tick < minTick || this.groups[drop].start < minPos)
    ) {
      drop++;
    }
    if (drop > 0) this.groups.splice(0, drop);

    if (tick % SNAPSHOT_EVERY === 0) this.snapshotUnits(frame);
  }

  private push(ref: number, value: number): void {
    const i = this.writePos & (LOG_CAPACITY - 1);
    this.logRef[i] = ref;
    this.logOld[i] = this.shadow[ref];
    this.logNew[i] = value;
    this.shadow[ref] = value;
    this.writePos++;
  }

  private snapshotUnits(frame: FrameData): void {
    const units = new Map<number, UnitState>();
    for (const [id, u] of frame.units) {
      if (!u.isActive || !SNAP_TYPES.has(u.unitType)) continue;
      units.set(id, {
        ...u,
        lastPos: u.pos,
        missileTimerQueue: [],
      });
    }
    this.snaps.push({ tick: frame.tick, units });
    const minTick = frame.tick - MAX_TICKS - SNAPSHOT_EVERY;
    while (this.snaps.length > 1 && this.snaps[0].tick < minTick) {
      this.snaps.shift();
    }
  }

  // ── past view ──

  private view(frame: FrameData): FrameData {
    if (this.offsetTicks === 0) {
      if (!this.needExitUpload) return frame;
      this.needExitUpload = false;
      return { ...frame, changedTiles: null, structuresDirty: true };
    }
    const oldest = this.groups.length > 0 ? this.groups[0].tick : frame.tick;
    const target = Math.max(oldest, frame.tick - this.offsetTicks);
    let changed: number[] | null;
    if (!this.viewing) {
      if (this.viewBuf.length === 0)
        this.viewBuf = new Uint16Array(this.w * this.h);
      this.viewBuf.set(this.shadow);
      // Undo every tick newer than the target, newest first
      for (let gi = this.groups.length - 1; gi >= 0; gi--) {
        const g = this.groups[gi];
        if (g.tick <= target) break;
        for (let p = g.end - 1; p >= g.start; p--) {
          const i = p & (LOG_CAPACITY - 1);
          this.viewBuf[this.logRef[i]] = this.logOld[i];
        }
      }
      this.viewing = true;
      this.viewTick = target;
      this.viewSnapTick = -1;
      changed = null;
    } else {
      changed = [];
      for (const g of this.groups) {
        if (g.tick <= this.viewTick) continue;
        if (g.tick > target) break;
        for (let p = g.start; p < g.end; p++) {
          const i = p & (LOG_CAPACITY - 1);
          const ref = this.logRef[i];
          this.viewBuf[ref] = this.logNew[i];
          changed.push(ref);
        }
      }
      this.viewTick = target;
    }

    let snap = this.snaps[0];
    for (const s of this.snaps) if (s.tick <= target) snap = s;
    const units = snap?.units ?? new Map<number, UnitState>();
    const snapChanged = (snap?.tick ?? -1) !== this.viewSnapTick;
    this.viewSnapTick = snap?.tick ?? -1;

    return {
      ...frame,
      tileState: this.viewBuf,
      changedTiles: changed,
      units,
      structuresDirty: changed === null || snapChanged,
      attackRings: [],
      nukeTelegraphs: [],
      events: { deadUnits: [], conquestEvents: [], bonusEvents: [] },
    };
  }

  // ── forecast ──

  private clearForecast(): void {
    this.boats = [];
    this.fronts = [];
    this.fcCells.fill(0);
    this.fcDirty = true;
  }

  private computeForecast(gameView: GameView, frame: FrameData): void {
    const me = gameView.myPlayer();
    this.boats = [];
    this.fronts = [];
    this.fcCells.fill(0);
    this.fcDirty = true;
    if (me === null || !me.isAlive() || gameView.inSpawnPhase()) return;
    const mySID = me.smallID();
    const tiles = frame.tileState;
    const friendly = (sid: number): boolean => {
      if (sid === mySID) return true;
      const p = gameView.playerBySmallID(sid);
      return p.isPlayer() && me.isFriendly(p);
    };

    // Boats: exact remaining path from the motion plans
    const plans = gameView.motionPlans();
    for (const [id, u] of frame.units) {
      if (u.unitType !== UnitType.TransportShip || !u.isActive) continue;
      const plan = plans.get(id);
      if (!plan || plan.path.length < 2) continue;
      const dt = frame.tick - plan.startTick;
      const step = Math.max(1, plan.ticksPerStep);
      const idx = Math.max(
        0,
        Math.min(plan.path.length - 1, Math.floor(dt / step)),
      );
      const last = plan.path.length - 1;
      if (idx >= last) continue;
      const path: number[] = [];
      const stride = Math.max(1, Math.floor((last - idx) / 60));
      for (let k = idx; k < last; k += stride)
        path.push(plan.path[k] as number);
      const land = plan.path[last] as number;
      path.push(land);
      const mine = u.ownerID === mySID;
      // A boat lands next to its target tile; who owns the land around it
      const targetOwner =
        u.targetTile !== null ? tiles[u.targetTile] & OWNER_MASK : 0;
      this.boats.push({
        path,
        land,
        etaS: Math.round(((last - idx) * step) / 10),
        mine,
        hostile:
          !friendly(u.ownerID) && targetOwner !== 0 && friendly(targetOwner),
      });
    }

    // Land fronts: attacks you make or take
    const seenAttacks = new Set<string>();
    const attacks = [
      ...me.outgoingAttacks().map((a) => ({ a, incoming: false })),
      ...me.incomingAttacks().map((a) => ({ a, incoming: true })),
    ];
    for (const { a, incoming } of attacks) {
      if (a.retreating) continue;
      seenAttacks.add(a.id);
      const att = a.attackerID;
      const def = a.targetID; // 0 = unowned land
      const taken = this.countTaken(att, def, frame.tick - RATE_TICKS);
      let track = this.attackTracks.get(a.id);
      if (!track) {
        track = { samples: [] };
        this.attackTracks.set(a.id, track);
      }
      track.samples.push({ tick: frame.tick, troops: a.troops, taken });
      while (
        track.samples.length > 1 &&
        track.samples[0].tick < frame.tick - RATE_TICKS
      ) {
        track.samples.shift();
      }
      if (taken === 0) continue;
      const rate = taken / RATE_TICKS; // tiles per tick
      let predicted = Math.round(rate * FORECAST_TICKS);
      let endsInS: number | null = null;
      // Troops lost per tile, from the troop drop over the same window
      const first = track.samples[0];
      const spanTicks = frame.tick - first.tick;
      if (spanTicks >= 10 && first.troops > a.troops) {
        const lossPerTick = (first.troops - a.troops) / spanTicks;
        const ticksLeft = a.troops / lossPerTick;
        if (ticksLeft < FORECAST_TICKS) {
          predicted = Math.round(rate * ticksLeft);
          endsInS = Math.max(1, Math.round(ticksLeft / 10));
        }
      }
      if (predicted <= 0) continue;
      const res = this.growFront(
        tiles,
        (ref) => gameView.isLand(ref),
        att,
        def,
        frame.tick - RATE_TICKS,
        predicted,
        incoming ? 1 : 2,
      );
      if (res.n === 0) continue;
      this.fronts.push({
        incoming,
        tiles: res.n,
        endsInS,
        labelX: res.sx / res.n,
        labelY: res.sy / res.n,
      });
    }
    for (const id of this.attackTracks.keys()) {
      if (!seenAttacks.has(id)) this.attackTracks.delete(id);
    }
  }

  /** Tiles `att` took from `def` since `sinceTick` (from the shown log). */
  private countTaken(att: number, def: number, sinceTick: number): number {
    let n = 0;
    for (let gi = this.groups.length - 1; gi >= 0; gi--) {
      const g = this.groups[gi];
      if (g.tick < sinceTick) break;
      for (let p = g.start; p < g.end; p++) {
        const i = p & (LOG_CAPACITY - 1);
        if (
          (this.logNew[i] & OWNER_MASK) === att &&
          (this.logOld[i] & OWNER_MASK) === def
        ) {
          n++;
        }
      }
    }
    return n;
  }

  /**
   * Breadth-first from the tiles `att` just took, into `def`'s land, `limit`
   * tiles: the land the front reaches next. Marks forecast cells.
   */
  private growFront(
    tiles: Uint16Array,
    isLand: (ref: number) => boolean,
    att: number,
    def: number,
    sinceTick: number,
    limit: number,
    mark: number,
  ): { n: number; sx: number; sy: number } {
    const w = this.w;
    const h = this.h;
    if (++this.bfsStamp > 0xffff) {
      this.bfsMark.fill(0);
      this.bfsStamp = 1;
    }
    const stamp = this.bfsStamp;
    const queue: number[] = [];
    const tryAdd = (ref: number) => {
      if (this.bfsMark[ref] === stamp) return;
      this.bfsMark[ref] = stamp;
      const v = tiles[ref];
      if ((v & OWNER_MASK) !== def) return;
      // Unowned target: the territory buffer has no terrain, ask the map
      if (def === 0 && !isLand(ref)) return;
      queue.push(ref);
    };
    const neighbors = (ref: number, cb: (r: number) => void) => {
      const x = ref % w;
      const y = (ref / w) | 0;
      if (x > 0) cb(ref - 1);
      if (x < w - 1) cb(ref + 1);
      if (y > 0) cb(ref - w);
      if (y < h - 1) cb(ref + w);
    };
    for (let gi = this.groups.length - 1; gi >= 0; gi--) {
      const g = this.groups[gi];
      if (g.tick < sinceTick) break;
      for (let p = g.start; p < g.end; p++) {
        const i = p & (LOG_CAPACITY - 1);
        if (
          (this.logNew[i] & OWNER_MASK) === att &&
          (this.logOld[i] & OWNER_MASK) === def
        ) {
          neighbors(this.logRef[i], tryAdd);
        }
      }
    }
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let qi = 0; qi < queue.length && n < limit; qi++) {
      const ref = queue[qi];
      const x = ref % w;
      const y = (ref / w) | 0;
      n++;
      sx += x;
      sy += y;
      this.fcCells[((y / CELL) | 0) * this.fcCw + ((x / CELL) | 0)] = mark;
      neighbors(ref, tryAdd);
    }
    return { n, sx, sy };
  }

  // ── drawing ──

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
      this.overlayCtx = c.getContext("2d");
    }
    // The past is shown in sepia, so it can't be mistaken for now
    const filter = this.isViewingPast() ? "sepia(0.75) saturate(0.7)" : "";
    if (glCanvas.style.filter !== filter) glCanvas.style.filter = filter;

    const ctx = this.overlayCtx!;
    const c = this.overlay;
    const cssW = glCanvas.clientWidth;
    const cssH = glCanvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (
      c.width !== Math.round(cssW * dpr) ||
      c.height !== Math.round(cssH * dpr)
    ) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
      this.lastCam = "";
    }
    const cam = `${centerX.toFixed(2)},${centerY.toFixed(2)},${scale.toFixed(4)}`;
    if (!this.fcDirty && cam === this.lastCam) return;
    this.lastCam = cam;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const show =
      this.forecastOn &&
      !this.isViewingPast() &&
      (this.boats.length > 0 || this.fronts.length > 0);
    if (!show) {
      this.fcDirty = false;
      return;
    }
    if (this.fcDirty) {
      const px = this.fcData.data;
      for (let i = 0; i < this.fcCells.length; i++) {
        const m = this.fcCells[i];
        const o = i * 4;
        if (m === 0) {
          px[o + 3] = 0;
        } else if (m === 1) {
          px[o] = 255;
          px[o + 1] = 60;
          px[o + 2] = 60;
          px[o + 3] = 120;
        } else {
          px[o] = 80;
          px[o + 1] = 230;
          px[o + 2] = 255;
          px[o + 3] = 110;
        }
      }
      this.fcImage.getContext("2d")!.putImageData(this.fcData, 0, 0);
      this.fcDirty = false;
    }
    const s = scale * dpr;
    const tx = (cssW / 2) * dpr - centerX * s;
    const ty = (cssH / 2) * dpr - centerY * s;
    ctx.setTransform(s, 0, 0, s, tx, ty);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.fcImage, 0, 0, this.fcCw * CELL, this.fcCh * CELL);

    // Boat paths (screen space, so lines stay thin when zoomed in)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const toScreen = (ref: number): [number, number] => [
      ((ref % this.w) + 0.5) * s + tx,
      (((ref / this.w) | 0) + 0.5) * s + ty,
    ];
    ctx.lineWidth = 1.5 * dpr;
    ctx.font = `${Math.round(12 * dpr)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (const b of this.boats) {
      const color = b.hostile
        ? "rgba(255,80,80,0.95)"
        : b.mine
          ? "rgba(120,255,160,0.9)"
          : "rgba(255,255,255,0.55)";
      ctx.strokeStyle = color;
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.beginPath();
      b.path.forEach((ref, k) => {
        const [x, y] = toScreen(ref);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      const [lx, ly] = toScreen(b.land);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(lx, ly, 4 * dpr, 0, Math.PI * 2);
      ctx.fill();
      if (b.mine || b.hostile) {
        this.label(ctx, `⚓ ${b.etaS}s`, lx, ly - 6 * dpr, color, dpr);
      }
    }
    for (const f of this.fronts) {
      const [x, y] = [(f.labelX + 0.5) * s + tx, (f.labelY + 0.5) * s + ty];
      const text =
        (f.incoming ? `−${f.tiles}` : `+${f.tiles}`) +
        (f.endsInS !== null ? ` · ${f.endsInS}s` : " · 10s");
      this.label(
        ctx,
        `🔮 ${text}`,
        x,
        y,
        f.incoming ? "rgba(255,120,120,1)" : "rgba(140,240,255,1)",
        dpr,
      );
    }
  }

  private label(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color: string,
    dpr: number,
  ): void {
    const wText = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(
      x - wText / 2 - 4 * dpr,
      y - 16 * dpr,
      wText + 8 * dpr,
      17 * dpr,
    );
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
}
