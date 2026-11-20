// TeamStats.Pro "OpenFront 4D": an order (land attack, boat, build or bomb)
// that fires a set time after it arrives. It waits in the simulation like any
// other execution, so every client fires it on the same tick.
import { Execution, Game, Player } from "../game/Game";
import {
  DelayedOrderView,
  ORDER_MAX_DELAY_TICKS,
  ORDER_MAX_PENDING,
  ORDER_MIN_DELAY_TICKS,
} from "../game/TimeWarp";
import { AttackIntent, BoatAttackIntent, BuildUnitIntent } from "../Schemas";

type Order = AttackIntent | BoatAttackIntent | BuildUnitIntent;

export class DelayedOrderExecution implements Execution {
  private active = true;
  private fireTick = 0;
  private id = 0;
  private mg: Game | null = null;

  constructor(
    private readonly player: Player,
    private readonly delay: number,
    private readonly order: Order,
    /** Builds the execution the order becomes (the Executor's own switch). */
    private readonly makeExec: (order: Order) => Execution,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    const p = this.player;
    if (
      !mg.config().timeWarp() ||
      !p.isAlive() ||
      this.delay < ORDER_MIN_DELAY_TICKS ||
      this.delay > ORDER_MAX_DELAY_TICKS ||
      p.delayedOrders().length >= ORDER_MAX_PENDING
    ) {
      this.active = false;
      return;
    }
    this.fireTick = ticks + this.delay;
    // Unique among the player's pending orders, the same on every client
    this.id =
      this.fireTick * 8 +
      p.delayedOrders().filter((o) => o.fireTick === this.fireTick).length;
    const o = this.order;
    const view: DelayedOrderView = {
      id: this.id,
      kind: o.type,
      fireTick: this.fireTick,
      tile: o.type === "attack" ? -1 : o.type === "boat" ? o.dst : o.tile,
      target:
        o.type === "attack" && o.targetID !== null
          ? (() => {
              try {
                return mg.player(o.targetID).smallID();
              } catch {
                return 0;
              }
            })()
          : 0,
      unit: o.type === "build_unit" ? o.unit : "",
    };
    p.addDelayedOrder(view);
  }

  tick(ticks: number): void {
    if (!this.active || ticks < this.fireTick) return;
    this.active = false;
    this.player.removeDelayedOrder(this.id);
    if (!this.player.isAlive() || this.mg === null) return;
    this.mg.addExecution(this.makeExec(this.order));
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
