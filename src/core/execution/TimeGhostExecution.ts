// TeamStats.Pro "OpenFront 4D": Ghosts of the past (rules in
// game/TimeWarp.ts). Your army comes back on land you lost a moment ago and
// strikes the player who took it, from behind their new front. Runs on every
// client on the same tick, like any other intent.
import { Execution, Game, MessageType, Player } from "../game/Game";
import {
  GHOST_COOLDOWN_TICKS,
  GHOST_TROOP_PERCENT,
  GHOST_WINDOW_TICKS,
  ghostBlock,
  ghostCost,
} from "../game/TimeWarp";
import { AttackExecution } from "./AttackExecution";

export class TimeGhostExecution implements Execution {
  /** Tile the ghost rose on (-1 = none), for tests. */
  anchor = -1;

  constructor(private readonly player: Player) {}

  init(mg: Game, ticks: number): void {
    const me = this.player;
    const block = ghostBlock(
      mg.config().timeWarp(),
      me.isAlive(),
      mg.inSpawnPhase(),
      Math.floor(mg.elapsedGameSeconds() * 10),
      ticks,
      { used: me.ghostUses(), readyTick: me.ghostReadyTick() },
      me.gold(),
    );
    const log = mg.chronoLog();
    if (block !== "ok" || log === null) return;

    // The newest tile lost in the window that the taker still holds
    let anchor = -1;
    let takerID = 0;
    log.forEachLoss(me.smallID(), ticks - GHOST_WINDOW_TICKS, (tile, taker) => {
      if (anchor !== -1) return;
      if (mg.ownerID(tile) !== taker) return;
      if (!mg.isLand(tile) || mg.isImpassable(tile)) return;
      const t = mg.playerBySmallID(taker);
      if (!t.isPlayer() || t.isFriendly(me) || !t.isAlive()) return;
      anchor = tile;
      takerID = taker;
    });
    if (anchor === -1) return; // nothing lost lately: nothing to haunt
    const taker = mg.playerBySmallID(takerID) as Player;
    const troops = Math.floor((me.troops() * GHOST_TROOP_PERCENT) / 100);
    if (troops < 1) return;

    me.removeGold(ghostCost(me.gold()));
    const army = me.removeTroops(troops);
    log.paused = true; // the ghost's foothold can't be echoed back
    me.conquer(anchor);
    log.paused = false;
    me.markGhost(ticks + GHOST_COOLDOWN_TICKS, {
      tile: anchor,
      tick: ticks,
      target: takerID,
    });
    this.anchor = anchor;
    // removeTroops = false: the army was taken above; like a boat landing,
    // survivors of a retreat go home
    mg.addExecution(new AttackExecution(army, me, taker.id(), anchor, false));

    mg.displayMessage(
      "events_display.time_ghost_used",
      MessageType.CAPTURED_ENEMY_UNIT,
      me.id(),
      undefined,
      { name: taker.displayName() },
    );
    mg.displayMessage(
      "events_display.time_ghost_against",
      MessageType.NAVAL_INVASION_INBOUND,
      taker.id(),
      undefined,
      { name: me.displayName() },
    );
  }

  tick(_: number): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
