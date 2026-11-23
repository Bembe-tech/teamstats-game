// TeamStats.Pro "Airports and Planes" (lobby option `airports`).
//
// The mode keeps the unit types of the normal game and changes what they are,
// so every existing flow (build menu, boat alerts and cancel, warship
// selection and move orders, stats) keeps working:
//
//   Port          -> Airport: same cost, limit and upgrades, built on any own
//                    land tile (works on maps without water)
//   TradeShip     -> Cargo plane: flies straight between airports of players
//                    that trade (own airports too with Self Economy), gold
//                    grows with the distance (CargoPlaneExecution)
//   TransportShip -> Troop plane: any land tile can be the target, it takes
//                    off from the own tile nearest to the target and lands
//                    on the chosen tile; free and no cooldown, like a boat
//                    (AirDropExecution)
//   Warship       -> Fighter: takes off from the nearest own airport, patrols
//                    its patrol tile and shoots planes down (FighterExecution)
//
// Fighters intercept cargo planes (they land at the fighter owner's airport
// with their gold) and shoot troop planes and other fighters down.
// SAM launchers also shoot enemy troop planes down, without using a missile
// or starting a reload (SAMLauncherExecution); cargo planes and fighters are
// left to fighters. Warships do not exist (they are fighters). Atom bombs,
// hydrogen bombs and MIRV warheads destroy the planes inside the blast
// (NukeExecution).
//
// Everything here is integer math on tile coordinates, so it is the same on
// every client.
import { Game, Player, UnitType } from "./Game";
import { TileRef } from "./GameMap";

/** Tiles per tick. A boat and a trade ship do 1. */
export const CARGO_PLANE_SPEED = 2;
export const TROOP_PLANE_SPEED = 2;
export const FIGHTER_SPEED = 3;
/** A fighter sees enemy planes this far (Chebyshev tiles) from itself. */
export const FIGHTER_SIGHT = 40;
/** A fighter never chases farther than this from its patrol tile. */
export const FIGHTER_LEASH = 90;
/** Patrol circle around the patrol tile. */
export const FIGHTER_PATROL_RADIUS = 14;
/** Gun range and fire rate. */
export const FIGHTER_GUN_RANGE = 3;
export const FIGHTER_FIRE_COOLDOWN_TICKS = 5;
/** Damage to another fighter per hit (fighters have 1000 health). */
export const FIGHTER_DAMAGE = 350;

export function airportsOn(mg: Game): boolean {
  return mg.config().airports();
}

/** Unit types that fly in this mode. */
export function isPlaneType(t: UnitType): boolean {
  return (
    t === UnitType.TradeShip ||
    t === UnitType.TransportShip ||
    t === UnitType.Warship
  );
}

export function chebyshev(mg: Game, a: TileRef, b: TileRef): number {
  return Math.max(Math.abs(mg.x(a) - mg.x(b)), Math.abs(mg.y(a) - mg.y(b)));
}

/**
 * Tile `step` of `steps` on the straight line from `a` to `b` (step 0 = a,
 * step `steps` = b). Integer rounding only.
 */
export function linePoint(
  mg: Game,
  a: TileRef,
  b: TileRef,
  step: number,
  steps: number,
): TileRef {
  if (steps <= 0 || step >= steps) return b;
  const ax = mg.x(a);
  const ay = mg.y(a);
  const x = ax + Math.round(((mg.x(b) - ax) * step) / steps);
  const y = ay + Math.round(((mg.y(b) - ay) * step) / steps);
  return mg.ref(x, y);
}

/** Moves up to `speed` tiles from `from` straight toward `to`. */
export function stepToward(
  mg: Game,
  from: TileRef,
  to: TileRef,
  speed: number,
): TileRef {
  const d = chebyshev(mg, from, to);
  if (d <= speed) return to;
  return linePoint(mg, from, to, speed, d);
}

/**
 * The player's own tile nearest to `target` (its border tiles are enough: the
 * nearest own tile to a point outside the territory is always on the border).
 * Ties go to the lower tile ref, so the pick does not depend on set order.
 */
export function nearestOwnTile(
  mg: Game,
  player: Player,
  target: TileRef,
): TileRef | null {
  let best: TileRef | null = null;
  let bestD = Infinity;
  for (const t of player.borderTiles()) {
    const d = mg.euclideanDistSquared(t, target);
    if (d < bestD || (d === bestD && best !== null && t < best)) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/**
 * Where a troop plane to `tile` takes off, or false when it cannot be sent:
 * the target must be land the player may attack (not their own), fewer than
 * boatMaxNumber planes in the air. Like a boat it is free and has no cooldown.
 */
export function airDropSpawn(
  mg: Game,
  player: Player,
  tile: TileRef,
): TileRef | false {
  if (!mg.isValidRef(tile) || !mg.isLand(tile) || mg.isImpassable(tile)) {
    return false;
  }
  if (player.unitCount(UnitType.TransportShip) >= mg.config().boatMaxNumber()) {
    return false;
  }
  const other = mg.owner(tile);
  if (other === player) return false;
  if (other.isPlayer() && !player.canAttackPlayer(other)) return false;
  return nearestOwnTile(mg, player, tile) ?? false;
}

/** Nearest finished own airport to `tile` (fighters take off there). */
export function fighterSpawn(
  mg: Game,
  player: Player,
  tile: TileRef,
): TileRef | false {
  if (!mg.isValidRef(tile) || mg.isImpassable(tile)) return false;
  let best: TileRef | false = false;
  let bestD = Infinity;
  for (const port of player.units(UnitType.Port)) {
    if (
      !port.isActive() ||
      port.isUnderConstruction() ||
      port.isMarkedForDeletion()
    ) {
      continue;
    }
    const d = mg.manhattanDist(port.tile(), tile);
    if (d < bestD) {
      best = port.tile();
      bestD = d;
    }
  }
  return best;
}
