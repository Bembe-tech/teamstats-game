// TeamStats.Pro "King of the Hill 2": a player's garrison order (throne intent).
// "send" moves `percent` of the player's troops to the throne garrison,
// "withdraw" brings the whole garrison home. Both need at least one own tile
// in the throne zone (troops must be able to reach the throne).
import { Execution, Game, Player } from "../game/Game";
import { THRONE_DEFAULTS, ThroneView } from "../game/Throne";
import { ownsThroneZoneTile } from "../game/ThroneZone";

export function setGarrison(p: Player, garrison: number): void {
  const old = p.throne();
  if (old !== null && old.garrison === garrison) return;
  const view: ThroneView = {
    garrison,
    reign: old?.reign ?? 0,
    status: old?.status ?? 0,
    paid: old?.paid ?? 0,
  };
  p.setThrone(view);
}

/** Sends troops to the throne. Returns the troops sent (0 when not allowed). */
export function sendToThrone(mg: Game, p: Player, percent: number): number {
  if (!mg.config().kingOfTheHill2() || !p.isAlive()) return 0;
  if (!ownsThroneZoneTile(mg, p)) return 0;
  const pct = Math.max(0, Math.min(THRONE_DEFAULTS.maxSendPercent, percent));
  const amount = Math.floor((p.troops() * pct) / 100);
  if (amount <= 0) return 0;
  const removed = p.removeTroops(amount);
  setGarrison(p, p.throneGarrison() + removed);
  return removed;
}

/** Brings the whole garrison home. Returns the troops returned. */
export function withdrawFromThrone(mg: Game, p: Player): number {
  if (!mg.config().kingOfTheHill2() || !p.isAlive()) return 0;
  const g = p.throneGarrison();
  if (g <= 0 || !ownsThroneZoneTile(mg, p)) return 0;
  p.addTroops(g);
  setGarrison(p, 0);
  return g;
}

export class ThroneOrderExecution implements Execution {
  private active = true;
  private mg: Game | null = null;

  constructor(
    private player: Player,
    private action: "send" | "withdraw",
    private percent: number,
  ) {}

  init(mg: Game): void {
    this.mg = mg;
  }

  tick(): void {
    const mg = this.mg;
    if (mg === null) throw new Error("Not initialized");
    if (this.action === "send") sendToThrone(mg, this.player, this.percent);
    else withdrawFromThrone(mg, this.player);
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
