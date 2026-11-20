// TeamStats.Pro "OpenFront 4D": the Time Loop (rules in game/TimeWarp.ts).
// Once a game, the player's land goes back to how it was LOOP_WINDOW_TICKS
// ago: land lost since then comes back, land taken since then goes back to
// whoever had it (or becomes empty again). Every client runs it on the same
// tick from the same ChronoLog, so lockstep holds.
import { Execution, Game, MessageType, Player } from "../game/Game";
import {
  ChronoMode,
  LOOP_TROOP_PERCENT,
  LOOP_WINDOW_TICKS,
  loopBlock,
  loopCost,
} from "../game/TimeWarp";
import { resolveParadox } from "./TimeEchoExecution";

export class TimeLoopExecution implements Execution {
  /** For tests: tiles that came back / went back. */
  regained = 0;
  returned = 0;

  constructor(private readonly player: Player) {}

  init(mg: Game, ticks: number): void {
    const me = this.player;
    const block = loopBlock(
      mg.config().timeWarp(),
      me.isAlive(),
      mg.inSpawnPhase(),
      Math.floor(mg.elapsedGameSeconds() * 10),
      me.loopUses(),
      me.gold(),
    );
    const log = mg.chronoLog();
    if (block !== "ok" || log === null) return;
    const mine = me.smallID();
    const since = ticks - LOOP_WINDOW_TICKS;

    // Owner of every changed tile at the start of the window: the "from" of
    // its oldest change since then (iteration is newest first).
    const then = new Map<number, number>();
    log.forEachSince(since, (tile, from) => {
      then.set(tile, from);
    });
    // Tiles taken back by another echo / loop in this window: paradox
    const clash = new Map<number, number[]>();
    log.forEachLoss(mine, since, (tile, taker, kind) => {
      if (kind !== ChronoMode.Restored || taker === 0) return;
      if (mg.ownerID(tile) !== taker) return;
      const list = clash.get(taker) ?? [];
      list.push(tile);
      clash.set(taker, list);
    });
    const clashTiles = new Set<number>();
    for (const list of clash.values()) for (const t of list) clashTiles.add(t);

    const regain: number[] = [];
    const giveBack: { tile: number; to: number }[] = [];
    for (const [tile, was] of then) {
      const now = mg.ownerID(tile);
      if (was === now || clashTiles.has(tile)) continue;
      if (!mg.isLand(tile) || mg.isImpassable(tile)) continue;
      if (was === mine) {
        // Lost since: back to me, unless a friend holds it now
        if (now !== 0) {
          const holder = mg.playerBySmallID(now);
          if (holder.isPlayer() && holder.isFriendly(me)) continue;
        }
        regain.push(tile);
      } else if (now === mine) {
        giveBack.push({ tile, to: was });
      }
    }

    me.removeGold(loopCost(me.gold()));
    me.removeTroops(Math.floor((me.troops() * LOOP_TROOP_PERCENT) / 100));
    log.mode = ChronoMode.Restored;
    for (const t of regain) me.conquer(t);
    for (const { tile, to } of giveBack) {
      const p = to === 0 ? null : mg.playerBySmallID(to);
      if (p !== null && p.isPlayer() && p.isAlive() && !p.isFriendly(me)) {
        p.conquer(tile);
      } else if (mg.ownerID(tile) === mine && me.numTilesOwned() > 1) {
        me.relinquish(tile);
      }
    }
    let won = 0;
    for (const [other, list] of clash) {
      won += resolveParadox(mg, me, other, list, ticks);
    }
    log.mode = ChronoMode.Normal;
    me.markLoop();
    this.regained = regain.length + won;
    this.returned = giveBack.length;

    mg.displayMessage(
      "events_display.time_loop_used",
      MessageType.CAPTURED_ENEMY_UNIT,
      me.id(),
      undefined,
      {
        back: this.regained,
        lost: this.returned,
        seconds: LOOP_WINDOW_TICKS / 10,
      },
    );
    const touched = new Set<number>();
    for (const t of regain) touched.add(mg.ownerID(t));
    for (const g of giveBack) if (g.to !== 0) touched.add(g.to);
    touched.delete(mine);
    touched.delete(0);
    for (const id of touched) {
      const p = mg.playerBySmallID(id);
      if (!p.isPlayer()) continue;
      mg.displayMessage(
        "events_display.time_loop_against",
        MessageType.ATTACK_FAILED,
        p.id(),
        undefined,
        { name: me.displayName(), seconds: LOOP_WINDOW_TICKS / 10 },
      );
    }
  }

  tick(_: number): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
