// TeamStats.Pro "OpenFront 4D": delayed orders fire on the planned tick.
import { Executor } from "../src/core/execution/ExecutionManager";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { ORDER_MAX_PENDING } from "../src/core/game/TimeWarp";
import { setup } from "./util/Setup";

let game: Game;
let a: Player;
let b: Player;
let ex: Executor;

function step(n: number) {
  for (let i = 0; i < n; i++) game.executeNextTick();
}

describe("Delayed orders", () => {
  beforeEach(async () => {
    game = await setup("plains", { timeWarp: true }, [
      new PlayerInfo("a", PlayerType.Human, "CLa", "a_id"),
      new PlayerInfo("b", PlayerType.Human, "CLb", "b_id"),
    ]);
    a = game.player("a_id");
    b = game.player("b_id");
    for (let x = 0; x < 20; x++)
      for (let y = 0; y < 10; y++) a.conquer(game.ref(x, y));
    for (let x = 20; x < 30; x++)
      for (let y = 0; y < 10; y++) b.conquer(game.ref(x, y));
    a.addTroops(50_000);
    ex = new Executor(game, "g", "CLa");
  });

  test("a delayed attack waits, shows on the player, then fires", () => {
    game.addExecution(
      ex.createExec({
        type: "delayed_order",
        delay: 50,
        order: { type: "attack", targetID: "b_id", troops: 20_000 },
        clientID: "CLa",
      }),
    );
    step(2);
    expect(a.delayedOrders().length).toBe(1);
    expect(a.delayedOrders()[0].target).toBe(b.smallID());
    expect(a.outgoingAttacks().length).toBe(0);
    const bTiles = b.numTilesOwned();
    step(40);
    expect(b.numTilesOwned()).toBe(bTiles); // not yet
    step(15);
    expect(a.delayedOrders().length).toBe(0);
    step(20);
    expect(b.numTilesOwned()).toBeLessThan(bTiles);
  });

  test("too short or too long a delay, or too many pending: ignored", () => {
    const send = (delay: number) =>
      game.addExecution(
        ex.createExec({
          type: "delayed_order",
          delay,
          order: { type: "attack", targetID: null, troops: 100 },
          clientID: "CLa",
        }),
      );
    send(5);
    step(1);
    expect(a.delayedOrders().length).toBe(0);
    for (let i = 0; i < ORDER_MAX_PENDING + 2; i++) send(300);
    step(1);
    expect(a.delayedOrders().length).toBe(ORDER_MAX_PENDING);
    const ids = new Set(a.delayedOrders().map((o) => o.id));
    expect(ids.size).toBe(ORDER_MAX_PENDING);
  });

  test("off when the lobby has no 4D", async () => {
    const g = await setup("plains", {}, [
      new PlayerInfo("a", PlayerType.Human, "CLa", "a_id"),
    ]);
    const e = new Executor(g, "g", "CLa");
    g.addExecution(
      e.createExec({
        type: "delayed_order",
        delay: 50,
        order: { type: "attack", targetID: null, troops: 100 },
        clientID: "CLa",
      }),
    );
    g.executeNextTick();
    expect(g.player("a_id").delayedOrders().length).toBe(0);
  });
});
