// TeamStats.Pro "Select Silo mode" (lobby option `selectSilo`): the player
// numbers their missile silos 1-9 on the client and can pick which silo a
// nuke launches from. The client sends the chosen silo's unit id with the
// build_unit intent; this resolves it deterministically on every client.
import { Game, Player, UnitType } from "./Game";
import { TileRef } from "./GameMap";

/**
 * Launch tile for a nuke/MIRV. `spawn` is the tile nukeSpawn picked (the
 * nearest ready silo, already validated against the target). Without a chosen
 * silo, or when the mode is off, that tile is kept. With a chosen silo the
 * nuke leaves from it, or the launch fails when that silo is gone, not ours,
 * reloading or still being built (never silently falls back to another one).
 */
export function resolveSiloSpawn(
  mg: Game,
  player: Player,
  spawn: TileRef,
  siloId: number | undefined,
): TileRef | false {
  if (siloId === undefined || !mg.config().selectSilo()) return spawn;
  const silo = player
    .units(UnitType.MissileSilo)
    .find((s) => s.id() === siloId);
  if (
    silo === undefined ||
    !silo.isActive() ||
    silo.isInCooldown() ||
    silo.isUnderConstruction()
  ) {
    return false;
  }
  return silo.tile();
}
