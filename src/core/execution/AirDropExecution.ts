// TeamStats.Pro "Airports and Planes": the troop plane that replaces the boat.
// It is a TransportShip unit, so the boat limit, the incoming-invasion alert,
// the cancel button and the stats all keep working. It takes off from the own
// tile nearest to the target (no airport needed), flies straight and lands on
// the chosen tile, where its troops attack like a boat landing. It costs gold
// and has a cooldown (see game/Airports.ts). Only fighters can shoot it down.
import { renderTroops } from "../../client/Utils";
import {
  nearestOwnTile,
  recordAirDrop,
  stepToward,
  TROOP_PLANE_SPEED,
} from "../game/Airports";
import {
  Execution,
  Game,
  MessageType,
  Player,
  PlayerType,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { AttackExecution } from "./AttackExecution";

const malusForRetreat = 25;

export class AirDropExecution implements Execution {
  private active = true;
  private mg: Game;
  private plane: Unit;
  private dst: TileRef;
  private retreatDst: TileRef | null = null;

  constructor(
    private readonly attacker: Player,
    private readonly ref: TileRef,
    private troops: number | null,
  ) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    if (!mg.isValidRef(this.ref)) {
      this.active = false;
      return;
    }
    const target = mg.owner(this.ref);
    if (
      this.attacker.unitCount(UnitType.TransportShip) >=
      mg.config().boatMaxNumber()
    ) {
      mg.displayMessage(
        "events_display.no_boats_available",
        MessageType.ATTACK_FAILED,
        this.attacker.id(),
        undefined,
        { max: mg.config().boatMaxNumber() },
      );
      this.active = false;
      return;
    }
    if (target.isPlayer()) {
      if (
        target.type() !== PlayerType.Bot &&
        this.attacker.type() !== PlayerType.Bot
      ) {
        const request = this.attacker
          .incomingAllianceRequests()
          .find((ar) => ar.requestor() === target);
        request?.reject();
      }
    }
    // Checks land, own tile, attackable owner, plane limit, cooldown and gold
    const src = this.attacker.canBuild(UnitType.TransportShip, this.ref);
    if (src === false) {
      this.active = false;
      return;
    }
    let troops =
      this.troops ?? mg.config().boatAttackAmount(this.attacker, target);
    troops = Math.min(troops, this.attacker.troops());
    this.dst = this.ref;
    this.plane = this.attacker.buildUnit(UnitType.TransportShip, src, {
      troops,
      targetTile: this.dst,
    });
    recordAirDrop(mg, this.attacker);

    if (target.isPlayer()) {
      mg.displayIncomingUnit(
        this.plane.id(),
        `Air invasion incoming from ${this.attacker.displayName()} (${renderTroops(this.plane.troops())})`,
        MessageType.NAVAL_INVASION_INBOUND,
        target.id(),
      );
    }
    mg.stats().boatSendTroops(this.attacker, target, this.plane.troops());
  }

  tick(_ticks: number): void {
    if (!this.active) return;
    if (!this.plane.isActive()) {
      // Shot down by a fighter: the troops are lost
      this.active = false;
      return;
    }
    const owner = this.plane.owner();

    // A nuke turned the landing tile into water: fly home
    if (
      this.mg.isWater(this.dst) &&
      !this.plane.transportShipState().isRetreating
    ) {
      this.plane.updateTransportShipState({ isRetreating: true });
    }
    if (this.plane.transportShipState().isRetreating) {
      if (this.retreatDst === null) {
        const home = nearestOwnTile(this.mg, owner, this.plane.tile());
        if (home === null) {
          owner.addTroops(this.plane.troops());
          this.plane.delete(false);
          this.active = false;
          return;
        }
        this.retreatDst = home;
        this.dst = home;
        this.plane.setTargetTile(home);
      }
    }

    const next = stepToward(
      this.mg,
      this.plane.tile(),
      this.dst,
      TROOP_PLANE_SPEED,
    );
    this.plane.move(next);
    if (next !== this.dst) return;
    this.land(owner);
  }

  private land(owner: Player): void {
    const troops = this.plane.troops();
    const tileOwner = this.mg.owner(this.dst);
    this.plane.delete(false);
    this.active = false;

    if (tileOwner === owner) {
      const deaths = this.plane.transportShipState().isRetreating
        ? Math.floor((troops * malusForRetreat) / 100)
        : 0;
      owner.addTroops(troops - deaths);
      this.mg.stats().boatArriveTroops(owner, tileOwner, troops - deaths);
      if (deaths > 0) {
        this.mg.displayMessage(
          "events_display.attack_cancelled_retreat",
          MessageType.ATTACK_CANCELLED,
          owner.id(),
          undefined,
          { troops: renderTroops(deaths) },
        );
      }
      return;
    }
    if (
      this.mg.isWater(this.dst) ||
      (tileOwner.isPlayer() &&
        (owner.isFriendly(tileOwner) || !owner.canAttackPlayer(tileOwner)))
    ) {
      // Cannot land here any more (ally now, or the tile is gone): troops go home
      owner.addTroops(troops);
      return;
    }
    owner.conquer(this.dst);
    this.mg.addExecution(
      new AttackExecution(troops, owner, tileOwner.id(), this.dst, false),
    );
    this.mg.stats().boatArriveTroops(owner, tileOwner, troops);
  }

  owner(): Player {
    return this.attacker;
  }

  isActive(): boolean {
    return this.active;
  }
}
