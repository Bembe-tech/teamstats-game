// TeamStats.Pro "Troops and Workers" (lobby option troopsAndWorkers): a
// player moves the troop ratio slider (troop_ratio intent). The population
// then shifts between troops and workers over the next seconds
// (game/Workforce.ts).
import { Execution, Game, Player } from "../game/Game";

export class TroopRatioExecution implements Execution {
  private active = true;

  constructor(
    private player: Player,
    private percent: number,
  ) {}

  init(mg: Game): void {
    if (mg.config().troopsAndWorkers() && this.player.isAlive()) {
      this.player.setTargetTroopPercent(this.percent);
    }
    this.active = false;
  }

  tick(): void {}

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }
}
