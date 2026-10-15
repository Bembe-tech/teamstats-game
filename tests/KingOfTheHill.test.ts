// TeamStats.Pro "King of the Hill": the biggest player holds the crown and
// collects crown time; after 30 minutes the longest holder wins.
import {
  crownHolder,
  KingOfTheHillExecution,
} from "../src/core/execution/KingOfTheHillExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { setup } from "./util/Setup";

let game: Game;
let big: Player;
let small: Player;

describe("King of the Hill", () => {
  beforeEach(async () => {
    game = await setup("half_land_half_ocean", { kingOfTheHill: true }, [
      new PlayerInfo("big", PlayerType.Human, null, "big_id"),
      new PlayerInfo("small", PlayerType.Human, null, "small_id"),
    ]);
    big = game.player("big_id");
    small = game.player("small_id");
    for (let x = 0; x < 6; x++) big.conquer(game.ref(x, 0));
    small.conquer(game.ref(0, 5));
  });

  test("the player with the most land holds the crown", () => {
    expect(crownHolder(game)).toBe(big);
  });

  test("the crown holder collects a second per second", () => {
    const exec = new KingOfTheHillExecution();
    exec.init(game, 0);
    exec.tick(10);
    exec.tick(15); // not a whole second: ignored
    exec.tick(20);
    expect(big.crownTicks()).toBe(20);
    expect(small.crownTicks()).toBe(0);
  });

  test("after 30 minutes the longest holder wins, not the biggest", () => {
    small.addCrownTicks(5000);
    big.addCrownTicks(100);
    game.elapsedGameSeconds = () => 30 * 60;
    let winner: unknown = undefined;
    game.setWinner = (w) => {
      winner = w;
    };
    const exec = new KingOfTheHillExecution();
    exec.init(game, 0);
    exec.tick(10);
    expect(winner).toBe(small);
    expect(exec.isActive()).toBe(false);
  });

  test("the lobby sets the length (here 10 minutes)", () => {
    game.config().kingOfTheHillMinutes = () => 10;
    small.addCrownTicks(50);
    let winner: unknown = undefined;
    game.setWinner = (w) => {
      winner = w;
    };
    const exec = new KingOfTheHillExecution();
    exec.init(game, 0);
    game.elapsedGameSeconds = () => 9 * 60;
    exec.tick(10);
    expect(winner).toBeUndefined();
    game.elapsedGameSeconds = () => 10 * 60;
    exec.tick(20);
    expect(winner).toBe(small); // 50 ticks vs big's 20
  });
});
