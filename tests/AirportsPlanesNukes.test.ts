import { vi } from "vitest";
import { AirDropExecution } from "../src/core/execution/AirDropExecution";
import { CargoPlaneExecution } from "../src/core/execution/CargoPlaneExecution";
import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { NukeExecution } from "../src/core/execution/NukeExecution";
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
import { NukeType } from "../src/core/StatsSchemas";
import { setup } from "./util/Setup";
import { constructionExecution, executeTicks } from "./util/utils";

const gameID: GameID = "game_id";

// "plains" is 100x100 land without water: in Airports and Planes the
// "ships" there are planes.
async function makeGame(): Promise<{ game: Game; p: Player; q: Player }> {
  const game = await setup("plains", {
    instantBuild: true,
    airports: true,
    infiniteGold: true,
  });
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
  p.addTroops(100_000);
  q.addTroops(100_000);
  // The test config shrinks every blast to 1 tile; use the real game radii
  vi.spyOn(game.config(), "nukeMagnitudes").mockImplementation((t) =>
    t === UnitType.HydrogenBomb
      ? { inner: 80, outer: 100 }
      : t === UnitType.MIRVWarhead
        ? { inner: 12, outer: 18 }
        : { inner: 12, outer: 30 },
  );
  return { game, p, q };
}

function cargoPlane(game: Game, p: Player, q: Player): Unit {
  constructionExecution(game, p, 15, 15, UnitType.Port);
  constructionExecution(game, q, 80, 80, UnitType.Port);
  game.addExecution(
    new CargoPlaneExecution(
      p,
      p.units(UnitType.Port)[0],
      q.units(UnitType.Port)[0],
    ),
  );
  executeTicks(game, 10);
  const plane = p.units(UnitType.TradeShip)[0];
  expect(plane).toBeDefined();
  return plane;
}

function fighter(game: Game, p: Player): Unit {
  constructionExecution(game, p, 15, 15, UnitType.Port);
  game.addExecution(
    new ConstructionExecution(p, UnitType.Warship, game.ref(20, 20)),
  );
  executeTicks(game, 15);
  const f = p.units(UnitType.Warship)[0];
  expect(f).toBeDefined();
  return f;
}

function troopPlane(game: Game, p: Player): Unit {
  game.addExecution(new AirDropExecution(p, game.ref(60, 10), 5000));
  executeTicks(game, 2);
  const plane = p.units(UnitType.TransportShip)[0];
  expect(plane).toBeDefined();
  return plane;
}

function silo(by: Player) {
  if (by.units(UnitType.MissileSilo).length > 0) return;
  const t = by.tiles().values().next().value!;
  by.buildUnit(UnitType.MissileSilo, t, {});
}

function detonate(game: Game, by: Player, type: NukeType, at: Unit) {
  silo(by);
  // A very fast bomb so it lands before the plane flies away
  game.addExecution(new NukeExecution(type, by, at.tile(), at.tile(), 10_000));
  executeTicks(game, 2);
  let n = 0;
  while (by.units(type).length > 0 && n < 200) {
    executeTicks(game, 1);
    n++;
  }
}

describe("Airports and Planes: bombs destroy planes in the blast", () => {
  test("an atom bomb destroys a cargo plane", async () => {
    const { game, p, q } = await makeGame();
    const plane = cargoPlane(game, p, q);
    detonate(game, q, UnitType.AtomBomb, plane);
    expect(plane.isActive()).toBe(false);
    expect(plane.destroyer()).toBe(q);
  });

  test("a hydrogen bomb destroys a troop plane", async () => {
    const { game, p, q } = await makeGame();
    const plane = troopPlane(game, p);
    detonate(game, q, UnitType.HydrogenBomb, plane);
    expect(plane.isActive()).toBe(false);
    expect(plane.destroyer()).toBe(q);
  });

  test("a MIRV warhead destroys a fighter", async () => {
    const { game, p, q } = await makeGame();
    const f = fighter(game, p);
    detonate(game, q, UnitType.MIRVWarhead, f);
    expect(f.isActive()).toBe(false);
    expect(f.destroyer()).toBe(q);
  });

  test("a plane outside the blast keeps flying", async () => {
    const { game, p, q } = await makeGame();
    const f = fighter(game, p);
    // Atom bomb outer radius is 30; q's land at (85, 85) is far from p's fighter
    silo(q);
    game.addExecution(
      new NukeExecution(
        UnitType.AtomBomb,
        q,
        game.ref(85, 85),
        game.ref(85, 85),
        10_000,
      ),
    );
    executeTicks(game, 4);
    expect(q.units(UnitType.AtomBomb)).toHaveLength(0);
    expect(f.isActive()).toBe(true);
  });

  test("an own bomb destroys own planes too, without a kill", async () => {
    const { game, p } = await makeGame();
    const f = fighter(game, p);
    detonate(game, p, UnitType.AtomBomb, f);
    expect(f.isActive()).toBe(false);
    expect(f.destroyer()).toBeUndefined();
  });
});
