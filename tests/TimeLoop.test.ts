// TeamStats.Pro "OpenFront 4D": the Time Loop puts the player's land back
// the way it was LOOP_WINDOW_TICKS ago, once a game.
import { TimeLoopExecution } from "../src/core/execution/TimeLoopExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { LOOP_WINDOW_TICKS } from "../src/core/game/TimeWarp";
import { setup } from "./util/Setup";

let game: Game;
let a: Player;
let b: Player;

function loop(p: Player): TimeLoopExecution {
  const e = new TimeLoopExecution(p);
  e.init(game, game.ticks());
  return e;
}

function step(n: number) {
  for (let i = 0; i < n; i++) game.executeNextTick();
}

describe("Time Loop", () => {
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
    game.elapsedGameSeconds = () => 600;
    a.addGold(1_000_000n);
    a.addTroops(50_000);
    step(LOOP_WINDOW_TICKS + 1); // the setup land is older than the window
  });

  test("lost land comes back, land taken since goes back", () => {
    for (let y = 0; y < 10; y++) b.conquer(game.ref(19, y)); // a lost 10
    for (let y = 0; y < 5; y++) a.conquer(game.ref(20, y)); // a took 5
    a.conquer(game.ref(0, 15)); // and 1 empty tile
    const gold = a.gold();
    const e = loop(a);
    expect(e.regained).toBe(10);
    expect(e.returned).toBe(6);
    expect(game.owner(game.ref(19, 3))).toBe(a);
    expect(game.owner(game.ref(20, 3))).toBe(b);
    expect(game.owner(game.ref(0, 15)).isPlayer()).toBe(false);
    expect(a.gold()).toBeLessThan(gold);
    expect(a.loopUses()).toBe(1);
  });

  test("only once a game", () => {
    loop(a);
    b.conquer(game.ref(19, 0));
    const e = loop(a);
    expect(e.regained).toBe(0);
    expect(game.owner(game.ref(19, 0))).toBe(b);
  });

  test("changes older than the window stay", () => {
    for (let y = 0; y < 10; y++) b.conquer(game.ref(19, y));
    step(LOOP_WINDOW_TICKS + 5);
    expect(loop(a).regained).toBe(0);
    expect(game.owner(game.ref(19, 0))).toBe(b);
  });

  test("not in the first minutes", () => {
    game.elapsedGameSeconds = () => 60;
    b.conquer(game.ref(19, 0));
    expect(loop(a).regained).toBe(0);
    expect(a.loopUses()).toBe(0);
  });
});
