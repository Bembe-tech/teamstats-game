import { AirDropExecution } from "../src/core/execution/AirDropExecution";
import { CargoPlaneExecution } from "../src/core/execution/CargoPlaneExecution";
import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { NukeExecution } from "../src/core/execution/NukeExecution";
import { PortExecution } from "../src/core/execution/PortExecution";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import {
  AIR_DROP_COOLDOWN_TICKS,
  AIR_DROP_COST,
} from "../src/core/game/Airports";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { GameID } from "../src/core/Schemas";
import { setup } from "./util/Setup";
import { constructionExecution, executeTicks } from "./util/utils";

const gameID: GameID = "game_id";

// "plains" is 100x100 land without any water: ports can never be built there,
// airports can.
async function makeGame(
  airports: boolean,
  extra: Record<string, unknown> = {},
): Promise<{ game: Game; p: Player; q: Player }> {
  const game = await setup("plains", {
    instantBuild: true,
    airports,
    ...extra,
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
  p.addGold(10_000_000n);
  q.addGold(10_000_000n);
  p.addTroops(100_000);
  q.addTroops(100_000);
  return { game, p, q };
}

describe("Airports and Planes", () => {
  test("an airport goes inland, a port cannot without water", async () => {
    const off = await makeGame(false);
    constructionExecution(off.game, off.p, 15, 15, UnitType.Port);
    expect(off.p.units(UnitType.Port)).toHaveLength(0);

    const on = await makeGame(true);
    constructionExecution(on.game, on.p, 15, 15, UnitType.Port);
    expect(on.p.units(UnitType.Port)).toHaveLength(1);
  });

  test("a cargo plane flies straight over land and pays both sides", async () => {
    const { game, p, q } = await makeGame(true);
    constructionExecution(game, p, 15, 15, UnitType.Port);
    constructionExecution(game, q, 80, 80, UnitType.Port);
    const src = p.units(UnitType.Port)[0];
    const dst = q.units(UnitType.Port)[0];
    const pGold = p.gold();
    const qGold = q.gold();
    game.addExecution(new CargoPlaneExecution(p, src, dst));
    executeTicks(game, 2);
    const plane = p.units(UnitType.TradeShip)[0];
    expect(plane).toBeDefined();
    expect(game.isLand(plane.tile())).toBe(true);
    // 65 tiles diagonal at 2 tiles per tick
    executeTicks(game, 40);
    expect(p.units(UnitType.TradeShip)).toHaveLength(0);
    const expected = game
      .config()
      .tradeShipGold(game.manhattanDist(src.tile(), dst.tile()), p);
    expect(p.gold() - pGold).toBeGreaterThanOrEqual(expected);
    expect(q.gold() - qGold).toBeGreaterThanOrEqual(expected);
  });

  test("airports find each other without shared water", async () => {
    const { game, p, q } = await makeGame(true);
    constructionExecution(game, p, 15, 15, UnitType.Port);
    constructionExecution(game, q, 80, 80, UnitType.Port);
    const exec = new PortExecution(p.units(UnitType.Port)[0]);
    exec.init(game, game.ticks());
    expect(exec.tradingPorts().length).toBeGreaterThan(0);
  });

  test("a troop plane lands far away and attacks there", async () => {
    const { game, p, q } = await makeGame(true);
    // Unowned land 30 tiles past p's border, nowhere near any shore
    const target = game.ref(60, 10);
    const gold = p.gold();
    game.addExecution(new AirDropExecution(p, target, 5000));
    executeTicks(game, 2);
    const plane = p.units(UnitType.TransportShip)[0];
    expect(plane).toBeDefined();
    // Paid for the plane (a little worker income came in meanwhile)
    expect(p.gold()).toBeLessThan(gold - BigInt(AIR_DROP_COST) + 10_000n);
    executeTicks(game, 30);
    expect(plane.isActive()).toBe(false);
    expect(plane.destroyer()).toBeUndefined();
    expect(game.owner(target)).toBe(p);
    expect(q.isAlive()).toBe(true);
  });

  test("troop planes have a cooldown", async () => {
    const { game, p } = await makeGame(true);
    game.addExecution(new AirDropExecution(p, game.ref(85, 85), 1000));
    executeTicks(game, 2);
    expect(p.canBuild(UnitType.TransportShip, game.ref(70, 90))).toBe(false);
    executeTicks(game, AIR_DROP_COOLDOWN_TICKS);
    expect(p.canBuild(UnitType.TransportShip, game.ref(70, 90))).not.toBe(
      false,
    );
  });

  test("a fighter shoots a troop plane down", async () => {
    const { game, p, q } = await makeGame(true);
    constructionExecution(game, q, 80, 80, UnitType.Port);
    // Fighter patrols over q's corner the plane flies to
    game.addExecution(
      new ConstructionExecution(q, UnitType.Warship, game.ref(70, 70)),
    );
    executeTicks(game, 15);
    expect(q.units(UnitType.Warship)).toHaveLength(1);
    game.addExecution(new AirDropExecution(p, game.ref(85, 85), 5000));
    executeTicks(game, 2);
    const plane = p.units(UnitType.TransportShip)[0];
    executeTicks(game, 60);
    expect(plane.isActive()).toBe(false);
    expect(plane.destroyer()).toBe(q);
    expect(game.owner(game.ref(85, 85))).toBe(q);
  });

  test("a fighter intercepts a cargo plane and gets its gold", async () => {
    // Self Economy: p's cargo flies between p's own two airports, past q
    const { game, p, q } = await makeGame(true, { homeEconomy: true });
    for (let x = 30; x < 65; x++) {
      for (let y = 0; y < 30; y++) p.conquer(game.ref(x, y));
    }
    constructionExecution(game, p, 5, 5, UnitType.Port);
    constructionExecution(game, p, 60, 5, UnitType.Port);
    constructionExecution(game, q, 80, 80, UnitType.Port);
    // q's fighter patrols over p's route
    game.addExecution(
      new ConstructionExecution(q, UnitType.Warship, game.ref(32, 6)),
    );
    executeTicks(game, 40);
    const [a, b] = p.units(UnitType.Port);
    game.addExecution(new CargoPlaneExecution(p, a, b));
    executeTicks(game, 3);
    const plane = p.units(UnitType.TradeShip)[0];
    expect(plane).toBeDefined();
    let caught = false;
    for (let i = 0; i < 40 && plane.isActive(); i++) {
      executeTicks(game, 1);
      if (plane.owner() === q) caught = true;
    }
    expect(caught).toBe(true);
    const qGold = q.gold();
    executeTicks(game, 80);
    expect(plane.isActive()).toBe(false);
    expect(plane.wasDestroyedByEnemy()).toBe(false);
    // Landed at q's airport: q got the cargo gold
    expect(q.gold() - qGold).toBeGreaterThan(20_000n);
  });

  test("a nuke does not bring a plane down", async () => {
    const { game, p, q } = await makeGame(true, { infiniteGold: true });
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
    // Detonate an atom bomb right on the plane
    const nuke = new NukeExecution(
      UnitType.AtomBomb,
      q,
      plane.tile(),
      plane.tile(),
    );
    game.addExecution(nuke);
    executeTicks(game, 3);
    expect(plane.isActive()).toBe(true);
  });

  test("fighters take off from an airport", async () => {
    const { game, q } = await makeGame(true);
    expect(q.canBuild(UnitType.Warship, game.ref(50, 50))).toBe(false);
    constructionExecution(game, q, 80, 80, UnitType.Port);
    expect(q.canBuild(UnitType.Warship, game.ref(50, 50))).toBe(
      q.units(UnitType.Port)[0].tile(),
    );
  });
});
