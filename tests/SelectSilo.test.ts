import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../src/core/game/Game";
import {
  BuildUnitIntentSchema,
  ClientIntentMessageSchema,
  GameConfigSchema,
  GameID,
} from "../src/core/Schemas";
import { setup } from "./util/Setup";
import { constructionExecution, executeTicks } from "./util/utils";

const gameID: GameID = "game_id";

// Select Silo mode: the build_unit intent may name the launch silo.
async function makeGame(selectSilo: boolean): Promise<{
  game: Game;
  p: Player;
  far: Unit;
  near: Unit;
}> {
  const game = await setup("plains", {
    infiniteGold: true,
    instantBuild: true,
    selectSilo,
  });
  const info = new PlayerInfo("p", PlayerType.Human, null, "p");
  game.addPlayer(info);
  game.addExecution(new SpawnExecution(gameID, info, game.ref(1, 1)));
  const p = game.player("p");
  executeTicks(game, 2);
  for (let x = 0; x < 40; x++) {
    for (let y = 0; y < 40; y++) p.conquer(game.ref(x, y));
  }
  constructionExecution(game, p, 2, 2, UnitType.MissileSilo);
  constructionExecution(game, p, 30, 30, UnitType.MissileSilo);
  const silos = p.units(UnitType.MissileSilo);
  const far = silos.find((s) => s.tile() === game.ref(2, 2))!;
  const near = silos.find((s) => s.tile() === game.ref(30, 30))!;
  return { game, p, far, near };
}

function launch(
  game: Game,
  p: Player,
  siloId?: number,
  type = UnitType.AtomBomb,
) {
  game.addExecution(
    new ConstructionExecution(p, type, game.ref(80, 80), true, 1, siloId),
  );
  executeTicks(game, 3);
}

describe("Select Silo mode", () => {
  test("without a chosen silo the nearest one fires", async () => {
    const { game, p, near, far } = await makeGame(true);
    launch(game, p);
    expect(near.isInCooldown()).toBe(true);
    expect(far.isInCooldown()).toBe(false);
  });

  test("a chosen silo fires even when another is nearer", async () => {
    const { game, p, near, far } = await makeGame(true);
    launch(game, p, far.id());
    const bombs = p.units(UnitType.AtomBomb);
    expect(bombs).toHaveLength(1);
    expect(far.isInCooldown()).toBe(true);
    expect(near.isInCooldown()).toBe(false);
  });

  test("a reloading chosen silo does not fall back to another", async () => {
    const { game, p, near, far } = await makeGame(true);
    launch(game, p, far.id());
    launch(game, p, far.id());
    expect(p.units(UnitType.AtomBomb)).toHaveLength(1);
    expect(near.isInCooldown()).toBe(false);
  });

  test("a silo of another player cannot be chosen", async () => {
    const { game, near } = await makeGame(true);
    const info = new PlayerInfo("q", PlayerType.Human, null, "q");
    game.addPlayer(info);
    game.addExecution(new SpawnExecution(gameID, info, game.ref(70, 70)));
    executeTicks(game, 2);
    const q = game.player("q");
    launch(game, q, near.id());
    expect(q.units(UnitType.AtomBomb)).toHaveLength(0);
    expect(near.isInCooldown()).toBe(false);
  });

  test("MIRV uses the chosen silo too", async () => {
    const { game, p, near, far } = await makeGame(true);
    // a MIRV needs an owned target
    const info = new PlayerInfo("q", PlayerType.Human, null, "q");
    game.addPlayer(info);
    game.addExecution(new SpawnExecution(gameID, info, game.ref(80, 80)));
    executeTicks(game, 2);
    launch(game, p, far.id(), UnitType.MIRV);
    expect(far.isInCooldown()).toBe(true);
    expect(near.isInCooldown()).toBe(false);
  });

  test("the choice is ignored when the mode is off", async () => {
    const { game, p, near, far } = await makeGame(false);
    launch(game, p, far.id());
    expect(near.isInCooldown()).toBe(true);
    expect(far.isInCooldown()).toBe(false);
  });

  test("intent schema accepts an optional silo id", () => {
    expect(
      BuildUnitIntentSchema.safeParse({
        type: "build_unit",
        unit: UnitType.AtomBomb,
        tile: 5,
        silo: 12,
      }).success,
    ).toBe(true);
    expect(
      BuildUnitIntentSchema.safeParse({
        type: "build_unit",
        unit: UnitType.AtomBomb,
        tile: 5,
        silo: -1,
      }).success,
    ).toBe(false);
  });
  test("multiplayer: the server keeps the silo id and the lobby flag", () => {
    // The game server relays intents parsed with these schemas; an unknown
    // key would be stripped and the other clients would fire from elsewhere.
    const msg = ClientIntentMessageSchema.parse({
      type: "intent",
      intent: {
        type: "build_unit",
        unit: UnitType.HydrogenBomb,
        tile: 9,
        silo: 4,
      },
    });
    expect(msg.intent).toMatchObject({ silo: 4 });
    const cfg = GameConfigSchema.partial().parse({ selectSilo: true });
    expect(cfg.selectSilo).toBe(true);
  });
});
