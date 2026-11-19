/**
 * TeamStats.Pro "OpenFront 4D" balance + cost run: a whole game of nations
 * (and optional bots) on a real map, headless, with the 4D mode on or off.
 *
 *   npx tsx tests/perf/fullgame/TimeWarpSim.ts --map world --ticks 9000 \
 *        [--off] [--seed s1] [--bots 0] [--hard]
 *
 * Reports the engine cost (ms per tick), every Time Echo the nations used
 * (tiles back, gold paid), and the "crisis" moments: a nation that lost 20%
 * of its land within 8 s (the moment a player would echo). For each crisis:
 * is the nation still alive 60 s and 180 s later, and how much land does it
 * hold then compared to before the crisis. Running the same seed with --off
 * gives the comparison without echoes.
 */
import path from "path";
import { fileURLToPath } from "url";
import { Config } from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { TimeEchoExecution } from "../../../src/core/execution/TimeEchoExecution";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameUpdateType, HashUpdate } from "../../../src/core/game/GameUpdates";
import { createNationsForGame } from "../../../src/core/game/NationCreation";
import { loadTerrainMap } from "../../../src/core/game/TerrainMapLoader";
import { ChronoLog, echoCost } from "../../../src/core/game/TimeWarp";
import { GameRunner } from "../../../src/core/GameRunner";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import { GameConfig, GameStartInfo } from "../../../src/core/Schemas";
import { simpleHash } from "../../../src/core/Util";
import { NodeGameMapLoader } from "./NodeGameMapLoader";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const MAP = arg("map", "world");
const TICKS = parseInt(arg("ticks", "9000"), 10);
const SEED = arg("seed", "tw-1");
const BOTS = parseInt(arg("bots", "0"), 10);
const OFF = process.argv.includes("--off");
const HARD = process.argv.includes("--hard");

interface Echo {
  tick: number;
  name: string;
  restored: number;
  landBefore: number;
  gold: bigint;
  cost: bigint;
}
const echoes: Echo[] = [];
const origInit = TimeEchoExecution.prototype.init;
TimeEchoExecution.prototype.init = function (mg, ticks) {
  const p = (this as unknown as { player: Player }).player;
  const land = p.numTilesOwned();
  const gold = p.gold();
  const usesBefore = p.echoUses();
  origInit.call(this, mg, ticks);
  if (p.echoUses() > usesBefore) {
    echoes.push({
      tick: ticks,
      name: p.name(),
      restored: this.restored,
      landBefore: land,
      gold,
      cost: echoCost(gold),
    });
  }
};

// Conquests between players per tick, to size ChronoLog.CAPACITY
const perTick = new Map<number, number>();
const origRecord = ChronoLog.prototype.record;
ChronoLog.prototype.record = function (tick, tile, from, to) {
  perTick.set(tick, (perTick.get(tick) ?? 0) + 1);
  origRecord.call(this, tick, tile, from, to);
};
function maxPerWindow(window: number): number {
  const ticks = [...perTick.keys()].sort((a, b) => a - b);
  let best = 0;
  let sum = 0;
  let lo = 0;
  for (let hi = 0; hi < ticks.length; hi++) {
    sum += perTick.get(ticks[hi])!;
    while (ticks[hi] - ticks[lo] >= window) sum -= perTick.get(ticks[lo++])!;
    best = Math.max(best, sum);
  }
  return best;
}

async function main() {
  console.debug = () => {};
  const key = Object.keys(GameMapType).find(
    (k) => k.toLowerCase() === MAP.toLowerCase(),
  )!;
  const gameConfig: GameConfig = {
    gameMap: GameMapType[key as keyof typeof GameMapType],
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Public,
    difficulty: HARD ? Difficulty.Hard : Difficulty.Medium,
    nations: "default",
    donateGold: false,
    donateTroops: false,
    bots: BOTS,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
    timeWarp: OFF ? undefined : true,
  };
  const gameStart: GameStartInfo = {
    gameID: SEED,
    lobbyCreatedAt: 0,
    config: gameConfig,
    players: [],
  };
  const config = new Config(gameConfig, null, false);
  const terrain = await loadTerrainMap(
    gameConfig.gameMap,
    gameConfig.gameMapSize,
    new NodeGameMapLoader(path.join(ROOT, "resources/maps")),
  );
  const nations = createNationsForGame(
    gameStart,
    terrain.nations,
    terrain.additionalNations,
    0,
    new PseudoRandom(simpleHash(gameStart.gameID)),
  );
  const game = createGame(
    [],
    nations,
    terrain.gameMap,
    terrain.miniGameMap,
    config,
    terrain.teamGameSpawnAreas,
  );
  let lastHash: HashUpdate | undefined;
  const runner = new GameRunner(
    game,
    new Executor(game, gameStart.gameID, undefined),
    (gu) => {
      if ("errMsg" in gu) throw new Error(gu.errMsg);
      const h = gu.updates[GameUpdateType.Hash] as HashUpdate[];
      if (h.length > 0) lastHash = h[h.length - 1];
    },
  );
  runner.init();
  let turn = 0;
  const step = () => {
    runner.addTurn({ turnNumber: turn++, intents: [] });
    runner.executeNextTick();
  };
  while (game.inSpawnPhase()) step();

  // Land of every nation once a second, to find crises
  const land = new Map<string, number[]>();
  interface Crisis {
    tick: number;
    name: string;
    before: number;
    at: number;
    after60?: number;
    after180?: number;
  }
  const crises: Crisis[] = [];
  const lastCrisis = new Map<string, number>();
  const tickMs: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < TICKS; i++) {
    const s = performance.now();
    step();
    tickMs.push(performance.now() - s);
    const tick = game.ticks();
    if (tick % 10 !== 0) continue;
    for (const p of game.allPlayers()) {
      const arr = land.get(p.id()) ?? [];
      arr.push(p.isAlive() ? p.numTilesOwned() : 0);
      land.set(p.id(), arr);
      const n = arr.length;
      if (n > 9 && p.isAlive()) {
        const before = arr[n - 9];
        const now = arr[n - 1];
        // same trigger as the nation AI (20% in 8 s, at least 400 tiles),
        // one crisis per nation per 3 min
        if (
          before >= 400 &&
          now <= before * 0.8 &&
          tick - (lastCrisis.get(p.id()) ?? -1e9) > 1800 &&
          game.elapsedGameSeconds() >= 120
        ) {
          lastCrisis.set(p.id(), tick);
          crises.push({ tick, name: p.id(), before, at: now });
        }
      }
    }
    for (const c of crises) {
      const arr = land.get(c.name)!;
      const idx = arr.length - 1;
      const cIdx = idx - (tick - c.tick) / 10;
      if (tick - c.tick === 600) c.after60 = arr[idx];
      if (tick - c.tick === 1800) c.after180 = arr[idx];
      void cIdx;
    }
  }
  const wall = performance.now() - t0;
  tickMs.sort((a, b) => a - b);
  const mean = tickMs.reduce((a, b) => a + b, 0) / tickMs.length;
  const p95 = tickMs[Math.floor(tickMs.length * 0.95)];
  const alive = game.players().filter((p) => p.isAlive());
  const top = [...alive]
    .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())
    .slice(0, 5)
    .map((p) => `${p.name()} ${p.numTilesOwned()}`);

  const rec = crises.filter((c) => c.after180 !== undefined);
  const alive60 = crises.filter((c) => c.after60 !== undefined);
  const surv = (arr: Crisis[], k: "after60" | "after180") =>
    arr.length === 0
      ? "n/a"
      : `${Math.round((100 * arr.filter((c) => (c[k] ?? 0) > 0).length) / arr.length)}%`;
  const keep = (arr: Crisis[], k: "after60" | "after180") => {
    const r = arr.map((c) => (c[k] ?? 0) / c.before).sort((a, b) => a - b);
    return r.length === 0
      ? "n/a"
      : `${Math.round(100 * r[Math.floor(r.length / 2)])}%`;
  };

  const out = {
    mode: OFF ? "OFF" : "4D",
    map: MAP,
    seed: SEED,
    ticks: TICKS,
    msPerTickMean: +mean.toFixed(3),
    msPerTickP95: +p95.toFixed(3),
    wallS: +(wall / 1000).toFixed(1),
    chronoEntries: game.chronoLog()?.entries() ?? 0,
    chronoMaxPer10s: maxPerWindow(100),
    heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    alive: alive.length,
    players: game.allPlayers().length,
    top,
    echoes: echoes.length,
    echoRestoredMedian:
      echoes.length === 0
        ? 0
        : echoes.map((e) => e.restored).sort((a, b) => a - b)[
            Math.floor(echoes.length / 2)
          ],
    echoRestoredMax: Math.max(0, ...echoes.map((e) => e.restored)),
    echoRestoreShareMedian:
      echoes.length === 0
        ? 0
        : +echoes
            .map((e) => e.restored / Math.max(1, e.landBefore))
            .sort((a, b) => a - b)
            [Math.floor(echoes.length / 2)].toFixed(2),
    echoCostMedian:
      echoes.length === 0
        ? 0
        : Number(
            echoes.map((e) => e.cost).sort((a, b) => (a < b ? -1 : 1))[
              Math.floor(echoes.length / 2)
            ],
          ),
    echoMinutes: echoes.map((e) => Math.round(e.tick / 60) / 10),
    crises: crises.length,
    crisisAlive60: surv(alive60, "after60"),
    crisisAlive180: surv(rec, "after180"),
    crisisLand180vsBefore: keep(rec, "after180"),
    hash: lastHash?.hash,
  };
  console.log(JSON.stringify(out, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
