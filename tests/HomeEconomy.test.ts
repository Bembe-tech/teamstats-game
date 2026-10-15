// TeamStats.Pro "Self Economy" (homeEconomy): no trade with rivals, own ports
// trade with each other, every train stop pays a flat 35k.
import { PortExecution } from "../src/core/execution/PortExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

let game: Game;
let player: Player;
let other: Player;

describe("Self Economy", () => {
  beforeEach(async () => {
    game = await setup(
      "half_land_half_ocean",
      { instantBuild: true, homeEconomy: true },
      [
        new PlayerInfo("player", PlayerType.Human, null, "player_id"),
        new PlayerInfo("other", PlayerType.Human, null, "other_id"),
      ],
    );
    player = game.player("player_id");
    player.addGold(BigInt(1000000));
    other = game.player("other_id");
    game.config().structureMinDist = () => 1;
    game.config().proximityBonusPortsNb = () => 0;
    game.config().tradeShipShortRangeDebuff = () => 0;
  });

  test("rivals cannot trade", () => {
    expect(player.canTrade(other)).toBe(false);
    expect(other.canTrade(player)).toBe(false);
  });

  test("own ports trade with each other, never with the rival", () => {
    player.conquer(game.ref(7, 10));
    player.conquer(game.ref(7, 0));
    const port = player.buildUnit(UnitType.Port, game.ref(7, 10), {});
    const ownPort = player.buildUnit(UnitType.Port, game.ref(7, 0), {});
    other.conquer(game.ref(0, 0));
    other.buildUnit(UnitType.Port, game.ref(0, 0), {});

    const execution = new PortExecution(port);
    execution.init(game, 0);
    const ports = execution.tradingPorts();

    expect(ports).toContain(ownPort);
    expect(ports).not.toContain(port);
    expect(ports.every((p) => p.owner() === player)).toBe(true);
  });

  test("every train stop pays 35k", () => {
    expect(game.config().trainGold("self", 0, player)).toBe(35_000n);
    expect(game.config().trainGold("self", 30, player)).toBe(35_000n);
  });

  test("no trade with an ally or a teammate either", () => {
    player.isFriendly = () => true;
    other.isFriendly = () => true;
    expect(player.canTrade(other)).toBe(false);
    expect(other.canTrade(player)).toBe(false);
  });
});
