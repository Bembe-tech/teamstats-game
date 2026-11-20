// TeamStats.Pro "Airports and Planes": a cargo plane (a TradeShip unit) flies
// straight from one airport to another. Gold is paid like a trade ship's, from
// the Manhattan distance between the two airports, so longer routes pay more.
//
// A fighter can intercept it like a warship takes a trade ship
// (FighterExecution captures the unit): the plane then turns to the captor's
// nearest airport and the captor gets the gold on landing. A fighter of the
// original owner can take it back; it then lands at the original owner's
// nearest airport and the payout is theirs again. Nothing else touches it.
import { renderNumber } from "../../client/Utils";
import { CARGO_PLANE_SPEED, chebyshev, linePoint } from "../game/Airports";
import {
  Execution,
  Game,
  MessageType,
  Player,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";

export class CargoPlaneExecution implements Execution {
  private active = true;
  private mg: Game;
  private plane: Unit | undefined;
  private path: TileRef[] = [];
  private step = 0;
  private planId = 1;
  private readonly domestic: boolean;
  /** Owner the plane was last routed for (changes when it is intercepted). */
  private routedFor: Player;
  private wasCaptured = false;
  private dstPort: Unit;

  constructor(
    private readonly origOwner: Player,
    private readonly srcPort: Unit,
    dstPort: Unit,
  ) {
    this.dstPort = dstPort;
    this.domestic = dstPort.owner() === origOwner;
    this.routedFor = origOwner;
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
      this.plane = this.origOwner.buildUnit(
        UnitType.TradeShip,
        this.srcPort.tile(),
        { targetUnit: this.dstPort },
      );
      this.mg.stats().boatSendTrade(this.origOwner, this.dstPort.owner());
      this.route(ticks, this.dstPort.tile());
    }

    if (!this.plane.isActive()) {
      // Shot down (or removed with its owner)
      this.active = false;
      return;
    }

    const owner = this.plane.owner();
    if (owner !== this.routedFor) {
      // Intercepted (or taken back): land at the new owner's nearest airport
      this.routedFor = owner;
      if (owner !== this.origOwner) {
        this.wasCaptured = true;
        this.mg.displayMessage(
          "events_display.trade_ship_captured",
          MessageType.UNIT_DESTROYED,
          this.origOwner.id(),
          undefined,
          { name: owner.displayName() },
          this.plane.id(),
          owner.id(),
        );
      }
      const home = this.nearestAirport(owner, this.plane.tile());
      if (home === null) {
        this.plane.delete(false);
        this.active = false;
        return;
      }
      this.dstPort = home;
      this.plane.setTargetUnit(home);
      this.plane.touch();
      this.route(ticks, home.tile());
    }

    if (this.wasCaptured) {
      if (!this.dstPort.isActive() || this.dstPort.owner() !== owner) {
        const home = this.nearestAirport(owner, this.plane.tile());
        if (home === null) {
          this.plane.delete(false);
          this.active = false;
          return;
        }
        this.dstPort = home;
        this.plane.setTargetUnit(home);
        this.plane.touch();
        this.route(ticks, home.tile());
      }
    } else {
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
    }

    if (this.step >= this.path.length) {
      this.complete();
      return;
    }
    this.plane.move(this.path[this.step]);
    this.step++;
  }

  /** Straight flight from the plane's tile to `dst` (as a motion plan). */
  private route(ticks: number, dst: TileRef): void {
    const plane = this.plane!;
    const src = plane.tile();
    this.path = [];
    this.step = 0;
    const steps = chebyshev(this.mg, src, dst);
    const hops = Math.max(1, Math.ceil(steps / CARGO_PLANE_SPEED));
    for (let i = 1; i <= hops; i++) {
      this.path.push(
        linePoint(this.mg, src, dst, i * CARGO_PLANE_SPEED, steps),
      );
    }
    this.mg.recordMotionPlan({
      kind: "grid",
      unitId: plane.id(),
      planId: this.planId++,
      startTick: ticks + 1,
      ticksPerStep: 1,
      path: this.path,
    });
  }

  private nearestAirport(owner: Player, from: TileRef): Unit | null {
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const port of owner.units(UnitType.Port)) {
      if (
        !port.isActive() ||
        port.isUnderConstruction() ||
        port.isMarkedForDeletion()
      ) {
        continue;
      }
      const d = this.mg.manhattanDist(port.tile(), from);
      if (d < bestD) {
        best = port;
        bestD = d;
      }
    }
    return best;
  }

  private complete(): void {
    this.active = false;
    const plane = this.plane!;
    const owner = plane.owner();
    plane.delete(false);
    const dist = this.mg.manhattanDist(
      this.srcPort.tile(),
      this.dstPort.tile(),
    );
    const gold = this.mg.config().tradeShipGold(dist, owner);

    if (this.wasCaptured && owner === this.origOwner) {
      // Taken back by its owner: the payout stands, nobody pirated it
      owner.addGold(gold, this.dstPort.tile());
      return;
    }
    if (this.wasCaptured) {
      owner.addGold(gold, this.dstPort.tile());
      owner.addPiracyGold(gold);
      this.mg.displayMessage(
        "events_display.received_gold_from_captured_ship",
        MessageType.CAPTURED_ENEMY_UNIT,
        owner.id(),
        gold,
        { gold: renderNumber(gold), name: this.origOwner.displayName() },
        undefined,
        this.origOwner.id(),
      );
      this.mg.stats().boatCapturedTrade(owner, this.origOwner, gold);
      return;
    }
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
