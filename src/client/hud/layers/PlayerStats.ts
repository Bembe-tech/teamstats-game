import { customElement } from "lit/decorators.js";
import type { EventBus } from "../../../core/EventBus";
import { type StatsRow, StatsTable } from "../../components/StatsTable";
import { FogOfWar } from "../../FogOfWar";
import { GoToPlayerEvent } from "../../TransformHandler";
import type { GameView } from "../../view";
import { type ColumnDef, columnValues } from "./lib/StatsColumns";

@customElement("player-stats")
export class PlayerStats extends StatsTable {
  public eventBus: EventBus | null = null;

  protected readonly tableKind = "player";

  protected buildRows(
    game: GameView,
    columns: readonly ColumnDef[],
  ): StatsRow[] {
    const myPlayer = game.myPlayer();

    return game
      .playerViews()
      .filter((player) => player.isAlive())
      // TeamStats.Pro: with Fog of War, only players you can see
      .filter((player) => !FogOfWar.current?.hidesPlayer(player.smallID()))
      .map((player) => ({
        key: player.id(),
        name: player.name(),
        clanTag: player.clanTag(),
        values: columnValues(player, game, columns),
        emphasized:
          myPlayer !== null &&
          (player === myPlayer || player.isOnSameTeam(myPlayer)),
        pinned: player === myPlayer,
        fogged: FogOfWar.current?.hidesStatsOf(player.smallID()) ?? false,
        onClick: () => {
          if (this.eventBus !== null) {
            this.eventBus.emit(new GoToPlayerEvent(player));
          }
        },
      }));
  }
}
