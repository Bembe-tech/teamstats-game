// TeamStats.Pro "OpenFront 4D": the Time Echo gives back recently lost land,
// freezes attacks on the player for a moment, and has uses, a cooldown and a
// gold cost (rules in src/core/game/TimeWarp.ts).
import { AttackExecution } from "../src/core/execution/AttackExecution";
import { TimeEchoExecution } from "../src/core/execution/TimeEchoExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import {
  ChronoLog,
  ECHO_COOLDOWN_TICKS,
  ECHO_MAX_USES,
  ECHO_SHIELD_TICKS,
  ECHO_WINDOW_TICKS,
  echoCost,
} from "../src/core/game/TimeWarp";
import { setup } from "./util/Setup";

let game: Game;
let a: Player;
let b: Player;

function echo(p: Player): TimeEchoExecution {
  const e = new TimeEchoExecution(p);
  e.init(game, game.ticks());
  return e;
}

function step(n: number) {
  for (let i = 0; i < n; i++) game.executeNextTick();
}

describe("Time Echo", () => {
  beforeEach(async () => {
    game = await setup("plains", { timeWarp: true }, [
      new PlayerInfo("a", PlayerType.Human, null, "a_id"),
      new PlayerInfo("b", PlayerType.Human, null, "b_id"),
    ]);
    a = game.player("a_id");
    b = game.player("b_id");
    for (let x = 0; x < 20; x++)
      for (let y = 0; y < 10; y++) a.conquer(game.ref(x, y));
    for (let x = 20; x < 30; x++)
      for (let y = 0; y < 10; y++) b.conquer(game.ref(x, y));
    game.elapsedGameSeconds = () => 600; // past the land-grab lock
    a.addGold(1_000_000n);
  });

  test("gives back land lost in the window, still held by the taker", () => {
    step(1);
    for (let y = 0; y < 10; y++) b.conquer(game.ref(19, y)); // 10 lost now
    const e = echo(a);
    expect(e.restored).toBe(10);
    for (let y = 0; y < 10; y++) expect(game.owner(game.ref(19, y))).toBe(a);
    expect(a.echoUses()).toBe(1);
  });

  test("land lost before the window does not come back", () => {
    for (let y = 0; y < 10; y++) b.conquer(game.ref(19, y));
    step(ECHO_WINDOW_TICKS + 5);
    for (let y = 0; y < 5; y++) b.conquer(game.ref(18, y));
    const e = echo(a);
    expect(e.restored).toBe(5);
    expect(game.owner(game.ref(19, 0))).toBe(b);
  });

  test("a tile that changed hands again is skipped", () => {
    const t = game.ref(19, 0);
    b.conquer(t);
    b.conquer(game.ref(19, 1));
    a.conquer(t); // a got it back already
    expect(echo(a).restored).toBe(1); // only (19, 1)
    expect(game.owner(t)).toBe(a);
    expect(game.owner(game.ref(19, 1))).toBe(a);
  });

  test("costs gold, has a cooldown and a use limit", () => {
    const gold = a.gold();
    echo(a);
    expect(a.gold()).toBe(gold - echoCost(gold));
    expect(a.echoReadyTick()).toBe(game.ticks() + ECHO_COOLDOWN_TICKS);
    // In cooldown: nothing happens
    b.conquer(game.ref(19, 0));
    expect(echo(a).restored).toBe(0);
    expect(a.echoUses()).toBe(1);
    // Uses run out
    for (let i = 1; i < ECHO_MAX_USES + 2; i++) {
      step(ECHO_COOLDOWN_TICKS);
      a.addGold(1_000_000n);
      echo(a);
    }
    expect(a.echoUses()).toBe(ECHO_MAX_USES);
  });

  test("not enough gold: no echo", () => {
    a.removeGold(a.gold());
    b.conquer(game.ref(19, 0));
    expect(echo(a).restored).toBe(0);
    expect(a.echoUses()).toBe(0);
  });

  test("off when the lobby has no 4D", async () => {
    const g = await setup("plains", {}, [
      new PlayerInfo("a", PlayerType.Human, null, "a_id"),
    ]);
    expect(g.chronoLog()).toBeNull();
    const p = g.player("a_id");
    p.addGold(1_000_000n);
    g.elapsedGameSeconds = () => 600;
    const e = new TimeEchoExecution(p);
    e.init(g, g.ticks());
    expect(p.echoUses()).toBe(0);
  });

  test("land attacks on the player freeze during the shield", () => {
    b.addTroops(50_000);
    echo(a);
    game.addExecution(new AttackExecution(20_000, b, a.id(), null));
    const tilesA = a.numTilesOwned();
    step(ECHO_SHIELD_TICKS - 2);
    expect(a.numTilesOwned()).toBe(tilesA);
    step(30);
    expect(a.numTilesOwned()).toBeLessThan(tilesA);
  });

  test("restored land cannot be echoed back by the attacker", () => {
    for (let y = 0; y < 10; y++) b.conquer(game.ref(19, y));
    echo(a);
    b.addGold(1_000_000n);
    expect(echo(b).restored).toBe(0);
  });
});

describe("ChronoLog", () => {
  test("ring keeps the newest entries", () => {
    const log = new ChronoLog();
    const n = ChronoLog.CAPACITY + 10;
    for (let i = 0; i < n; i++) log.record(i, i, 1, 2);
    expect(log.entries()).toBe(ChronoLog.CAPACITY);
    const seen: number[] = [];
    log.forEachLoss(1, n - 3, (t) => seen.push(t));
    expect(seen).toEqual([n - 1, n - 2, n - 3]);
  });
});
