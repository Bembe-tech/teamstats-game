// TeamStats.Pro "OpenFront 4D" balance duel (run on demand, skipped in CI):
//   TIME_WARP_DUEL=1 npx vitest run tests/perf/fullgame/TimeWarpDuel.test.ts
// Two equal players on a 200x200 plain. The attacker throws big waves at the
// defender; once the defender has lost land fast it answers
// with nothing / a Time Echo / a ghost army / the Time Loop (10% in 8 s). Reported: the
// defender's land 30 s and 90 s after the answer, and the attacker's troops.
// (The attacker starts with about twice the defender's troops.)
import path from "path";
import { fileURLToPath } from "url";
import { Config } from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { TimeEchoExecution } from "../../../src/core/execution/TimeEchoExecution";
import { TimeGhostExecution } from "../../../src/core/execution/TimeGhostExecution";
import { TimeLoopExecution } from "../../../src/core/execution/TimeLoopExecution";
import {
  Execution,
  Game,
  PlayerInfo,
  PlayerType,
} from "../../../src/core/game/Game";
import { setup } from "../../util/Setup";

type Answer = "none" | "echo" | "ghost" | "loop";

async function duel(answer: Answer, seed: number) {
  // The real rules (Config), not the test config
  const game: Game = await setup(
    "big_plains",
    { timeWarp: true },
    [
      new PlayerInfo("att", PlayerType.Human, null, "att"),
      new PlayerInfo("def", PlayerType.Human, null, "def"),
    ],
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../util"),
    Config,
  );
  const att = game.player("att");
  const def = game.player("def");
  for (let x = 0; x < 200; x++)
    for (let y = 0; y < 200; y++) (x < 100 ? att : def).conquer(game.ref(x, y));
  game.elapsedGameSeconds = () => 600;
  // The attacker is much stronger: the defender is about to be overrun
  for (const p of [att, def]) p.addGold(2_000_000n);
  att.addTroops(550_000 + seed * 50_000);
  def.addTroops(300_000);
  const step = (n: number) => {
    for (let i = 0; i < n; i++) game.executeNextTick();
  };
  step(210); // history older than every window
  const land: number[] = [];
  let answeredAt = -1;
  const out: Record<string, number> = {};
  for (let s = 0; s < 240; s++) {
    // a wave every 6 s, a share of the attacker's troops that varies by seed
    if (s % 6 === 0) {
      game.addExecution(
        new AttackExecution(
          att.troops() * (0.45 + ((seed * 7 + s) % 5) * 0.05),
          att,
          def.id(),
        ),
      );
    }
    // the defender pushes back a little too
    if (s % 9 === 4) {
      game.addExecution(
        new AttackExecution(def.troops() * 0.25, def, att.id()),
      );
    }
    step(10);
    land.push(def.numTilesOwned());
    const n = land.length;
    if (answeredAt < 0 && n > 8 && land[n - 1] <= land[n - 9] * 0.9) {
      answeredAt = s;
      const e: Execution | null =
        answer === "echo"
          ? new TimeEchoExecution(def)
          : answer === "ghost"
            ? new TimeGhostExecution(def)
            : answer === "loop"
              ? new TimeLoopExecution(def)
              : null;
      out.before = land[n - 9];
      out.atAnswer = land[n - 1];
      if (e) e.init(game, game.ticks());
    }
    if (answeredAt >= 0 && s === answeredAt + 30)
      out.after30 = def.numTilesOwned();
    if (answeredAt >= 0 && s === answeredAt + 90) {
      out.after90 = def.numTilesOwned();
      out.attTroops = Math.round(att.troops());
      out.defTroops = Math.round(def.troops());
      break;
    }
  }
  out.firstLand = land[0];
  out.lastLand = land[land.length - 1];
  out.answered = answeredAt;
  return out;
}

const run = process.env.TIME_WARP_DUEL === "1" ? test : test.skip;

run(
  "4D duel balance",
  async () => {
    const rows: string[] = [];
    for (const answer of ["none", "echo", "ghost", "loop"] as Answer[]) {
      const r: Record<string, number>[] = [];
      for (let seed = 0; seed < 5; seed++) r.push(await duel(answer, seed));
      const avg = (k: string) =>
        Math.round(r.reduce((s, x) => s + (x[k] ?? 0), 0) / r.length);
      rows.push(
        `${answer.padEnd(6)} first ${avg("firstLand")} last ${avg("lastLand")} answeredAt ${avg("answered")} before ${avg("before")}  at answer ${avg("atAnswer")}  +30s ${avg("after30")}  +90s ${avg("after90")}  attacker troops ${avg("attTroops")}  defender troops ${avg("defTroops")}`,
      );
    }
    // vitest hides console output here: write the table to a file
    (await import("fs")).writeFileSync(
      process.env.TIME_WARP_DUEL_OUT ?? "time-warp-duel.txt",
      rows.join("\n") + "\n",
    );
  },
  600_000,
);
