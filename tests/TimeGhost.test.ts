// TeamStats.Pro "OpenFront 4D": ghosts of the past rise on recently lost
// land and attack the player who took it.
import { TimeGhostExecution } from "../src/core/execution/TimeGhostExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import {
  GHOST_COOLDOWN_TICKS,
  GHOST_TROOP_PERCENT,
  GHOST_WINDOW_TICKS,
} from "../src/core/game/TimeWarp";
import { setup } from "./util/Setup";

let game: Game;
let a: Player;
let b: Player;

function ghost(p: Player): TimeGhostExecution {
  const e = new TimeGhostExecution(p);
  e.init(game, game.ticks());
  return e;
}

function step(n: number) {
  for (let i = 0; i < n; i++) game.executeNextTick();
}

describe("Ghosts of the past", () => {
  beforeEach(async () => {
    game = await setup("plains", { timeWarp: true }, [
      new PlayerInfo("a", PlayerType.Human, null, "a_id"),
      new PlayerInfo("b", PlayerType.Human, null, "b_id"),
    ]);
    a = game.player("a_id");
    b = game.player("b_id");
    for (let x = 0; x < 20; x++)
      for (let y = 0; y < 20; y++) a.conquer(game.ref(x, y));
    for (let x = 20; x < 40; x++)
      for (let y = 0; y < 20; y++) b.conquer(game.ref(x, y));
    game.elapsedGameSeconds = () => 600;
    a.addGold(1_000_000n);
    a.addTroops(100_000);
  });

  test("rises on the newest lost tile and attacks the taker", () => {
    step(1);
    b.conquer(game.ref(19, 5));
    b.conquer(game.ref(19, 6)); // newest loss
    const troops = a.troops();
    const e = ghost(a);
    expect(e.anchor).toBe(game.ref(19, 6));
    expect(game.owner(game.ref(19, 6))).toBe(a);
    expect(a.troops()).toBeCloseTo(
      troops - Math.floor((troops * GHOST_TROOP_PERCENT) / 100),
      -1,
    );
    expect(a.ghostUses()).toBe(1);
    expect(a.lastGhost()?.target).toBe(b.smallID());
    expect(a.ghostReadyTick()).toBe(game.ticks() + GHOST_COOLDOWN_TICKS);
    const bTiles = b.numTilesOwned();
    step(30);
    expect(b.numTilesOwned()).toBeLessThan(bTiles);
  });

  test("nothing lost lately: no ghost, nothing paid", () => {
    b.conquer(game.ref(19, 5));
    step(GHOST_WINDOW_TICKS + 2);
    const gold = a.gold();
    expect(ghost(a).anchor).toBe(-1);
    expect(a.gold()).toBe(gold);
    expect(a.ghostUses()).toBe(0);
  });

  test("cooldown blocks a second ghost", () => {
    b.conquer(game.ref(19, 5));
    b.conquer(game.ref(19, 7));
    ghost(a);
    expect(ghost(a).anchor).toBe(-1);
    expect(a.ghostUses()).toBe(1);
  });
});
