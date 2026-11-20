// TeamStats.Pro "Airports and Planes": a cargo plane (a TradeShip unit) flies
// straight from one airport to another. Gold is paid like a trade ship's, from
// the Manhattan distance between the two airports, so longer routes pay more.
// Only fighters can shoot it down (FighterExecution); nothing captures it.
import { CARGO_PLANE_SPEED, chebyshev, linePoint } from "../game/Airports";
import { Execution, Game, Player, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";

export class CargoPlaneExecution implements Execution {
  private active = true;
  private mg: Game;
  private plane: Unit | undefined;
  private path: TileRef[] = [];
  private step = 0;
  private readonly domestic: boolean;

  constructor(
    private readonly origOwner: Player,
    private readonly srcPort: Unit,
    private readonly dstPort: Unit,
  ) {
    this.domestic = dstPort.owner() === origOwner;
  }

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (this.plane === undefined) {
      if (!this.srcPort.isActive() || !this.dstPort.isActive()) {
        this.active = false;
        return;
      }
      const src = this.srcPort.tile();
      const dst = this.dstPort.tile();
      this.plane = this.origOwner.buildUnit(UnitType.TradeShip, src, {
        targetUnit: this.dstPort,
      });
      this.mg.stats().boatSendTrade(this.origOwner, this.dstPort.owner());
      const steps = chebyshev(this.mg, src, dst);
      const hops = Math.max(1, Math.ceil(steps / CARGO_PLANE_SPEED));
      for (let i = 1; i <= hops; i++) {
        this.path.push(
          linePoint(this.mg, src, dst, i * CARGO_PLANE_SPEED, steps),
        );
      }
      this.mg.recordMotionPlan({
        kind: "grid",
        unitId: this.plane.id(),
        planId: 1,
        startTick: ticks + 1,
        ticksPerStep: 1,
        path: this.path,
      });
    }

    if (!this.plane.isActive()) {
      // Shot down (or removed with its owner)
      this.active = false;
      return;
    }

    const owner = this.plane.owner();
    const dstOwner = this.dstPort.owner();
    if (
      !this.dstPort.isActive() ||
      (!this.domestic && dstOwner === this.srcPort.owner()) ||
      (this.domestic ? dstOwner !== owner : !owner.canTrade(dstOwner))
    ) {
      this.plane.delete(false);
      this.active = false;
      return;
    }

    if (this.step >= this.path.length) {
      this.complete();
      return;
    }
    this.plane.move(this.path[this.step]);
    this.step++;
  }

  private complete(): void {
    this.active = false;
    const plane = this.plane!;
    plane.delete(false);
    const dist = this.mg.manhattanDist(
      this.srcPort.tile(),
      this.dstPort.tile(),
    );
    const gold = this.mg.config().tradeShipGold(dist, plane.owner());
    if (this.domestic) {
      this.dstPort.owner().addGold(gold, this.dstPort.tile());
      this.dstPort.owner().addTradeGold(gold);
      return;
    }
    this.srcPort.owner().addGold(gold, this.srcPort.tile());
    this.dstPort.owner().addGold(gold, this.dstPort.tile());
    this.srcPort.owner().addTradeGold(gold);
    this.dstPort.owner().addTradeGold(gold);
    this.mg
      .stats()
      .boatArriveTrade(this.srcPort.owner(), this.dstPort.owner(), gold);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
