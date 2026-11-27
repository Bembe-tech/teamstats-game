// TeamStats.Pro "Troops and Workers" (troopsAndWorkers): the old OpenFront
// population split. Workers make the gold, troops fight, a slider sets the split.
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import { TroopRatioExecution } from "../src/core/execution/TroopRatioExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { WORKFORCE } from "../src/core/game/Workforce";
import {
  ClientIntentMessageSchema,
  GameConfigSchema,
  GameID,
} from "../src/core/Schemas";
import { decodeClientMessage, encodeClientMessage } from "../src/core/ZbinWire";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

const gameID: GameID = "game_id";

async function makeGame(
  troopsAndWorkers: boolean,
): Promise<{ game: Game; a: Player }> {
  const game = await setup(
    "plains",
    troopsAndWorkers ? { troopsAndWorkers } : {},
  );
  const ia = new PlayerInfo("a", PlayerType.Human, null, "a");
  game.addPlayer(ia);
  game.addExecution(new SpawnExecution(gameID, ia, game.ref(50, 50)));
  while (game.inSpawnPhase()) game.executeNextTick();
  executeTicks(game, 2);
  return { game, a: game.player("a") };
}

describe("Troops and Workers", () => {
  test("off by default: no workers, flat gold", async () => {
    const { game, a } = await makeGame(false);
    executeTicks(game, 100);
    expect(a.workers()).toBe(0);
    expect(game.config().goldAdditionRate(a)).toBe(100n);
  });

  test("population splits towards the start ratio and workers make gold", async () => {
    const { game, a } = await makeGame(true);
    expect(a.targetTroopPercent()).toBe(WORKFORCE.startPercent);
    executeTicks(game, 300);
    const pop = a.troops() + a.workers();
    expect(a.workers()).toBeGreaterThan(0);
    expect(a.troops() / pop).toBeCloseTo(WORKFORCE.startPercent / 100, 1);
    const expected = BigInt(Math.floor(0.045 * a.workers() ** 0.7));
    const rate = game.config().goldAdditionRate(a);
    expect(Number(rate)).toBeGreaterThan(0);
    expect(Math.abs(Number(rate - expected))).toBeLessThanOrEqual(1);
  });

  test("more workers make more gold but leave fewer troops", async () => {
    const low = await makeGame(true);
    const high = await makeGame(true);
    low.game.addExecution(new TroopRatioExecution(low.a, 90));
    high.game.addExecution(new TroopRatioExecution(high.a, 20));
    executeTicks(low.game, 600);
    executeTicks(high.game, 600);
    expect(high.a.targetTroopPercent()).toBe(20);
    expect(high.a.workers()).toBeGreaterThan(low.a.workers());
    expect(high.a.troops()).toBeLessThan(low.a.troops());
    expect(high.a.gold()).toBeGreaterThan(low.a.gold());
  });

  test("population stays under the cap", async () => {
    const { game, a } = await makeGame(true);
    executeTicks(game, 3000);
    const cap = game.config().maxTroops(a);
    expect(a.troops() + a.workers()).toBeLessThanOrEqual(cap + 1);
    expect(game.config().troopCap(a)).toBeCloseTo(cap * 0.7, 0);
  });

  test("troop ratio is ignored when the mode is off", async () => {
    const { game, a } = await makeGame(false);
    game.addExecution(new TroopRatioExecution(a, 10));
    executeTicks(game, 2);
    expect(a.targetTroopPercent()).toBe(WORKFORCE.startPercent);
    expect(a.workers()).toBe(0);
  });

  test("workforce view reaches the update", async () => {
    const { game, a } = await makeGame(true);
    executeTicks(game, 50);
    a.setTargetTroopPercent(40);
    const view = a.workforce()!;
    expect(view.percent).toBe(40);
    expect(view.workers).toBe(a.workers());
  });

  test("troop_ratio intent and config parse and ride the wire", () => {
    const msg = ClientIntentMessageSchema.parse({
      type: "intent",
      intent: { type: "troop_ratio", percent: 35 },
    });
    const back = decodeClientMessage(
      encodeClientMessage(msg, undefined),
      undefined,
    );
    expect(back).toMatchObject({
      intent: { type: "troop_ratio", percent: 35 },
    });
    const cfg = GameConfigSchema.partial().parse({ troopsAndWorkers: true });
    expect(cfg.troopsAndWorkers).toBe(true);
    expect(() =>
      ClientIntentMessageSchema.parse({
        type: "intent",
        intent: { type: "troop_ratio", percent: 0 },
      }),
    ).toThrow();
  });
});
