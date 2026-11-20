// TeamStats.Pro "Airports and Planes": the fighter (a Warship unit, so the
// build menu, selection and move orders of warships keep working). It takes
// off from the nearest own airport, flies to its patrol tile and circles it.
// Enemy planes in sight (troop planes first, then fighters, then cargo planes
// not flying to us or an ally) are chased up to FIGHTER_LEASH from the patrol
// tile and shot: troop and cargo planes fall with one hit, fighters take
// FIGHTER_DAMAGE per hit. Fighters are the only thing that shoots planes down.
import {
  chebyshev,
  FIGHTER_DAMAGE,
  FIGHTER_FIRE_COOLDOWN_TICKS,
  FIGHTER_GUN_RANGE,
  FIGHTER_LEASH,
  FIGHTER_PATROL_RADIUS,
  FIGHTER_SIGHT,
  FIGHTER_SPEED,
  stepToward,
} from "../game/Airports";
import { Execution, Game, Player, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PseudoRandom } from "../PseudoRandom";

export class FighterExecution implements Execution {
  private active = true;
  private mg: Game;
  private fighter: Unit;
  private random: PseudoRandom;
  private waypoint: TileRef | null = null;
  private lastShot = -1000;

  constructor(
    private readonly owner: Player,
    private readonly patrolTile: TileRef,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    const spawn = this.owner.canBuild(UnitType.Warship, this.patrolTile);
    if (spawn === false) {
      this.active = false;
      return;
    }
    this.fighter = this.owner.buildUnit(UnitType.Warship, spawn, {
      patrolTile: this.patrolTile,
    });
    this.random = new PseudoRandom(this.fighter.id() * 7919 + ticks);
  }

  tick(ticks: number): void {
    if (!this.active) return;
    if (!this.fighter.isActive()) {
      this.active = false;
      return;
    }
    const patrol = this.fighter.warshipState().patrolTile ?? this.patrolTile;

    let target = this.fighter.targetUnit();
    if (
      target !== undefined &&
      (!target.isActive() ||
        !this.isEnemyPlane(target) ||
        chebyshev(this.mg, target.tile(), patrol) > FIGHTER_LEASH)
    ) {
      target = undefined;
      this.fighter.setTargetUnit(undefined);
      this.fighter.touch();
    }
    if (target === undefined) {
      target = this.findTarget(patrol);
      if (target !== undefined) {
        this.fighter.setTargetUnit(target);
        this.fighter.touch();
      }
    }

    if (target !== undefined) {
      this.fighter.updateWarshipState({ isInCombat: true });
      const d = chebyshev(this.mg, this.fighter.tile(), target.tile());
      if (d > FIGHTER_GUN_RANGE - 1) {
        this.fighter.move(
          stepToward(
            this.mg,
            this.fighter.tile(),
            target.tile(),
            FIGHTER_SPEED,
          ),
        );
      }
      if (
        chebyshev(this.mg, this.fighter.tile(), target.tile()) <=
          FIGHTER_GUN_RANGE &&
        ticks - this.lastShot >= FIGHTER_FIRE_COOLDOWN_TICKS
      ) {
        this.lastShot = ticks;
        this.shoot(target);
      }
      return;
    }

    this.patrol(patrol);
  }

  private shoot(target: Unit): void {
    const me = this.fighter.owner();
    const type = target.type();
    if (type === UnitType.Warship) {
      target.modifyHealth(-FIGHTER_DAMAGE, me);
      if (!target.isActive()) this.fighter.recordKill(UnitType.Warship);
    } else {
      // Troop or cargo plane: shot down, troops and cargo are lost
      target.delete(true, me);
      if (type === UnitType.TransportShip) {
        this.fighter.recordKill(UnitType.TransportShip);
      } else {
        this.fighter.recordTradeCapture();
      }
    }
    if (!target.isActive()) {
      this.fighter.setTargetUnit(undefined);
      this.fighter.touch();
    }
  }

  private isEnemyPlane(unit: Unit): boolean {
    const me = this.fighter.owner();
    if (unit === this.fighter || unit.owner() === me) return false;
    if (!me.canAttackPlayer(unit.owner(), true)) return false;
    if (unit.type() === UnitType.TradeShip) {
      // Never shoot cargo flying to us or to an ally
      const dst = unit.targetUnit()?.owner();
      if (dst !== undefined && (dst === me || dst.isFriendly(me))) {
        return false;
      }
    }
    return true;
  }

  private findTarget(patrol: TileRef): Unit | undefined {
    const near = this.mg.nearbyUnits(this.fighter.tile(), FIGHTER_SIGHT, [
      UnitType.TransportShip,
      UnitType.Warship,
      UnitType.TradeShip,
    ]);
    let best: Unit | undefined;
    let bestPrio = 0;
    let bestD = 0;
    for (const { unit, distSquared } of near) {
      if (!this.isEnemyPlane(unit)) continue;
      if (chebyshev(this.mg, unit.tile(), patrol) > FIGHTER_LEASH) continue;
      const t = unit.type();
      const prio =
        t === UnitType.TransportShip ? 0 : t === UnitType.Warship ? 1 : 2;
      if (
        best === undefined ||
        prio < bestPrio ||
        (prio === bestPrio &&
          (distSquared < bestD ||
            (distSquared === bestD && unit.id() < best.id())))
      ) {
        best = unit;
        bestPrio = prio;
        bestD = distSquared;
      }
    }
    return best;
  }

  private patrol(patrol: TileRef): void {
    const here = this.fighter.tile();
    if (
      this.waypoint === null ||
      here === this.waypoint ||
      chebyshev(this.mg, this.waypoint, patrol) > FIGHTER_PATROL_RADIUS
    ) {
      this.waypoint = this.pickWaypoint(patrol);
    }
    this.fighter.move(stepToward(this.mg, here, this.waypoint, FIGHTER_SPEED));
  }

  private pickWaypoint(patrol: TileRef): TileRef {
    const r = FIGHTER_PATROL_RADIUS;
    const px = this.mg.x(patrol);
    const py = this.mg.y(patrol);
    const x = Math.min(
      this.mg.width() - 1,
      Math.max(0, px + this.random.nextInt(-r, r + 1)),
    );
    const y = Math.min(
      this.mg.height() - 1,
      Math.max(0, py + this.random.nextInt(-r, r + 1)),
    );
    return this.mg.ref(x, y);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
