/**
 * TeamStats.Pro "OpenFront 4D" multiplayer lockstep check.
 *
 * Builds CLIENTS independent copies of the same game (like the browsers of
 * the players in one lobby: own map, own Executor, own clientID) and feeds
 * every copy the same turns, the way the server relays them. HUMANS scripted
 * human players act from copy 0's view: spawn, land attacks on each other
 * and on nations, boats, and Time Echoes (when losing land fast, at random
 * moments, and sometimes when not allowed, to hit every rejection path).
 *
 * Every 10 ticks each copy's state is fingerprinted (every player's land,
 * troops, gold, Time Echo uses / cooldown / freeze, unit count) and every 100
 * ticks the whole ownership map is hashed; any difference between copies is
 * a desync and is reported with the first tick it shows up.
 *
 *   npx tsx tests/perf/fullgame/TimeWarpMultiSim.ts --map world \
 *        --ticks 6000 --humans 6 --clients 4 --seed mp-1 [--teams]
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
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameUpdateType, HashUpdate } from "../../../src/core/game/GameUpdates";
import { createNationsForGame } from "../../../src/core/game/NationCreation";
import { echoBlock } from "../../../src/core/game/TimeWarp";
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
const HUMANS = parseInt(arg("humans", "6"), 10);
const CLIENTS = parseInt(arg("clients", "4"), 10);
const SEED = arg("seed", "mp-1");
const TEAMS = process.argv.includes("--teams");

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
    gameMode: TEAMS ? GameMode.Team : GameMode.FFA,
    playerTeams: TEAMS ? 2 : undefined,
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
    timeWarp: true,
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
  for (let c = 0; c < CLIENTS; c++) {
    const config = new Config(gameConfig, null, false);
    // A fresh module instance per copy: the loader caches maps, and every
    // copy needs its own map (each browser has its own)
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
  if (copies[0].game.map() === copies[1]?.game.map()) {
    throw new Error("copies share one map: not independent");
  }

  const ref = copies[0].game;
  const rnd = new PseudoRandom(simpleHash(SEED) + 7);
  const land = new Map<string, number[]>(); // per human, once a second
  const stats = {
    attacks: 0,
    boats: 0,
    echoSent: 0,
    echoApplied: 0,
    echoRejected: 0,
    delayed: 0,
    ghosts: 0,
    loops: 0,
    checks: 0,
  };
  // Echo against an echo: answer a fresh echo on you the next second
  const echoedAt = new Map<number, number>();
  let turn = 0;
  let desync: string | null = null;

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
      // land history for the echo decision
      if (tick % 10 === 0) {
        const arr = land.get(clientID) ?? [];
        arr.push(p.numTilesOwned());
        if (arr.length > 9) arr.shift();
        land.set(clientID, arr);
      }
      const phase = (tick + i * 7) % 30;
      if (phase === 0) {
        // Attack: another human 50%, any neighbour otherwise, else expand
        // Players next to p's border (sample of border tiles)
        const ids = new Set<number>();
        let k = 0;
        for (const bt of p.borderTiles()) {
          if (k++ > 300) break;
          for (const n of ref.neighbors(bt)) {
            const o = ref.ownerID(n);
            if (o !== 0 && o !== p.smallID()) ids.add(o);
          }
        }
        const neighbours = [...ids]
          .map((id) => ref.playerBySmallID(id))
          .filter((n) => n.isPlayer() && !p.isFriendly(n as never));
        const humansNear = neighbours.filter(
          (n) =>
            n.isPlayer() &&
            (n as never as { type(): PlayerType }).type() === PlayerType.Human,
        );
        // First minute: grab empty land; then fight (humans first)
        const early = ref.elapsedGameSeconds() < 60;
        const pool = early
          ? []
          : humansNear.length > 0 && rnd.chance(2)
            ? humansNear
            : neighbours;
        const target =
          pool.length > 0 ? pool[rnd.nextInt(0, pool.length)] : null;

        const attack = {
          type: "attack" as const,
          targetID: target !== null && target.isPlayer() ? target.id() : null,
          troops: p.troops() * (target === null ? 0.5 : 0.35),
        };
        // Every 4th attack is a delayed order (5-30 s)
        if (!early && rnd.chance(4)) {
          out.push({
            type: "delayed_order",
            delay: 50 + rnd.nextInt(0, 26) * 10,
            order: attack,
            clientID,
          });
          stats.delayed++;
        } else {
          out.push({ ...attack, clientID });
        }
        stats.attacks++;
      }
      if ((tick + i * 31) % 250 === 0) {
        // Boat at another human's land
        const others = humans
          .map((h) => ref.playerByClientID(h.clientID!))
          .filter((o) => o !== null && o !== p && o.isAlive());
        if (others.length > 0) {
          const o = others[rnd.nextInt(0, others.length)]!;
          const tiles = Array.from(o.borderTiles());
          if (tiles.length > 0) {
            const boat = {
              type: "boat" as const,
              troops: p.troops() * 0.15,
              dst: tiles[rnd.nextInt(0, tiles.length)],
            };
            if (rnd.chance(3)) {
              out.push({
                type: "delayed_order",
                delay: 100,
                order: boat,
                clientID,
              });
              stats.delayed++;
            } else {
              out.push({ ...boat, clientID });
            }
            stats.boats++;
          }
        }
      }
      // Time Echo: when losing land fast (like a real player), now and then
      // at random, and sometimes while not allowed
      const arr = land.get(clientID) ?? [];
      const losing =
        arr.length >= 9 && arr[0] >= 200 && p.numTilesOwned() <= arr[0] * 0.85;
      const block = echoBlock(
        true,
        p.isAlive(),
        ref.inSpawnPhase(),
        Math.floor(ref.elapsedGameSeconds() * 10),
        tick,
        { used: p.echoUses(), readyTick: p.echoReadyTick() },
        p.gold(),
      );
      // Someone echoed land back from me a moment ago: echo right back
      // (a paradox when both claim the same land)
      for (const o of ref.allPlayers()) {
        if (o === p || o.echoUses() === 0) continue;
        const was = echoedAt.get(o.smallID()) ?? 0;
        if (o.echoReadyTick() !== was) {
          echoedAt.set(o.smallID(), o.echoReadyTick());
        }
      }
      const answer =
        block === "ok" &&
        tick % 10 === 7 &&
        ref
          .allPlayers()
          .some(
            (o) =>
              o !== p &&
              o.echoUses() > 0 &&
              tick - (o.echoReadyTick() - 1800) < 30 &&
              tick - (o.echoReadyTick() - 1800) > 0,
          );
      if (losing && tick % 50 === 9) {
        out.push({ type: "time_ghost", clientID });
        stats.ghosts++;
      }
      if (losing && p.loopUses() === 0 && tick % 100 === 21) {
        out.push({ type: "time_loop", clientID });
        stats.loops++;
      }
      if (
        (losing && block === "ok" && tick % 10 === 3) ||
        answer ||
        (tick + i * 13) % 600 === 0
      ) {
        out.push({ type: "time_echo", clientID });
        stats.echoSent++;
        if (block === "ok") stats.echoApplied++;
        else stats.echoRejected++;
      }
    }
    return out;
  };

  const fingerprint = (g: Game, full: boolean): string => {
    const parts: string[] = [];
    for (const p of g.allPlayers()) {
      parts.push(
        `${p.id()}:${p.numTilesOwned()}:${Math.round(p.troops())}:${p.gold()}:` +
          `${p.echoUses()}:${p.echoReadyTick()}:${p.timeShieldUntil()}:${p.units().length}:${p.isAlive()}:` +
          `${p.ghostUses()}:${p.ghostReadyTick()}:${p.loopUses()}:${p.lastParadox()?.tick ?? -1}:${p.lastParadox()?.won ?? ""}:` +
          p
            .delayedOrders()
            .map((o) => `${o.id}@${o.fireTick}`)
            .join(","),
      );
    }
    if (full) {
      let h = 2166136261;
      const n = g.width() * g.height();
      for (let t = 0; t < n; t++) {
        h = Math.imul(h ^ g.ownerID(t), 16777619);
      }
      parts.push(`map:${h >>> 0}`);
    }
    return parts.join("|");
  };

  const t0 = performance.now();
  const total = TICKS + 400; // spawn phase included
  for (let i = 0; i < total && desync === null; i++) {
    const intents = decide();
    const t = { turnNumber: turn++, intents };
    for (const c of copies) {
      c.runner.addTurn(t);
      c.runner.executeNextTick();
    }
    const tick = ref.ticks();
    if (tick % 10 === 0) {
      const full = tick % 100 === 0;
      const f0 = fingerprint(ref, full);
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

  const alive = ref.players().filter((p) => p.isAlive());
  const humanState = humans.map((h) => {
    const p = ref.playerByClientID(h.clientID!);
    return p === null
      ? `${h.name}: -`
      : `${h.name}: ${p.isAlive() ? p.numTilesOwned() + " tiles" : "dead"}, echoes ${p.echoUses()}`;
  });
  console.log(
    JSON.stringify(
      {
        map: MAP,
        seed: SEED,
        teams: TEAMS,
        clients: CLIENTS,
        humans: HUMANS,
        ticks: ref.ticks(),
        wallS: +((performance.now() - t0) / 1000).toFixed(1),
        desync: desync ?? "none",
        checks: stats.checks,
        attacks: stats.attacks,
        boats: stats.boats,
        echoSent: stats.echoSent,
        echoAllowed: stats.echoApplied,
        echoRejected: stats.echoRejected,
        delayedSent: stats.delayed,
        ghostsSent: stats.ghosts,
        loopsSent: stats.loops,
        ghostsUsed: ref.allPlayers().reduce((s, p) => s + p.ghostUses(), 0),
        loopsUsed: ref.allPlayers().reduce((s, p) => s + p.loopUses(), 0),
        paradoxes: ref.allPlayers().filter((p) => p.lastParadox() !== null)
          .length,
        echoesUsedByAll: ref.allPlayers().reduce((s, p) => s + p.echoUses(), 0),
        alive: alive.length,
        humanState,
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
