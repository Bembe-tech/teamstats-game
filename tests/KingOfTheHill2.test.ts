import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import { ThroneExecution } from "../src/core/execution/ThroneExecution";
import {
  sendToThrone,
  withdrawFromThrone,
} from "../src/core/execution/ThroneOrderExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import {
  ThroneStatus,
  throneGoldPerSecond,
  throneHolderDrain,
  thronePlace,
} from "../src/core/game/Throne";
import {
  ClientIntentMessageSchema,
  GameConfigSchema,
  GameID,
} from "../src/core/Schemas";
import { decodeClientMessage, encodeClientMessage } from "../src/core/ZbinWire";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

const gameID: GameID = "game_id";

async function makeGame(extra: Record<string, unknown> = {}): Promise<{
  game: Game;
  a: Player;
  b: Player;
  exec: ThroneExecution;
}> {
  const game = await setup("plains", {
    kingOfTheHill2: true,
    kingOfTheHill2Minutes: 1,
    ...extra,
  });
  const ia = new PlayerInfo("a", PlayerType.Human, null, "a");
  const ib = new PlayerInfo("b", PlayerType.Human, null, "b");
  game.addPlayer(ia);
  game.addPlayer(ib);
  game.addExecution(new SpawnExecution(gameID, ia, game.ref(5, 5)));
  game.addExecution(new SpawnExecution(gameID, ib, game.ref(95, 95)));
  executeTicks(game, 2);
  const a = game.player("a");
  const b = game.player("b");
  // a: left half incl. the throne zone's left side, b: right half
  for (let x = 0; x < 100; x++) {
    for (let y = 0; y < 100; y++) {
      (x < 50 ? a : b).conquer(game.ref(x, y));
    }
  }
  a.addTroops(100_000 - a.troops());
  b.addTroops(100_000 - b.troops());
  const exec = new ThroneExecution();
  game.addExecution(exec);
  return { game, a, b, exec };
}

describe("King of the Hill 2", () => {
  test("throne is the land tile nearest to the map center", async () => {
    const { game } = await makeGame();
    const place = thronePlace(game.map())!;
    expect(place.x).toBe(50);
    expect(place.y).toBe(50);
    expect(place.radius).toBeGreaterThanOrEqual(8);
  });

  test("garrison powers the throne, gold pays for it, reign grows", async () => {
    const { game, a } = await makeGame();
    a.addGold(10_000_000n);
    expect(sendToThrone(game, a, 60)).toBe(60_000);
    expect(a.troops()).toBe(40_000);
    executeTicks(game, 50);
    const v = a.throne()!;
    expect(v.status).toBe(ThroneStatus.Powered);
    expect(v.reign).toBeGreaterThanOrEqual(4);
    expect(v.garrison).toBeLessThan(60_000); // bleeding
  });

  test("throne needs the army share: low garrison stops the clock", async () => {
    const { game, a } = await makeGame();
    a.addGold(10_000_000n);
    sendToThrone(game, a, 10); // 10% < 30%
    executeTicks(game, 30);
    expect(a.throne()!.status).toBe(ThroneStatus.LowArmy);
    expect(a.throne()!.reign).toBe(0);
  });

  test("no gold, no reign", async () => {
    const { game, a } = await makeGame();
    a.removeGold(a.gold());
    sendToThrone(game, a, 50);
    executeTicks(game, 10); // one second of base income is not enough
    expect(a.throne()!.status).toBe(ThroneStatus.NoGold);
    expect(a.throne()!.reign).toBe(0);
  });

  test("a bigger garrison takes the throne over", async () => {
    const { game, a, b, exec } = await makeGame();
    a.addGold(10_000_000n);
    b.addGold(10_000_000n);
    sendToThrone(game, a, 35);
    executeTicks(game, 30);
    expect(exec.holderKey()).toBe(`p:${a.smallID()}`);
    sendToThrone(game, b, 60);
    executeTicks(game, 20);
    expect(exec.holderKey()).toBe(`p:${b.smallID()}`);
    expect(a.throne()!.status).toBe(ThroneStatus.None);
    // a's reign is kept for later
    expect(a.throne()!.reign).toBeGreaterThan(0);
  });

  test("withdraw brings the whole garrison home", async () => {
    const { game, a } = await makeGame();
    sendToThrone(game, a, 40);
    const g = a.throneGarrison();
    const before = a.troops();
    expect(withdrawFromThrone(game, a)).toBe(g);
    expect(a.troops()).toBe(before + g);
    expect(a.throneGarrison()).toBe(0);
  });

  test("no tile in the zone: cannot send", async () => {
    const { game, a, b } = await makeGame();
    for (let x = 30; x < 70; x++) {
      for (let y = 30; y < 70; y++) b.conquer(game.ref(x, y));
    }
    expect(sendToThrone(game, a, 40)).toBe(0);
  });

  test("first side with the reign time wins", async () => {
    const { game, a } = await makeGame();
    a.addGold(100_000_000n);
    sendToThrone(game, a, 60);
    // keep the garrison topped up against the bleed
    for (let s = 0; s < 70 && game.getWinner() === null; s++) {
      executeTicks(game, 10);
      if (a.throneGarrison() * 100 < 35 * (a.troops() + a.throneGarrison())) {
        sendToThrone(game, a, 20);
      }
    }
    expect(game.getWinner()).toBe(a);
  });

  test("players cannot spawn in the throne zone", async () => {
    const game = await setup(
      "plains",
      { kingOfTheHill2: true },
      [],
      undefined,
      undefined,
      false,
    );
    const info = new PlayerInfo("s", PlayerType.Human, null, "s");
    game.addPlayer(info);
    game.addExecution(new SpawnExecution(gameID, info, game.ref(50, 50), true));
    executeTicks(game, 2);
    expect(game.player("s").numTilesOwned()).toBe(0);
    game.addExecution(new SpawnExecution(gameID, info, game.ref(10, 10), true));
    executeTicks(game, 2);
    expect(game.player("s").numTilesOwned()).toBeGreaterThan(0);
  });

  test("costs grow with reign time", () => {
    expect(throneGoldPerSecond(200)).toBeGreaterThan(throneGoldPerSecond(0));
    expect(throneHolderDrain(200)).toBeGreaterThan(throneHolderDrain(0));
  });

  test("throne intent and config parse and ride the wire", () => {
    const msg = ClientIntentMessageSchema.parse({
      type: "intent",
      intent: { type: "throne", action: "send", percent: 20 },
    });
    const back = decodeClientMessage(
      encodeClientMessage(msg, undefined),
      undefined,
    );
    expect(back).toMatchObject({
      intent: { type: "throne", action: "send", percent: 20 },
    });
    const cfg = GameConfigSchema.partial().parse({
      kingOfTheHill2: true,
      kingOfTheHill2Minutes: 5,
      kingOfTheHill2ArmyShare: 30,
    });
    expect(cfg.kingOfTheHill2ArmyShare).toBe(30);
  });
});
