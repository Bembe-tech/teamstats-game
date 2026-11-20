// TeamStats.Pro "King of the Hill 2" (lobby option kingOfTheHill2): the
// powered throne. Land size does not decide: a side (player in FFA, team in
// team games) reigns while it keeps the biggest garrison at the throne, and the
// reign clock only runs while that garrison is a big part of the side's army
// and the side pays gold every second. The longer a side has reigned, the more
// a second of reign costs (gold and garrison troops), so a leader bleeds and
// cannot park on the throne. First side with the needed reign time wins.
//
// All numbers live in THRONE_DEFAULTS; the lobby can override reign minutes and
// army share (kingOfTheHill2Minutes / kingOfTheHill2ArmyShare).
import { GameMap, TileRef } from "./GameMap";

export const THRONE_DEFAULTS = {
  /** Reign time a side needs to win (minutes). */
  reignMinutes: 5,
  /** Garrison must be at least this % of the army (troops + garrison) of the side's stationing players. */
  armySharePercent: 30,
  /** Gold per second while reigning: base + perReignSecond * seconds reigned so far. */
  goldBasePerSecond: 2_000,
  goldPerReignSecond: 120,
  /** Garrison lost per second while reigning, in 1/10000 of the garrison:
   *  base + perReignSecond * seconds reigned (0.8% at the start, 0.8% + 0.02% per second). */
  holderDrainBase: 80,
  holderDrainPerReignSecond: 2,
  /** Garrison lost per second by a side that does not reign (0.4%). */
  idleDrain: 40,
  /** Garrison lost per second when the player owns no tile in the throne zone (10%). */
  strandedDrain: 1_000,
  /** A challenger needs this much more garrison than the holder to take the throne (%). */
  takeoverMarginPercent: 10,
  /** A landmass around the throne up to this % of all land (and at least half
   *  the disc's area) is an island: the whole island is the throne zone
   *  (Surrounded-like maps). */
  islandMaxLandPercent: 10,
  /** Otherwise the zone is a disc: max(minRadius, sqrt(w*h) / radiusDivisor) tiles. */
  minRadius: 8,
  radiusDivisor: 120,
  /** A single garrison order sends at most this % of the player's troops. */
  maxSendPercent: 60,
};

/** Throne status of a side, mirrored on its players for the client. */
export const enum ThroneStatus {
  None = 0,
  /** Reigning, clock running. */
  Powered = 1,
  /** Reigning but the garrison is below the army share: clock stopped. */
  LowArmy = 2,
  /** Reigning but the side could not pay the gold: clock stopped. */
  NoGold = 3,
}

export interface ThroneView {
  /** Own garrison troops at the throne. */
  garrison: number;
  /** Reign seconds of the player's side (team total in team games). */
  reign: number;
  /** ThroneStatus of the side (None when it does not reign). */
  status: number;
  /** Gold the side paid in the last second (0 when not reigning). */
  paid: number;
}

export interface ThronePlace {
  tile: TileRef;
  x: number;
  y: number;
  /** Ring drawn on the map: center and radius in tiles. */
  ringX: number;
  ringY: number;
  radius: number;
  /** The zone is the whole island of the throne (else a disc). */
  island: boolean;
  /** Land tiles of the throne zone, ascending. */
  tiles: TileRef[];
}

const placeCache = new WeakMap<GameMap, ThronePlace | null>();

/**
 * The throne: the land tile nearest to the map center (on Surrounded-like maps
 * the island in the middle, on other maps the middle of the land). Ties go to
 * the lower tile ref. Pure function of the map, so client and server agree.
 */
export function thronePlace(map: GameMap): ThronePlace | null {
  if (placeCache.has(map)) return placeCache.get(map)!;
  const w = map.width();
  const h = map.height();
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const maxR = Math.max(w, h);
  let best: TileRef | null = null;
  let bestD = Infinity;
  let stopAt = maxR;
  for (let r = 0; r <= Math.min(maxR, stopAt); r++) {
    for (let dy = -r; dy <= r; dy++) {
      const edge = dy === -r || dy === r;
      for (let dx = -r; dx <= r; dx += edge ? 1 : 2 * r || 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const t = map.ref(x, y);
        if (!map.isLand(t)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD || (d === bestD && best !== null && t < best)) {
          best = t;
          bestD = d;
        }
      }
    }
    if (best !== null && stopAt === maxR) {
      // A tile in a later ring can still be closer (ring corners are farther).
      stopAt = Math.ceil(r * Math.SQRT2) + 1;
    }
  }
  if (best === null) {
    placeCache.set(map, null);
    return null;
  }
  const x0 = map.x(best);
  const y0 = map.y(best);
  const island = islandOf(
    map,
    best,
    Math.floor(
      (map.numLandTiles() * THRONE_DEFAULTS.islandMaxLandPercent) / 100,
    ),
  );
  const discR = Math.max(
    THRONE_DEFAULTS.minRadius,
    Math.round(Math.sqrt(w * h) / THRONE_DEFAULTS.radiusDivisor),
  );
  let place: ThronePlace;
  // A tiny islet would make a cramped hill: then the disc (it holds the islet)
  if (island !== null && island.length >= (Math.PI * discR * discR) / 2) {
    let minX = x0;
    let maxX = x0;
    let minY = y0;
    let maxY = y0;
    for (const t of island) {
      const x = map.x(t);
      const y = map.y(t);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const ringX = Math.floor((minX + maxX) / 2);
    const ringY = Math.floor((minY + maxY) / 2);
    let r2 = 0;
    for (const t of island) {
      const dx = map.x(t) - ringX;
      const dy = map.y(t) - ringY;
      if (dx * dx + dy * dy > r2) r2 = dx * dx + dy * dy;
    }
    place = {
      tile: best,
      x: x0,
      y: y0,
      ringX,
      ringY,
      radius: Math.ceil(Math.sqrt(r2)) + 2,
      island: true,
      tiles: island.sort((a, b) => a - b),
    };
  } else {
    const r = discR;
    const tiles: TileRef[] = [];
    for (let y = y0 - r; y <= y0 + r; y++) {
      for (let x = x0 - r; x <= x0 + r; x++) {
        if (!map.isValidCoord(x, y)) continue;
        const dx = x - x0;
        const dy = y - y0;
        if (dx * dx + dy * dy > r * r) continue;
        const t = map.ref(x, y);
        if (map.isLand(t)) tiles.push(t);
      }
    }
    place = {
      tile: best,
      x: x0,
      y: y0,
      ringX: x0,
      ringY: y0,
      radius: r,
      island: false,
      tiles: tiles.sort((a, b) => a - b),
    };
  }
  placeCache.set(map, place);
  return place;
}

/** The 4-connected landmass of `start` if it has at most `limit` tiles. */
function islandOf(
  map: GameMap,
  start: TileRef,
  limit: number,
): TileRef[] | null {
  const seen = new Set<TileRef>([start]);
  const queue: TileRef[] = [start];
  for (let i = 0; i < queue.length; i++) {
    const t = queue[i];
    const x = map.x(t);
    const y = map.y(t);
    const next = [
      [x, y - 1],
      [x, y + 1],
      [x - 1, y],
      [x + 1, y],
    ];
    for (const [nx, ny] of next) {
      if (!map.isValidCoord(nx, ny)) continue;
      const n = map.ref(nx, ny);
      if (seen.has(n) || !map.isLand(n)) continue;
      seen.add(n);
      queue.push(n);
      if (queue.length > limit) return null;
    }
  }
  return queue;
}

/** Land tiles of the throne zone, ascending. */
export function throneZoneTiles(_map: GameMap, place: ThronePlace): TileRef[] {
  return place.tiles;
}

/** Gold a reigning side pays for the next second. */
export function throneGoldPerSecond(reignSeconds: number): number {
  return (
    THRONE_DEFAULTS.goldBasePerSecond +
    THRONE_DEFAULTS.goldPerReignSecond * reignSeconds
  );
}

/** Garrison share (in 1/10000) a reigning side loses in the next second. */
export function throneHolderDrain(reignSeconds: number): number {
  return (
    THRONE_DEFAULTS.holderDrainBase +
    THRONE_DEFAULTS.holderDrainPerReignSecond * reignSeconds
  );
}
