// TeamStats.Pro "OpenFront 4D" (lobby option `timeWarp`): time as the
// fourth dimension.
//
// Two halves:
//   - client only (src/client/TimeWarp.ts): a look at the map as it was up to
//     PAST_VIEW_MAX_SECONDS ago and a forecast of where attacks and boats get
//     to. Nothing there touches the simulation.
//   - the simulation (this file + TimeEchoExecution): the "Time Echo". A
//     player sends a `time_echo` intent, every browser runs it on the same
//     tick, so lockstep stays intact. The echo
//       * gives back the land the player lost in the last ECHO_WINDOW_TICKS,
//         where the player who took it still holds it;
//       * freezes every land attack on the player for ECHO_SHIELD_TICKS
//         (attackers keep their troops, they just make no progress);
//       * costs ECHO_GOLD_PERCENT of the player's gold, at least
//         ECHO_MIN_GOLD; ECHO_MAX_USES per game, ECHO_COOLDOWN_TICKS apart.
//
// Balance (2026-11-19, tests/perf/fullgame/TimeWarpSim.ts, World, 72
// nations, 10 min, 6 seeds each): nations echo ~32 times a game, median 2,100
// tiles back (~35% of their land). With a 5 s freeze, a nation in a crisis
// (20% of its land gone in 8 s) is alive 60 s later 54% of the time vs 52%
// with 4D off, and 3 min later 21% vs 21%; players alive at 10 min 22 vs 22.
// So the echo buys time and a comeback chance without stalling games. An 8 s
// freeze was clearly stronger (60% / 35%, 29 players alive): too much.
// Engine cost: none measurable; ChronoLog peaked at 47k entries per 10 s.

/** Ticks of lost land an echo can give back (10 ticks = 1 s). */
export const ECHO_WINDOW_TICKS = 100;
/** Ticks attacks on the player stay frozen after an echo. */
export const ECHO_SHIELD_TICKS = 50;
/** Echoes per player per game. */
export const ECHO_MAX_USES = 2;
/** Ticks between two echoes of one player. */
export const ECHO_COOLDOWN_TICKS = 1800;
/** No echo in the first ticks after the spawn phase (land grab). */
export const ECHO_EARLIEST_TICK_AFTER_SPAWN = 1200;
/** Share of the player's gold an echo costs. */
export const ECHO_GOLD_PERCENT = 30n;
/** An echo needs at least this much gold, and costs at least this much. */
export const ECHO_MIN_GOLD = 100_000n;
/**
 * At most this share (percent) of the player's current land comes back, plus
 * ECHO_RESTORE_BASE tiles (so a player knocked down to a few tiles still gets
 * a real comeback, and a giant can't undo a whole war).
 */
export const ECHO_MAX_RESTORE_PERCENT = 60;
export const ECHO_RESTORE_BASE = 300;

export function echoRestoreCap(currentTiles: number): number {
  return (
    Math.floor((currentTiles * ECHO_MAX_RESTORE_PERCENT) / 100) +
    ECHO_RESTORE_BASE
  );
}

// ── Ghosts of the past ──
// A ghost army rises on land you lost in the last GHOST_WINDOW_TICKS (the
// newest lost tile the taker still holds) and attacks the taker from there.
// It costs GHOST_TROOP_PERCENT of your troops (they become the ghost army)
// and GHOST_GOLD_PERCENT of your gold (at least GHOST_MIN_GOLD).
export const GHOST_WINDOW_TICKS = 150;
export const GHOST_MAX_USES = 2;
export const GHOST_COOLDOWN_TICKS = 1200;
export const GHOST_TROOP_PERCENT = 25;
export const GHOST_GOLD_PERCENT = 10n;
export const GHOST_MIN_GOLD = 50_000n;
/** How long every client marks a ghost's rising spot on the map. */
export const GHOST_MARK_TICKS = 80;

export function ghostCost(gold: bigint): bigint {
  const pct = (gold * GHOST_GOLD_PERCENT) / 100n;
  return pct > GHOST_MIN_GOLD ? pct : GHOST_MIN_GOLD;
}

/** Why a player may not raise a ghost right now ("ok" when they may). */
export function ghostBlock(
  enabled: boolean,
  alive: boolean,
  inSpawnPhase: boolean,
  ticksSinceSpawnPhase: number,
  now: number,
  state: EchoState,
  gold: bigint,
): EchoBlock {
  if (!enabled) return "disabled";
  if (!alive) return "dead";
  if (inSpawnPhase) return "spawn";
  if (ticksSinceSpawnPhase < ECHO_EARLIEST_TICK_AFTER_SPAWN) return "too_early";
  if (state.used >= GHOST_MAX_USES) return "no_uses";
  if (now < state.readyTick) return "cooldown";
  if (gold < GHOST_MIN_GOLD) return "gold";
  return "ok";
}

/** The newest ghost of a player, as every client sees it. */
export interface GhostView {
  tile: number;
  tick: number;
  /** smallID of the player the ghost attacks */
  target: number;
}

// ── Time Loop: once a game, your land goes back to how it was ──
export const LOOP_WINDOW_TICKS = 200;
export const LOOP_MAX_USES = 1;
/** Unlocked this long after the spawn phase (no loop in the land grab). */
export const LOOP_EARLIEST_TICK_AFTER_SPAWN = 1800;
export const LOOP_GOLD_PERCENT = 40n;
export const LOOP_MIN_GOLD = 150_000n;
export const LOOP_TROOP_PERCENT = 20;

export function loopCost(gold: bigint): bigint {
  const pct = (gold * LOOP_GOLD_PERCENT) / 100n;
  return pct > LOOP_MIN_GOLD ? pct : LOOP_MIN_GOLD;
}

export function loopBlock(
  enabled: boolean,
  alive: boolean,
  inSpawnPhase: boolean,
  ticksSinceSpawnPhase: number,
  used: number,
  gold: bigint,
): EchoBlock {
  if (!enabled) return "disabled";
  if (!alive) return "dead";
  if (inSpawnPhase) return "spawn";
  if (ticksSinceSpawnPhase < LOOP_EARLIEST_TICK_AFTER_SPAWN) return "too_early";
  if (used >= LOOP_MAX_USES) return "no_uses";
  if (gold < LOOP_MIN_GOLD) return "gold";
  return "ok";
}

// ── Paradox: two echoes in the same moment ──
// When your Time Echo / Loop would take back land that another player just
// took back with their own Echo / Loop, the two timelines clash. The bigger
// army wins the contested land; the loser loses PARADOX_TROOP_PERCENT of
// their troops.
export const PARADOX_TROOP_PERCENT = 15;
export const PARADOX_MARK_TICKS = 80;

/** The newest paradox a player started, as every client sees it. */
export interface ParadoxView {
  tile: number;
  tick: number;
  /** smallID of the other side */
  other: number;
  /** true when the player who started it won */
  won: boolean;
  tiles: number;
}

// ── Delayed orders (attack / boat / build that fires later) ──
export const ORDER_MIN_DELAY_TICKS = 30; // 3 s
export const ORDER_MAX_DELAY_TICKS = 600; // 60 s
export const ORDER_MAX_PENDING = 5;

/** A delayed order as the HUD sees it (own player only). */
export interface DelayedOrderView {
  id: number;
  kind: "attack" | "boat" | "build_unit";
  fireTick: number;
  /** Target tile (boat, build) or -1 (land attack). */
  tile: number;
  /** Land attack target player smallID (0 = empty land), else 0. */
  target: number;
  /** Unit type for builds, "" otherwise. */
  unit: string;
}

/** Client: how far back the past view reaches. */
export const PAST_VIEW_MAX_SECONDS = 15;

export function echoCost(gold: bigint): bigint {
  const pct = (gold * ECHO_GOLD_PERCENT) / 100n;
  return pct > ECHO_MIN_GOLD ? pct : ECHO_MIN_GOLD;
}

export type EchoBlock =
  | "ok"
  | "disabled"
  | "spawn"
  | "too_early"
  | "no_uses"
  | "cooldown"
  | "gold"
  | "dead";

export interface EchoState {
  used: number;
  readyTick: number;
}

/** Why a player may not echo right now ("ok" when they may). */
export function echoBlock(
  enabled: boolean,
  alive: boolean,
  inSpawnPhase: boolean,
  ticksSinceSpawnPhase: number,
  now: number,
  state: EchoState,
  gold: bigint,
): EchoBlock {
  if (!enabled) return "disabled";
  if (!alive) return "dead";
  if (inSpawnPhase) return "spawn";
  if (ticksSinceSpawnPhase < ECHO_EARLIEST_TICK_AFTER_SPAWN) return "too_early";
  if (state.used >= ECHO_MAX_USES) return "no_uses";
  if (now < state.readyTick) return "cooldown";
  if (gold < ECHO_MIN_GOLD) return "gold";
  return "ok";
}

/** How ChronoLog records the land changes happening right now. */
export enum ChronoMode {
  Normal = 0,
  /** Land given back by an echo or a loop: another echo hits a paradox */
  Restored = 1,
  /** Not recorded at all (a ghost's foothold) */
  Hidden = 2,
}

/**
 * The simulation's memory of who took which tile from whom (0 = empty land),
 * for the last seconds. A fixed ring of typed arrays: when a huge war
 * changes more than CAPACITY tiles inside a window, the oldest entries drop
 * out (the same on every client, so still deterministic).
 */
export class ChronoLog {
  static readonly CAPACITY = 1 << 20; // 1M entries, 13 MB
  private readonly tick = new Int32Array(ChronoLog.CAPACITY);
  private readonly tile = new Int32Array(ChronoLog.CAPACITY);
  private readonly from = new Uint16Array(ChronoLog.CAPACITY);
  private readonly to = new Uint16Array(ChronoLog.CAPACITY);
  private readonly kind = new Uint8Array(ChronoLog.CAPACITY);
  private head = 0; // next write
  private size = 0;
  mode: ChronoMode = ChronoMode.Normal;

  record(tick: number, tile: number, fromSmallID: number, toSmallID: number) {
    if (this.mode === ChronoMode.Hidden) return;
    const i = this.head;
    this.tick[i] = tick;
    this.tile[i] = tile;
    this.from[i] = fromSmallID;
    this.to[i] = toSmallID;
    this.kind[i] = this.mode;
    this.head = (i + 1) & (ChronoLog.CAPACITY - 1);
    if (this.size < ChronoLog.CAPACITY) this.size++;
  }

  /**
   * Newest first: every tile `loser` lost since `sinceTick`, with who took it
   * and whether it was taken back by a Time Echo / Time Loop (Restored).
   */
  forEachLoss(
    loser: number,
    sinceTick: number,
    cb: (tile: number, taker: number, kind: ChronoMode) => void,
  ): void {
    let i = this.head;
    for (let n = 0; n < this.size; n++) {
      i = (i - 1) & (ChronoLog.CAPACITY - 1);
      if (this.tick[i] < sinceTick) return;
      if (this.from[i] === loser) cb(this.tile[i], this.to[i], this.kind[i]);
    }
  }

  /** Newest first: every change since `sinceTick`. */
  forEachSince(
    sinceTick: number,
    cb: (tile: number, from: number, to: number) => void,
  ): void {
    let i = this.head;
    for (let n = 0; n < this.size; n++) {
      i = (i - 1) & (ChronoLog.CAPACITY - 1);
      if (this.tick[i] < sinceTick) return;
      cb(this.tile[i], this.from[i], this.to[i]);
    }
  }

  /** Oldest tick still in the log (Infinity when empty). */
  oldestTick(): number {
    if (this.size === 0) return Infinity;
    const i = (this.head - this.size) & (ChronoLog.CAPACITY - 1);
    return this.tick[i];
  }

  entries(): number {
    return this.size;
  }
}
