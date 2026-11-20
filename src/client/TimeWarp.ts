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
import {
  GHOST_MARK_TICKS,
  PARADOX_MARK_TICKS,
  PAST_VIEW_MAX_SECONDS,
} from "../core/game/TimeWarp";
import { FogOfWar } from "./FogOfWar";
import { OWNER_MASK } from "./render/gl/utils/TileCodec";
import type { FrameData, UnitState } from "./render/types";
import type { GameView } from "./view";

/** Max delta entries kept (8 bytes each: 16 MB). */
const LOG_CAPACITY = 1 << 21;
const MAX_TICKS = PAST_VIEW_MAX_SECONDS * 10;
/** Observers (dead players, spectators) look back further. */
export const OBSERVER_MAX_SECONDS = 60;
const SNAPSHOT_EVERY = 20; // ticks between unit snapshots
const FORECAST_TICKS = 100; // 10 s
const FORECAST_EVERY = 5; // ticks between forecast recomputes
// Branches of the forecast: the attack at this share of its current speed
const BRANCH_SLOW = 0.6;
const BRANCH_FAST = 1.4;
const RATE_TICKS = 30; // attack speed measured over the last 3 s
// Forecast image cell, in tiles: 2 on normal maps, 4 on huge ones (over 4M
// tiles, e.g. Giant World Map or big TeamStats maps) to keep the image small
const cellFor = (w: number, h: number): number => (w * h > 4_000_000 ? 4 : 2);
// One tick changing more tiles than this restarts the history instead of
// filling the whole log with one tick
const MAX_TICK_CHANGES = LOG_CAPACITY >> 2;

// Unit types kept in past snapshots (trade ships and trains are left out:
// many of them, and they say little about the war)
const NUKE_UNITS = new Set<string>([
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
]);

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
  troops: number;
  /** Observer: one of the biggest boats, labelled */
  watch: boolean;
  path: number[]; // remaining tiles (sampled)
  land: number; // landing tile
  etaS: number;
  mine: boolean;
  hostile: boolean; // heading for your (or a friend's) land, not yours
}

/** Something that happened, for the timeline (tick = when). */
export interface TimeEvent {
  tick: number;
  icon: string;
  text: string;
  /** "me" = about you, "foe" = against you, "info" = elsewhere */
  tone: "me" | "foe" | "info";
}

export interface MapMarker {
  x: number;
  y: number;
  text: string;
  color: string;
  /** Ring radius in tiles (0 = none). */
  ring: number;
}

export interface FrontForecast {
  incoming: boolean;
  /** Tiles in the likely branch */
  tiles: number;
  /** Tiles in the slow / likely / fast branches of the timeline */
  branches: [number, number, number];
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

  // ── markers ──

  private markersTick = -1;

  /**
   * Delay for an order being sent now (ticks), or 0 when it goes out right
   * away. A one-shot delay switches itself off after one order.
   */
  takeOrderDelay(): number {
    if (this.failed !== null) return 0;
    const d = this.orderDelayTicks;
    if (!this.orderDelaySticky) this.orderDelayTicks = 0;
    return d;
  }

  /** Ticks of history kept: more for observers (see setObserver). */
  private maxTicks = MAX_TICKS;
  /** True once the local player is dead, or for spectators. */
  observer = false;
  /** Observer: the player whose forecast is shown (null = every big war). */
  observerFocus: number | null = null;

  /** Seconds the past view can reach at most right now. */
  maxSeconds(): number {
    return this.maxTicks / 10;
  }

  private updateObserver(gameView: GameView): void {
    const me = gameView.myPlayer();
    const obs =
      !gameView.inSpawnPhase() &&
      (me === null || (!me.isAlive() && me.hasSpawned()));
    if (obs === this.observer) return;
    this.observer = obs;
    this.maxTicks = obs ? OBSERVER_MAX_SECONDS * 10 : MAX_TICKS;
  }

  /** Past events for the timeline, oldest first. */
  events: TimeEvent[] = [];
  private seenAttacks = new Set<string>();
  private echoSeen = new Map<number, number>();
  private ghostSeen = new Map<number, number>();
  private loopSeen = new Map<number, number>();
  private paradoxSeen = new Map<number, number>();
  private ordersSeen = new Set<number>();

  pushEvent(e: TimeEvent): void {
    this.events.push(e);
    const min = e.tick - this.maxTicks;
    while (this.events.length > 0 && this.events[0].tick < min) {
      this.events.shift();
    }
    if (this.events.length > 200) this.events.shift();
  }

  /** Watches the game for the timeline's past events. */
  private trackEvents(gameView: GameView, tick: number): void {
    const me = gameView.myPlayer();
    if (me !== null) {
      const now = new Set<string>();
      for (const a of me.incomingAttacks()) {
        now.add(a.id);
        if (!this.seenAttacks.has(a.id)) {
          const p = gameView.playerBySmallID(a.attackerID);
          this.pushEvent({
            tick,
            icon: "⚔",
            text: `${p.isPlayer() ? p.displayName() : "?"} → you`,
            tone: "foe",
          });
        }
      }
      for (const a of me.outgoingAttacks()) {
        now.add(a.id);
        if (!this.seenAttacks.has(a.id)) {
          const p = gameView.playerBySmallID(a.targetID);
          this.pushEvent({
            tick,
            icon: "⚔",
            text: `you → ${p.isPlayer() ? p.displayName() : "land"}`,
            tone: "me",
          });
        }
      }
      this.seenAttacks = now;
      const orders = new Set(me.delayedOrders().map((o) => o.id));
      for (const id of this.ordersSeen) {
        if (!orders.has(id)) {
          this.pushEvent({ tick, icon: "⏱", text: "order fired", tone: "me" });
        }
      }
      this.ordersSeen = orders;
    }
    if (tick % 5 !== 0) return;
    for (const p of gameView.playerViews()) {
      const n = p.echoUses();
      const before = this.echoSeen.get(p.smallID()) ?? 0;
      if (n > before) {
        const mine = me !== null && p.smallID() === me.smallID();
        this.pushEvent({
          tick,
          icon: "⌛",
          text: `${mine ? "you" : p.displayName()}: Time Echo`,
          tone: mine ? "me" : "info",
        });
      }
      this.echoSeen.set(p.smallID(), n);
      const gN = p.ghostUses();
      if (gN > (this.ghostSeen.get(p.smallID()) ?? 0)) {
        const g = p.lastGhost();
        const mine = me !== null && p.smallID() === me.smallID();
        const onMe = me !== null && g !== null && g.target === me.smallID();
        this.pushEvent({
          tick,
          icon: "👻",
          text: `${mine ? "your" : p.displayName() + "'s"} ghost army`,
          tone: mine ? "me" : onMe ? "foe" : "info",
        });
      }
      this.ghostSeen.set(p.smallID(), gN);
      const lN = p.loopUses();
      if (lN > (this.loopSeen.get(p.smallID()) ?? 0)) {
        const mine = me !== null && p.smallID() === me.smallID();
        this.pushEvent({
          tick,
          icon: "🔁",
          text: `${mine ? "you" : p.displayName()}: Time Loop`,
          tone: mine ? "me" : "info",
        });
      }
      this.loopSeen.set(p.smallID(), lN);
      const px = p.lastParadox();
      if (
        px !== null &&
        px.tick !== (this.paradoxSeen.get(p.smallID()) ?? -1)
      ) {
        const other = gameView.playerBySmallID(px.other);
        const otherName = other.isPlayer() ? other.displayName() : "?";
        const involved =
          me !== null &&
          (p.smallID() === me.smallID() || px.other === me.smallID());
        this.pushEvent({
          tick,
          icon: "⚡",
          text: `paradox ${p.displayName()} vs ${otherName}: ${px.won ? p.displayName() : otherName} wins`,
          tone: involved ? "foe" : "info",
        });
      }
      if (px !== null) this.paradoxSeen.set(p.smallID(), px.tick);
    }
  }

  /** Tiles the player lost to others in the last `seconds` (shown log). */
  lostRecently(smallID: number, seconds: number): number {
    let n = 0;
    const since = this.lastTick - seconds * 10;
    for (let gi = this.groups.length - 1; gi >= 0; gi--) {
      const g = this.groups[gi];
      if (g.tick < since) break;
      for (let p = g.start; p < g.end; p++) {
        const i = p & (LOG_CAPACITY - 1);
        if (
          (this.logOld[i] & OWNER_MASK) === smallID &&
          (this.logNew[i] & OWNER_MASK) !== smallID &&
          (this.logNew[i] & OWNER_MASK) !== 0
        ) {
          n++;
        }
      }
    }
    return n;
  }

  private computeMarkers(gameView: GameView, tick: number): void {
    this.updateObserver(gameView);
    this.trackEvents(gameView, tick);
    const out: MapMarker[] = [];
    const me = gameView.myPlayer();
    if (me !== null && me.isAlive()) {
      for (const o of me.delayedOrders()) {
        const left = Math.max(0, Math.ceil((o.fireTick - tick) / 10));
        let x = -1;
        let y = -1;
        if (o.tile >= 0) {
          x = o.tile % this.w;
          y = (o.tile / this.w) | 0;
        } else {
          const who =
            o.target > 0 ? gameView.playerBySmallID(o.target) : (me as never);
          const loc = (
            who as { nameLocation?: () => { x: number; y: number } | undefined }
          ).nameLocation?.();
          if (loc) {
            x = loc.x;
            y = loc.y;
          }
        }
        if (x < 0) continue;
        const icon =
          o.kind === "attack"
            ? "⚔"
            : o.kind === "boat"
              ? "⛵"
              : NUKE_UNITS.has(o.unit)
                ? "☢"
                : "🏗";
        out.push({
          x,
          y,
          text: `⏱ ${left}s ${icon}`,
          color: "rgba(255,215,90,1)",
          ring: o.kind === "attack" ? 0 : 3,
        });
      }
    }
    // Ghost armies of every player, for a few seconds where they rose
    for (const p of gameView.playerViews()) {
      const g = p.lastGhost();
      if (g === null || tick - g.tick > GHOST_MARK_TICKS) continue;
      if (FogOfWar.current?.hidesTile(g.tile)) continue;
      out.push({
        x: g.tile % this.w,
        y: (g.tile / this.w) | 0,
        text: `👻 ${p.displayName()}`,
        color: "rgba(196,181,253,1)",
        ring: 8,
      });
    }
    // Paradoxes: an unstable field where two timelines clashed
    for (const p of gameView.playerViews()) {
      const px = p.lastParadox();
      if (px === null || tick - px.tick > PARADOX_MARK_TICKS) continue;
      if (FogOfWar.current?.hidesTile(px.tile)) continue;
      const other = gameView.playerBySmallID(px.other);
      const winner = px.won
        ? p.displayName()
        : other.isPlayer()
          ? other.displayName()
          : "?";
      out.push({
        x: px.tile % this.w,
        y: (px.tile / this.w) | 0,
        text: `⚡ Paradox: ${winner}`,
        color: "rgba(250,204,21,1)",
        ring: 6 + ((tick - px.tick) % 10),
      });
    }
    if (out.length > 0 || this.markers.length > 0) this.markersDirty = true;
    this.markers = out;
  }

  // ── forecast ──
  forecastOn = true;
  private readonly cell: number;
  private readonly fcCw: number;
  private readonly fcCh: number;
  private readonly fcCells: Uint8Array; // 0 none, 1 loss, 2 gain
  private readonly fcImage: HTMLCanvasElement;
  private readonly fcData: ImageData;
  private fcDirty = true;
  /** Labels on the map: own delayed orders, ghosts, paradoxes (tile x/y). */
  markers: MapMarker[] = [];
  private markersDirty = false;
  /** Delay (ticks) put on the next attack / boat / build; 0 = off. */
  orderDelayTicks = 0;
  /** Keep the delay for every order, not just the next one. */
  orderDelaySticky = false;
  boats: BoatForecast[] = [];
  fronts: FrontForecast[] = [];
  private attackTracks = new Map<string, AttackTrack>();
  private readonly bfsMark: Uint16Array;
  private bfsStamp = 0;

  private overlay: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private lastCam = "";

  /**
   * Set when something in here threw: 4D views switch off for the rest of
   * the game (the map shows live again) instead of stopping the game. The
   * Time Echo is part of the simulation and keeps working.
   */
  failed: string | null = null;

  /** Milliseconds spent in record + view + forecast, last 100 ticks (perf). */
  readonly perf = { recordMs: 0, viewMs: 0, forecastMs: 0, ticks: 0 };

  constructor(
    private readonly w: number,
    private readonly h: number,
  ) {
    this.shadow = new Uint16Array(w * h);
    this.viewBuf = new Uint16Array(0); // allocated on first look back
    this.cell = cellFor(w, h);
    this.fcCw = Math.ceil(w / this.cell);
    this.fcCh = Math.ceil(h / this.cell);
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
    const ticks = Math.max(
      0,
      Math.min(this.maxTicks, Math.round(seconds * 10)),
    );
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
    if (this.failed !== null) return frame;
    try {
      return this.filterUnsafe(gameView, frame);
    } catch (e) {
      this.fail(e);
      // Back to the live map with one full upload
      return { ...frame, changedTiles: null, structuresDirty: true };
    }
  }

  /** Turns the 4D views off after an error (see `failed`). */
  fail(e: unknown): void {
    if (this.failed !== null) return;
    this.failed = String(e instanceof Error ? e.message : e);
    console.error("OpenFront 4D view turned off after an error:", e);
    this.offsetTicks = 0;
    this.boats = [];
    this.fronts = [];
    this.lastCam = "";
  }

  private filterUnsafe(gameView: GameView, frame: FrameData): FrameData {
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
    if (frame.tick !== this.markersTick) {
      this.markersTick = frame.tick;
      this.computeMarkers(gameView, frame.tick);
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
    } else if (
      frame.changedTiles !== null &&
      frame.changedTiles.length > MAX_TICK_CHANGES
    ) {
      this.resetHistory(tiles, tick);
      return;
    } else if (frame.changedTiles === null) {
      for (let i = 0; i < tiles.length; i++) {
        if (this.shadow[i] !== tiles[i]) this.push(i, tiles[i]);
        if (this.writePos - g.start > MAX_TICK_CHANGES) {
          this.resetHistory(tiles, tick);
          return;
        }
      }
    } else {
      for (const ref of frame.changedTiles) {
        if (this.shadow[ref] !== tiles[ref]) this.push(ref, tiles[ref]);
      }
    }
    g.end = this.writePos;

    // Drop groups that are too old or were overwritten in the ring
    const minTick = tick - this.maxTicks;
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

  /** Forget the history: the map as it is now is the oldest moment. */
  private resetHistory(tiles: Uint16Array, tick: number): void {
    this.shadow.set(tiles);
    this.groups = [{ tick, start: this.writePos, end: this.writePos }];
    this.viewing = false;
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
    const minTick = frame.tick - this.maxTicks - SNAPSHOT_EVERY;
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
    let me = gameView.myPlayer();
    this.boats = [];
    this.fronts = [];
    this.fcCells.fill(0);
    this.fcDirty = true;
    if (gameView.inSpawnPhase()) return;
    // Observer 4D: the followed player's point of view, or every big war
    let everyone = false;
    if (this.observer) {
      me = null;
      if (this.observerFocus !== null) {
        const f = gameView.playerBySmallID(this.observerFocus);
        if (f.isPlayer() && f.isAlive()) me = f;
        else this.observerFocus = null;
      }
      everyone = me === null;
    }
    if (!everyone && (me === null || !me.isAlive())) return;
    const mySID = me === null ? -1 : me.smallID();
    const tiles = frame.tileState;
    const friendly = (sid: number): boolean => {
      if (me === null) return false;
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
        troops: u.troops,
        watch: false,
        mine,
        hostile:
          !friendly(u.ownerID) && targetOwner !== 0 && friendly(targetOwner),
      });
    }

    if (everyone) {
      // Label the 10 biggest boats on their way
      [...this.boats]
        .sort((x, y) => y.troops - x.troops)
        .slice(0, 10)
        .forEach((b) => (b.watch = true));
    }

    // Land fronts: attacks you make or take (observer: the biggest wars)
    const seenAttacks = new Set<string>();
    const attacks =
      me !== null
        ? [
            ...me.outgoingAttacks().map((a) => ({ a, incoming: false })),
            ...me.incomingAttacks().map((a) => ({ a, incoming: true })),
          ]
        : gameView
            .playerViews()
            .filter((p) => p.isAlive())
            .sort((x, y) => y.numTilesOwned() - x.numTilesOwned())
            .slice(0, 12)
            .flatMap((p) => p.outgoingAttacks())
            .filter((a) => a.targetID !== 0)
            .sort((x, y) => y.troops - x.troops)
            .slice(0, 8)
            .map((a) => ({ a, incoming: false }));
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
      // Three branches of the timeline: the attack slows down (defender
      // reinforces), goes on as now, or speeds up (defender weakens)
      const branches: [number, number, number] = [
        Math.round(predicted * BRANCH_SLOW),
        predicted,
        Math.round(predicted * BRANCH_FAST),
      ];
      const res = this.growFront(
        tiles,
        (ref) => gameView.isLand(ref),
        att,
        def,
        frame.tick - RATE_TICKS,
        branches,
        incoming ? 0 : 3,
      );
      if (res.n === 0) continue;
      this.fronts.push({
        incoming,
        tiles: res.reached[1],
        branches: res.reached,
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
    limits: [number, number, number],
    kindBase: number,
  ): {
    n: number;
    sx: number;
    sy: number;
    reached: [number, number, number];
  } {
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
    // Breadth-first order is nearest first: the first limits[0] tiles are
    // reached in every branch, the next ones only in the faster branches
    const limit = limits[2];
    for (let qi = 0; qi < queue.length && n < limit; qi++) {
      const ref = queue[qi];
      const x = ref % w;
      const y = (ref / w) | 0;
      n++;
      sx += x;
      sy += y;
      const level = n <= limits[0] ? 1 : n <= limits[1] ? 2 : 3;
      const c = ((y / this.cell) | 0) * this.fcCw + ((x / this.cell) | 0);
      const old = this.fcCells[c];
      // Keep the surest branch when two fronts share a cell
      if (old === 0 || old > kindBase + level || old <= kindBase) {
        this.fcCells[c] = kindBase + level;
      }
      neighbors(ref, tryAdd);
    }
    const reached: [number, number, number] = [
      Math.min(n, limits[0]),
      Math.min(n, limits[1]),
      n,
    ];
    return { n, sx, sy, reached };
  }

  // ── drawing ──

  drawOverlay(
    glCanvas: HTMLCanvasElement,
    centerX: number,
    centerY: number,
    scale: number,
  ): void {
    // Runs inside the frame loop: an error here must never stop it
    try {
      if (this.failed !== null) {
        this.clearOverlay(glCanvas);
        return;
      }
      this.drawOverlayUnsafe(glCanvas, centerX, centerY, scale);
    } catch (e) {
      this.fail(e);
      try {
        this.clearOverlay(glCanvas);
      } catch {
        // nothing more to do
      }
    }
  }

  private clearOverlay(glCanvas: HTMLCanvasElement): void {
    if (glCanvas.style.filter !== "") glCanvas.style.filter = "";
    if (this.lastCam === "off") return;
    this.lastCam = "off";
    const c = this.overlay;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  }

  private drawOverlayUnsafe(
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
    if (!this.fcDirty && !this.markersDirty && cam === this.lastCam) return;
    this.lastCam = cam;
    this.markersDirty = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const s = scale * dpr;
    const tx = (cssW / 2) * dpr - centerX * s;
    const ty = (cssH / 2) * dpr - centerY * s;
    const show =
      this.forecastOn &&
      !this.isViewingPast() &&
      (this.boats.length > 0 || this.fronts.length > 0);
    if (show) this.drawForecast(ctx, s, tx, ty, dpr);
    else this.fcDirty = false;
    if (!this.isViewingPast()) this.drawMarkers(ctx, s, tx, ty, dpr);
  }

  private drawMarkers(
    ctx: CanvasRenderingContext2D,
    s: number,
    tx: number,
    ty: number,
    dpr: number,
  ): void {
    if (this.markers.length === 0) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `${Math.round(12 * dpr)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (const m of this.markers) {
      const x = (m.x + 0.5) * s + tx;
      const y = (m.y + 0.5) * s + ty;
      if (m.ring > 0) {
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(6 * dpr, m.ring * s), 0, Math.PI * 2);
        ctx.stroke();
      }
      this.label(ctx, m.text, x, y - 8 * dpr, m.color, dpr);
    }
  }

  private drawForecast(
    ctx: CanvasRenderingContext2D,
    s: number,
    tx: number,
    ty: number,
    dpr: number,
  ): void {
    if (this.fcDirty) {
      const px = this.fcData.data;
      for (let i = 0; i < this.fcCells.length; i++) {
        const m = this.fcCells[i];
        const o = i * 4;
        if (m === 0) {
          px[o + 3] = 0;
        } else {
          // 1-3: land you lose (sure → only if they speed up),
          // 4-6: land you take
          const loss = m <= 3;
          const level = loss ? m : m - 3;
          px[o] = loss ? 255 : 80;
          px[o + 1] = loss ? 60 : 230;
          px[o + 2] = loss ? 60 : 255;
          px[o + 3] = level === 1 ? 140 : level === 2 ? 90 : 45;
        }
      }
      this.fcImage.getContext("2d")!.putImageData(this.fcData, 0, 0);
      this.fcDirty = false;
    }
    ctx.setTransform(s, 0, 0, s, tx, ty);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.fcImage,
      0,
      0,
      this.fcCw * this.cell,
      this.fcCh * this.cell,
    );

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
      if (b.mine || b.hostile || b.watch) {
        this.label(ctx, `⚓ ${b.etaS}s`, lx, ly - 6 * dpr, color, dpr);
      }
    }
    for (const f of this.fronts) {
      const [x, y] = [(f.labelX + 0.5) * s + tx, (f.labelY + 0.5) * s + ty];
      const sign = f.incoming ? "−" : "+";
      const [lo, mid, hi] = f.branches;
      const text =
        (lo === hi ? `${sign}${mid}` : `${sign}${lo} / ${mid} / ${hi}`) +
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
