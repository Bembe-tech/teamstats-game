// TeamStats.Pro "King of the Hill 2": who stands in the throne zone.
import { Game, Player } from "./Game";
import { TileRef } from "./GameMap";
import { thronePlace, throneZoneTiles } from "./Throne";

const zoneCache = new WeakMap<object, TileRef[]>();

/** Land tiles of the throne zone of this game's map (cached). */
export function throneZone(mg: Game): TileRef[] {
  const map = mg.map();
  let zone = zoneCache.get(map);
  if (zone === undefined) {
    const place = thronePlace(map);
    zone = place === null ? [] : throneZoneTiles(map, place);
    zoneCache.set(map, zone);
  }
  return zone;
}

/** Number of zone tiles owned per smallID. */
export function throneZoneOwners(mg: Game): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of throneZone(mg)) {
    const id = mg.ownerID(t);
    if (id === 0) continue;
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

export function ownsThroneZoneTile(mg: Game, p: Player): boolean {
  const id = p.smallID();
  for (const t of throneZone(mg)) {
    if (mg.ownerID(t) === id) return true;
  }
  return false;
}
