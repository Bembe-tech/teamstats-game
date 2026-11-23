import {
  Execution,
  Game,
  MessageType,
  Player,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PathFinding } from "../pathfinding/PathFinder";
import { PathStatus, SteppingPathFinder } from "../pathfinding/types";
import { NukeType } from "../StatsSchemas";

/**
 * Airports and Planes: troop planes with a SAM missile on the way (the
 * targetedBySAM flag only exists on nukes). Per unit object, so per game.
 */
export const troopPlanesTargetedBySAM = new WeakSet<Unit>();

export class SAMMissileExecution implements Execution {
  private active = true;
  private pathFinder: SteppingPathFinder<TileRef>;
  private SAMMissile: Unit | undefined;
  private mg: Game;
  private speed: number = 0;

  constructor(
    private spawn: TileRef,
    private _owner: Player,
    private ownerUnit: Unit,
    private target: Unit,
    private targetTile: TileRef,
  ) {}

  init(mg: Game, ticks: number): void {
    this.pathFinder = PathFinding.Air(mg);
    this.mg = mg;
    this.speed = this.mg.config().defaultSamMissileSpeed();
    this.tick(ticks);
  }

  tick(ticks: number): void {
    this.SAMMissile ??= this._owner.buildUnit(UnitType.SAMMissile, this.spawn, {
      targetUnit: this.target,
    });
    if (!this.SAMMissile.isActive()) {
      this.active = false;
      return;
    }
    // The MIRV carrier itself can't be intercepted, only its warheads
    const nukesWhitelist = [
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
      UnitType.MIRVWarhead,
    ];
    // Airports and Planes: SAMs also shoot troop planes down
    const isTroopPlane =
      this.target.type() === UnitType.TransportShip &&
      this.mg.config().airports();
    if (
      !this.target.isActive() ||
      !this.ownerUnit.isActive() ||
      this.target.owner() === this.SAMMissile.owner() ||
      (!isTroopPlane && !nukesWhitelist.includes(this.target.type()))
    ) {
      // Clear the flag so other SAMs can re-target this nuke
      if (isTroopPlane) {
        troopPlanesTargetedBySAM.delete(this.target);
      } else if (this.target.isActive()) {
        this.target.setTargetedBySAM(false);
      }
      this.SAMMissile.delete(false);
      this.active = false;
      return;
    }
    for (let i = 0; i < this.speed; i++) {
      const result = this.pathFinder.next(
        this.SAMMissile.tile(),
        this.targetTile,
      );
      if (result.status === PathStatus.COMPLETE) {
        this.mg.displayMessage(
          "events_display.missile_intercepted",
          MessageType.SAM_HIT,
          this._owner.id(),
          undefined,
          { unit: this.target.type() },
        );
        this.active = false;
        if (isTroopPlane) troopPlanesTargetedBySAM.delete(this.target);
        this.target.delete(true, this._owner);
        this.SAMMissile.delete(false);

        // Record stats (a troop plane's are recorded by delete())
        if (!isTroopPlane) {
          this.mg
            .stats()
            .bombIntercept(this._owner, this.target.type() as NukeType, 1);
        }
        return;
      } else if (result.status === PathStatus.NEXT) {
        this.SAMMissile.move(result.node);
      }
    }
  }

  isActive(): boolean {
    return this.active;
  }
  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
