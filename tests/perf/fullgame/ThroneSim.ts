/**
 * TeamStats.Pro "King of the Hill 2" balance + lockstep sim (built like
 * AirportsMultiSim). Nations play for the throne on their own; HUMANS scripted
 * players expand, reach the throne zone and keep a garrison there. Prints who
 * reigned how long, takeovers, the longest unbroken reign and the winner.
 * With --clients 2 (or --as N --log FILE in two processes) every copy is
 * fingerprinted every second (land, troops, gold, garrison, reign, status).
 *
 *   npx tsx tests/perf/fullgame/ThroneSim.ts --map surrounded --ticks 30000 \
 *        --humans 0 --clients 1 --seed throne-1 [--teams 4] [--minutes 5]
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
  Player,
  PlayerInfo,
  PlayerType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import {
  GameUpdateType,
  HashUpdate,
  WinUpdate,
} from "../../../src/core/game/GameUpdates";
import { createNationsForGame } from "../../../src/core/game/NationCreation";
import { thronePlace } from "../../../src/core/game/Throne";
import { ownsThroneZoneTile } from "../../../src/core/game/ThroneZone";
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
const MAP = arg("map", "surrounded");
const TICKS = parseInt(arg("ticks", "30000"), 10);
const HUMANS = parseInt(arg("humans", "0"), 10);
const CLIENTS = parseInt(arg("clients", "1"), 10);
const SEED = arg("seed", "throne-1");
const TEAMS = parseInt(arg("teams", "0"), 10);
const MINUTES = parseInt(arg("minutes", "5"), 10);
const SHARE = parseInt(arg("share", "30"), 10);
const BOTS = parseInt(arg("bots", "40"), 10);
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
  const origLog = console.log;
  console.log = () => {};
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
    gameMode: TEAMS > 0 ? GameMode.Team : GameMode.FFA,
    ...(TEAMS > 0 ? { playerTeams: TEAMS } : {}),
    gameType: GameType.Private,
    difficulty: Difficulty.Medium,
    nations: "default",
    donateGold: false,
    donateTroops: false,
    bots: BOTS,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
    kingOfTheHill2: true,
    kingOfTheHill2Minutes: MINUTES,
    kingOfTheHill2ArmyShare: SHARE,
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
  const winners = new Map<number, string>();
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
      new Executor(game, gameStart.gameID, humans[0]?.clientID ?? "NONE0000"),
      (gu) => {
        if ("errMsg" in gu) throw new Error(`copy ${c}: ${gu.errMsg}`);
        for (const w of gu.updates[GameUpdateType.Win] as WinUpdate[]) {
          winners.set(c, JSON.stringify(w.winner));
        }
        for (const h of gu.updates[GameUpdateType.Hash] as HashUpdate[]) {
          hashes.set(h.tick, h.hash);
        }
      },
    );
    runner.init();
    copies.push({ game, runner, hashes });
  }

  const ref = copies[0].game;
  const rnd = new PseudoRandom(simpleHash(SEED) + 7);
  let turn = 0;
  let desync: string | null = null;
  const place = thronePlace(ref.map());
  const shore = (place?.tiles ?? []).filter((t) => ref.isShoreline(t));
  let throneOrders = 0;

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
          troops: p.troops() * 0.3,
          clientID,
        });
      }
      if ((tick + i * 11) % 50 === 0) {
        if (ownsThroneZoneTile(ref, p)) {
          const g = p.throneGarrison();
          const army = p.troops() + g;
          if (g * 100 < (SHARE + 6) * army) {
            out.push({ type: "throne", action: "send", percent: 15, clientID });
            throneOrders++;
          }
        } else if (shore.length > 0 && (tick + i * 13) % 150 === 0) {
          out.push({
            type: "boat",
            troops: p.troops() * 0.25,
            dst: shore[rnd.nextInt(0, shore.length)],
            clientID,
          });
        }
      }
    }
    return out;
  };

  const fingerprint = (g: Game): string => {
    const parts: string[] = [];
    for (const p of g.allPlayers()) {
      const t = p.throne();
      parts.push(
        `${p.id()}:${p.numTilesOwned()}:${Math.round(p.troops())}:${p.gold()}:${t?.garrison ?? 0}:${t?.reign ?? 0}:${t?.status ?? 0}`,
      );
    }
    return parts.join("|");
  };

  const sideOf = (p: Player): string =>
    TEAMS > 0 && p.team() !== null ? `team ${p.team()}` : p.displayName();
  let holder: string | null = null;
  let holderSince = 0;
  let longest = { side: "", s: 0 };
  let takeovers = 0;
  const firstHold: Record<string, number> = {};
  const timeline: string[] = [];
  const holderStatus = { powered: 0, lowArmy: 0, noGold: 0, empty: 0 };
  const logLines: string[] = [];
  const t0 = performance.now();
  for (let i = 0; i < TICKS && desync === null && winners.size === 0; i++) {
    const intents = decide();
    const t = { turnNumber: turn++, intents };
    for (const c of copies) {
      c.runner.addTurn(t);
      c.runner.executeNextTick();
    }
    const tick = ref.ticks();
    if (tick % 10 !== 0 || ref.inSpawnPhase()) continue;
    let h: string | null = null;
    let st = 0;
    for (const p of ref.allPlayers()) {
      const tv = p.throne();
      if (tv !== null && tv.status !== 0 && p.isAlive()) {
        h = sideOf(p);
        st = tv.status;
        break;
      }
    }
    if (st === 1) holderStatus.powered++;
    else if (st === 2) holderStatus.lowArmy++;
    else if (st === 3) holderStatus.noGold++;
    else holderStatus.empty++;
    const sec = Math.floor(tick / 10);
    if (h !== holder) {
      if (holder !== null) {
        const held = sec - holderSince;
        if (held > longest.s) longest = { side: holder, s: held };
      }
      if (h !== null && holder !== null) takeovers++;
      if (h !== null && firstHold[h] === undefined) firstHold[h] = sec;
      timeline.push(`${sec}s ${h ?? "(empty)"}`);
      holder = h;
      holderSince = sec;
    }
    const f0 = copies.length > 1 || LOG !== "" ? fingerprint(ref) : "";
    for (let c = 1; c < copies.length; c++) {
      const f = fingerprint(copies[c].game);
      if (f !== f0) {
        const a = f0.split("|");
        const b = f.split("|");
        const k = a.findIndex((x, j) => x !== b[j]);
        desync = `tick ${tick}, copy ${c}: ${a[k]} vs ${b[k]}`;
      }
      const h0 = copies[0].hashes.get(tick);
      const hc = copies[c].hashes.get(tick);
      if (h0 !== undefined && h0 !== hc) {
        desync = `tick ${tick}, copy ${c}: engine hash ${h0} vs ${hc}`;
      }
    }
    if (LOG !== "") logLines.push(`${tick} ${f0}`);
  }
  if (LOG !== "") {
    const fs = await import("fs");
    fs.writeFileSync(LOG, logLines.join("\n") + "\n");
  }
  const reigns: Record<string, number> = {};
  for (const p of ref.allPlayers()) {
    const r = p.throne()?.reign ?? 0;
    if (r > 0) reigns[sideOf(p)] = Math.max(reigns[sideOf(p)] ?? 0, r);
  }
  const sec = Math.floor(ref.ticks() / 10);
  if (holder !== null && sec - holderSince > longest.s) {
    longest = { side: holder, s: sec - holderSince };
  }
  let winner = winners.values().next().value ?? null;
  if (winner !== null) {
    const w = JSON.parse(winner) as unknown[];
    if (w[0] === "player") {
      const p = ref
        .allPlayers()
        .find((x) => x.clientID() === w[1] || x.id() === w[1]);
      if (p !== undefined) winner = `player ${p.displayName()}`;
    }
  }
  origLog(
    JSON.stringify(
      {
        map: MAP,
        seed: SEED,
        teams: TEAMS,
        clients: copies.length,
        humans: HUMANS,
        gameSeconds: sec,
        wallS: +((performance.now() - t0) / 1000).toFixed(1),
        desync: desync ?? "none",
        winner,
        throne: place === null ? null : { ...place, tiles: place.tiles.length },
        takeovers,
        throneOrders,
        longestUnbrokenHold: longest,
        holderSecondsByStatus: holderStatus,
        reigns,
        firstHold,
        timeline: timeline.slice(0, 30),
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
