import { AirDropExecution } from "../src/core/execution/AirDropExecution";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../src/core/game/Game";
import { GameID } from "../src/core/Schemas";
import { setup } from "./util/Setup";
import { constructionExecution, executeTicks } from "./util/utils";

const gameID: GameID = "game_id";

// "plains": 100x100 land, no water. p owns the top-left corner, q the
// bottom-right one with a SAM launcher at (80, 80).
async function makeGame(): Promise<{
  game: Game;
  p: Player;
  q: Player;
  sam: Unit;
}> {
  const game = await setup("plains", { instantBuild: true, airports: true });
  const pi = new PlayerInfo("p", PlayerType.Human, null, "p");
  const qi = new PlayerInfo("q", PlayerType.Human, null, "q");
  game.addPlayer(pi);
  game.addPlayer(qi);
  game.addExecution(new SpawnExecution(gameID, pi, game.ref(5, 5)));
  game.addExecution(new SpawnExecution(gameID, qi, game.ref(90, 90)));
  executeTicks(game, 2);
  const p = game.player("p");
  const q = game.player("q");
  for (let x = 0; x < 30; x++) {
    for (let y = 0; y < 30; y++) p.conquer(game.ref(x, y));
  }
  for (let x = 65; x < 100; x++) {
    for (let y = 65; y < 100; y++) q.conquer(game.ref(x, y));
  }
  p.addGold(10_000_000n);
  q.addGold(10_000_000n);
  p.addTroops(100_000);
  q.addTroops(100_000);
  constructionExecution(game, q, 80, 80, UnitType.SAMLauncher);
  const sam = q.units(UnitType.SAMLauncher)[0];
  expect(sam).toBeDefined();
  return { game, p, q, sam };
}

/** Ticks until the plane is gone (or -1 after 80 ticks). */
function runUntilGone(game: Game, plane: Unit): number {
  for (let t = 1; t <= 80; t++) {
    game.executeNextTick();
    if (!plane.isActive()) return t;
  }
  return -1;
}

describe("Airports and Planes: SAMs shoot troop planes", () => {
  test("a SAM shoots an enemy troop plane down before it lands, using no missile", async () => {
    const { game, p, q, sam } = await makeGame();
    const target = game.ref(90, 90);
    game.addExecution(new AirDropExecution(p, target, 5000));
    executeTicks(game, 1);
    const plane = p.units(UnitType.TransportShip)[0];
    expect(plane).toBeDefined();
    expect(runUntilGone(game, plane)).toBeGreaterThan(0);
    expect(plane.destroyer()).toBe(q);
    // It never got to land
    expect(game.owner(target)).toBe(q);
    // No missile spent: the launcher is not reloading
    expect(sam.missileTimerQueue()).toHaveLength(0);
    expect(sam.isInCooldown()).toBe(false);
  });

  test("a reloading SAM still shoots troop planes", async () => {
    const { game, p, q, sam } = await makeGame();
    // Spend every missile (as if it just fired at nukes)
    while (!sam.isInCooldown()) sam.launch();
    game.addExecution(new AirDropExecution(p, game.ref(90, 90), 5000));
    executeTicks(game, 1);
    const plane = p.units(UnitType.TransportShip)[0];
    expect(runUntilGone(game, plane)).toBeGreaterThan(0);
    expect(plane.destroyer()).toBe(q);
  });

  test("an allied troop plane is left alone", async () => {
    const { game, p, q } = await makeGame();
    // Land outside the SAM owner's territory but well inside its range
    const target = game.ref(50, 80);
    p.createAllianceRequest(q)?.accept();
    expect(p.isFriendly(q)).toBe(true);
    game.addExecution(new AirDropExecution(p, target, 5000));
    executeTicks(game, 1);
    const plane = p.units(UnitType.TransportShip)[0];
    expect(plane).toBeDefined();
    runUntilGone(game, plane);
    expect(plane.destroyer()).toBeUndefined();
    expect(game.owner(target)).toBe(p);
  });

  test("the shot happens on the same tick in two identical games", async () => {
    const ticks: number[] = [];
    for (let i = 0; i < 2; i++) {
      const { game, p } = await makeGame();
      game.addExecution(new AirDropExecution(p, game.ref(90, 90), 5000));
      executeTicks(game, 1);
      const plane = p.units(UnitType.TransportShip)[0];
      ticks.push(runUntilGone(game, plane));
    }
    expect(ticks[0]).toBeGreaterThan(0);
    expect(ticks[0]).toBe(ticks[1]);
  });
});
