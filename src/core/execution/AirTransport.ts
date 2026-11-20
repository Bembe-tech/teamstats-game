// TeamStats.Pro "Airports and Planes": boat sends that work in both modes.
// With the mode on, a "boat" is a troop plane (AirDropExecution).
import { Execution, Game, Player, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { canBuildTransportShip } from "../game/TransportShipUtils";
import { AirDropExecution } from "./AirDropExecution";
import { TransportShipExecution } from "./TransportShipExecution";

export function canSendTroopTransport(
  game: Game,
  player: Player,
  tile: TileRef,
): TileRef | false {
  if (game.config().airports()) {
    return player.canBuild(UnitType.TransportShip, tile);
  }
  return canBuildTransportShip(game, player, tile);
}

export function troopTransportExecution(
  game: Game,
  player: Player,
  tile: TileRef,
  troops: number,
): Execution {
  if (game.config().airports()) {
    return new AirDropExecution(player, tile, troops);
  }
  return new TransportShipExecution(player, tile, troops);
}
