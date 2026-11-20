// TeamStats.Pro "OpenFront 4D": the Time Echo (rules in game/TimeWarp.ts).
// Runs on every client on the same tick, like any other intent.
import { Execution, Game, MessageType, Player } from "../game/Game";
import {
  ChronoMode,
  ECHO_COOLDOWN_TICKS,
  ECHO_SHIELD_TICKS,
  ECHO_WINDOW_TICKS,
  echoBlock,
  echoCost,
  echoRestoreCap,
  PARADOX_TROOP_PERCENT,
} from "../game/TimeWarp";

export class TimeEchoExecution implements Execution {
  /** Tiles given back by the last run (for tests and the nation AI). */
  restored = 0;

  constructor(private readonly player: Player) {}

  init(mg: Game, ticks: number): void {
    const me = this.player;
    const block = echoBlock(
      mg.config().timeWarp(),
      me.isAlive(),
      mg.inSpawnPhase(),
      Math.floor(mg.elapsedGameSeconds() * 10),
      ticks,
      { used: me.echoUses(), readyTick: me.echoReadyTick() },
      me.gold(),
    );
    const log = mg.chronoLog();
    if (block !== "ok" || log === null) return;

    const mine = me.smallID();
    const cap = echoRestoreCap(me.numTilesOwned());
    // Newest losses first; a tile lost twice in the window counts once.
    const seen = new Set<number>();
    const tiles: number[] = [];
    const takers = new Map<number, number>(); // smallID -> tiles taken back
    // Land the other side took back with its own Echo / Loop: a paradox
    const clash = new Map<number, number[]>(); // smallID -> tiles
    log.forEachLoss(mine, ticks - ECHO_WINDOW_TICKS, (tile, taker, kind) => {
      if (tiles.length >= cap || seen.has(tile) || taker === 0) return;
      seen.add(tile);
      if (mg.ownerID(tile) !== taker) return; // changed hands again since
      if (!mg.isLand(tile) || mg.isImpassable(tile)) return;
      const owner = mg.playerBySmallID(taker);
      if (!owner.isPlayer() || owner.isFriendly(me)) return;
      if (kind === ChronoMode.Restored) {
        const list = clash.get(taker) ?? [];
        list.push(tile);
        clash.set(taker, list);
        return;
      }
      tiles.push(tile);
      takers.set(taker, (takers.get(taker) ?? 0) + 1);
    });

    me.removeGold(echoCost(me.gold()));
    log.mode = ChronoMode.Restored;
    // Oldest loss last, so the land comes back from the inside out
    for (let i = tiles.length - 1; i >= 0; i--) me.conquer(tiles[i]);
    let won = 0;
    for (const [other, list] of clash) {
      won += resolveParadox(mg, me, other, list, ticks);
    }
    log.mode = ChronoMode.Normal;
    me.markEcho(ticks, ticks + ECHO_COOLDOWN_TICKS, ticks + ECHO_SHIELD_TICKS);
    this.restored = tiles.length + won;

    mg.displayMessage(
      "events_display.time_echo_used",
      MessageType.CAPTURED_ENEMY_UNIT,
      me.id(),
      undefined,
      { tiles: tiles.length, seconds: ECHO_SHIELD_TICKS / 10 },
    );
    for (const [taker, n] of takers) {
      const p = mg.playerBySmallID(taker);
      if (!p.isPlayer()) continue;
      mg.displayMessage(
        "events_display.time_echo_against",
        MessageType.ATTACK_FAILED,
        p.id(),
        undefined,
        { name: me.displayName(), tiles: n, seconds: ECHO_SHIELD_TICKS / 10 },
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

/**
 * Two Time Echoes / Loops claim the same land at the same moment: the
 * bigger army wins it, the other side loses PARADOX_TROOP_PERCENT of its
 * troops. Returns the tiles `me` got. Called with the log in Restored mode.
 */
export function resolveParadox(
  mg: Game,
  me: Player,
  otherID: number,
  tiles: number[],
  ticks: number,
): number {
  const other = mg.playerBySmallID(otherID);
  if (!other.isPlayer()) return 0;
  const won = me.troops() > other.troops();
  const loser = won ? other : me;
  loser.removeTroops(
    Math.floor((loser.troops() * PARADOX_TROOP_PERCENT) / 100),
  );
  let got = 0;
  if (won) {
    for (const t of tiles) {
      if (mg.ownerID(t) === otherID) {
        me.conquer(t);
        got++;
      }
    }
  }
  me.markParadox({
    tile: tiles[0],
    tick: ticks,
    other: otherID,
    won,
    tiles: tiles.length,
  });
  for (const p of [me, other]) {
    mg.displayMessage(
      "events_display.time_paradox",
      MessageType.NUKE_INBOUND,
      p.id(),
      undefined,
      {
        winner: (won ? me : other).displayName(),
        loser: (won ? other : me).displayName(),
        tiles: tiles.length,
        pct: PARADOX_TROOP_PERCENT,
      },
    );
  }
  return got;
}
