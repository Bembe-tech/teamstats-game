/**
 * TeamStats.Pro "Airports and Planes" multiplayer lockstep check.
 *
 * Builds CLIENTS independent copies of one game with the mode on (like the
 * browsers of the players in a lobby: own map, own Executor, own clientID)
 * and feeds every copy the same turns, the way the server relays them. HUMANS
 * scripted players act from copy 0's view: spawn, land attacks, airports on
 * random own land, fighters (warship orders) and their move orders, and troop
 * planes (boat orders) at the other humans' land. Nations play as usual, so
 * their airports, cargo planes and troop planes are in it too.
 *
 * Every 10 ticks each copy is fingerprinted (land, troops, gold, units, every
 * plane's tile, owner and health) and every 100 ticks the ownership map is
 * hashed; any difference is a desync, reported with its first tick.
 *
 *   npx tsx tests/perf/fullgame/AirportsMultiSim.ts --map world \
 *        --ticks 6000 --humans 2 --clients 2 --seed air-1
 */
import path from "path";
import { fileURLToPath } from "url";
import { Config } from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameUpdateType, HashUpdate } from "../../../src/core/game/GameUpdates";
import { createNationsForGame } from "../../../src/core/game/NationCreation";
import { GameRunner } from "../../../src/core/GameRunner";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import {
  GameConfig,
  GameStartInfo,
  StampedIntent,
} from "../../../src/core/Schemas";
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
const TICKS = parseInt(arg("ticks", "6000"), 10);
const HUMANS = parseInt(arg("humans", "2"), 10);
const CLIENTS = parseInt(arg("clients", "2"), 10);
const SEED = arg("seed", "air-1");
// --off: same script with the mode off (baseline)
const OFF = process.argv.includes("--off");
// --as N --log FILE: run only copy N in this process (as client N) and write
// one fingerprint line per tick to FILE. Two processes compared with diff are
// fully independent (static class fields, e.g. NationMIRVBehavior's recent
// targets, are shared by copies inside one process, never across browsers).
const AS = process.argv.includes("--as") ? parseInt(arg("as", "0"), 10) : -1;
const LOG = arg("log", "");

interface Copy {
  game: Game;
  runner: GameRunner;
  hashes: Map<number, number>;
}

async function main() {
  console.debug = () => {};
  console.warn = () => {};
  const key = Object.keys(GameMapType).find(
    (k) => k.toLowerCase() === MAP.toLowerCase(),
  )!;
  const humans = Array.from(
    { length: HUMANS },
    (_, i) =>
      new PlayerInfo(`human${i}`, PlayerType.Human, `CL${i}abcd`, `hum${i}`),
  );
  const gameConfig: GameConfig = {
    gameMap: GameMapType[key as keyof typeof GameMapType],
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Private,
    difficulty: Difficulty.Medium,
    nations: "default",
    donateGold: false,
    donateTroops: false,
    bots: 100,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
    startingGold: 3_000_000,
    airports: !OFF,
  };
  const gameStart: GameStartInfo = {
    gameID: SEED,
    lobbyCreatedAt: 0,
    config: gameConfig,
    players: humans.map((h) => ({
      clientID: h.clientID!,
      username: h.name,
    })) as never,
  };

  const copies: Copy[] = [];
  for (let c = AS >= 0 ? AS : 0; c < (AS >= 0 ? AS + 1 : CLIENTS); c++) {
    const config = new Config(gameConfig, null, false);
    const { loadTerrainMap } = (await import(
      `../../../src/core/game/TerrainMapLoader.ts?copy=${c}`
    )) as typeof import("../../../src/core/game/TerrainMapLoader");
    const terrain = await loadTerrainMap(
      gameConfig.gameMap,
      gameConfig.gameMapSize,
      new NodeGameMapLoader(path.join(ROOT, "resources/maps")),
    );
    const nations = createNationsForGame(
      gameStart,
      terrain.nations,
      terrain.additionalNations,
      humans.length,
      new PseudoRandom(simpleHash(gameStart.gameID)),
    );
    const game = createGame(
      humans,
      nations,
      terrain.gameMap,
      terrain.miniGameMap,
      config,
      terrain.teamGameSpawnAreas,
    );
    const hashes = new Map<number, number>();
    const runner = new GameRunner(
      game,
      new Executor(game, gameStart.gameID, humans[c % HUMANS].clientID!),
      (gu) => {
        if ("errMsg" in gu) throw new Error(`copy ${c}: ${gu.errMsg}`);
        for (const h of gu.updates[GameUpdateType.Hash] as HashUpdate[]) {
          hashes.set(h.tick, h.hash);
        }
      },
    );
    runner.init();
    copies.push({ game, runner, hashes });
  }
  if (AS < 0 && copies[0].game.map() === copies[1]?.game.map()) {
    throw new Error("copies share one map: not independent");
  }

  const ref = copies[0].game;
  const rnd = new PseudoRandom(simpleHash(SEED) + 7);
  const stats = {
    attacks: 0,
    airportsOrdered: 0,
    fightersOrdered: 0,
    fighterMoves: 0,
    troopPlanesOrdered: 0,
    checks: 0,
    maxPlanesInAir: 0,
    planesShotDown: 0,
  };
  let turn = 0;
  let desync: string | null = null;

  const randomOwnTile = (p: ReturnType<Game["player"]>): number | null => {
    const tiles = Array.from(p.tiles());
    return tiles.length === 0 ? null : tiles[rnd.nextInt(0, tiles.length)];
  };

  const decide = (): StampedIntent[] => {
    const out: StampedIntent[] = [];
    const tick = ref.ticks();
    for (let i = 0; i < HUMANS; i++) {
      const info = humans[i];
      const p = ref.playerByClientID(info.clientID!);
      const clientID = info.clientID!;
      if (ref.inSpawnPhase()) {
        if (
          tick === 5 + i * 3 ||
          (p !== null && !p.hasSpawned() && tick % 40 === 0)
        ) {
          for (let tries = 0; tries < 200; tries++) {
            const t = rnd.nextInt(0, ref.width() * ref.height());
            if (ref.isLand(t) && !ref.hasOwner(t)) {
              out.push({ type: "spawn", tile: t, clientID });
              break;
            }
          }
        }
        continue;
      }
      if (p === null || !p.isAlive()) continue;
      if ((tick + i * 7) % 30 === 0) {
        out.push({
          type: "attack",
          targetID: null,
          troops: p.troops() * 0.4,
          clientID,
        });
        stats.attacks++;
      }
      // Airports anywhere on own land
      if ((tick + i * 17) % 200 === 0) {
        const t = randomOwnTile(p);
        if (t !== null) {
          out.push({
            type: "build_unit",
            unit: UnitType.Port,
            tile: t,
            clientID,
          });
          stats.airportsOrdered++;
        }
      }
      // Fighters: patrol over own land; sometimes moved to another spot
      if ((tick + i * 23) % 260 === 0) {
        const t = randomOwnTile(p);
        if (t !== null) {
          out.push({
            type: "build_unit",
            unit: UnitType.Warship,
            tile: t,
            clientID,
          });
          stats.fightersOrdered++;
        }
      }
      if ((tick + i * 29) % 330 === 0) {
        const ids = p.units(UnitType.Warship).map((u) => u.id());
        const t = randomOwnTile(p);
        if (ids.length > 0 && t !== null) {
          out.push({ type: "move_warship", unitIds: ids, tile: t, clientID });
          stats.fighterMoves++;
        }
      }
      // Troop planes at another human (or anyone near)
      if ((tick + i * 31) % 120 === 0) {
        const others = humans
          .map((h) => ref.playerByClientID(h.clientID!))
          .filter((o) => o !== null && o !== p && o.isAlive());
        const o =
          others.length > 0 ? others[rnd.nextInt(0, others.length)]! : null;
        const t = o === null ? null : randomOwnTile(o);
        if (t !== null) {
          out.push({
            type: "boat",
            troops: p.troops() * 0.15,
            dst: t,
            clientID,
          });
          stats.troopPlanesOrdered++;
        }
      }
    }
    return out;
  };

  const fingerprint = (g: Game, full: boolean): string => {
    const parts: string[] = [];
    for (const p of g.allPlayers()) {
      parts.push(
        `${p.id()}:${p.numTilesOwned()}:${Math.round(p.troops())}:${p.gold()}:${p.units().length}:${p.isAlive()}`,
      );
    }
    let planes = 0;
    let h = 2166136261;
    for (const u of g.units()) {
      planes++;
      h = Math.imul(h ^ u.id(), 16777619);
      h = Math.imul(h ^ u.tile(), 16777619);
      h = Math.imul(h ^ u.owner().smallID(), 16777619);
      h = Math.imul(h ^ Math.round(u.health()), 16777619);
    }
    parts.push(`planes:${planes}:${h >>> 0}`);
    if (full) {
      let m = 2166136261;
      const n = g.width() * g.height();
      for (let t = 0; t < n; t++) {
        m = Math.imul(m ^ g.ownerID(t), 16777619);
      }
      parts.push(`map:${m >>> 0}`);
    }
    return parts.join("|");
  };

  const logLines: string[] = [];
  const kinds = new Map<string, number>();
  const seenPlanes = new Map<number, ReturnType<Game["units"]>[number]>();
  const t0 = performance.now();
  const total = TICKS + 400;
  for (let i = 0; i < total && desync === null; i++) {
    const intents = decide();
    const t = { turnNumber: turn++, intents };
    for (const c of copies) {
      c.runner.addTurn(t);
      c.runner.executeNextTick();
    }
    const tick = ref.ticks();
    const inAir = ref.units(
      UnitType.TransportShip,
      UnitType.TradeShip,
      UnitType.Warship,
    );
    stats.maxPlanesInAir = Math.max(stats.maxPlanesInAir, inAir.length);
    const now = new Set<number>();
    for (const u of inAir) {
      now.add(u.id());
      if (!seenPlanes.has(u.id())) {
        seenPlanes.set(u.id(), u);
        kinds.set(u.type(), (kinds.get(u.type()) ?? 0) + 1);
      }
    }
    for (const [id, u] of seenPlanes) {
      if (now.has(id)) continue;
      if (u.wasDestroyedByEnemy()) stats.planesShotDown++;
      seenPlanes.delete(id);
    }
    {
      const full = tick % 100 === 0;
      const f0 = fingerprint(ref, full);
      if (LOG !== "") logLines.push(`${tick} ${f0}`);
      for (let c = 1; c < copies.length; c++) {
        const f = fingerprint(copies[c].game, full);
        if (f !== f0) {
          const a = f0.split("|");
          const b = f.split("|");
          const k = a.findIndex((x, j) => x !== b[j]);
          desync = `tick ${tick}, copy ${c}: ${a[k]} vs ${b[k]}`;
          break;
        }
        const h0 = copies[0].hashes.get(tick);
        const h = copies[c].hashes.get(tick);
        if (h0 !== h) {
          desync = `tick ${tick}, copy ${c}: engine hash ${h0} vs ${h}`;
          break;
        }
      }
      stats.checks++;
    }
  }

  if (LOG !== "") {
    const fs = await import("fs");
    fs.writeFileSync(LOG, logLines.join("\n") + "\n");
  }
  console.log(
    JSON.stringify(
      {
        map: MAP,
        seed: SEED,
        clients: CLIENTS,
        humans: HUMANS,
        ticks: ref.ticks(),
        wallS: +((performance.now() - t0) / 1000).toFixed(1),
        desync: desync ?? "none",
        ...stats,
        airportsStanding: ref.units(UnitType.Port).length,
        planesFlownByType: Object.fromEntries(kinds),
        alive: ref.players().filter((p) => p.isAlive()).length,
      },
      null,
      1,
    ),
  );
  if (desync !== null) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
