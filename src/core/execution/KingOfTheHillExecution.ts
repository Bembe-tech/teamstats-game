// TeamStats.Pro "King of the Hill" (lobby option kingOfTheHill).
// The crown belongs to the player with the most land (tribes excluded), as on
// the crown icon. Every second the crown holder gets a second of crown time.
// When the lobby's time is up (kingOfTheHillMinutes, default 30) the player (or, in team games, the team) with the most
// crown time wins. WinCheckExecution's land win is off in this mode.
import { Execution, Game, GameMode, Player, PlayerType, Team } from "../game/Game";

export class KingOfTheHillExecution implements Execution {
  private active = true;
  private mg: Game | null = null;

  init(mg: Game, ticks: number) {
    this.mg = mg;
  }

  tick(ticks: number) {
    if (ticks % 10 !== 0) return;
    const mg = this.mg;
    if (mg === null) throw new Error("Not initialized");

    const holder = crownHolder(mg);
    if (holder !== null) holder.addCrownTicks(10);

    if (mg.elapsedGameSeconds() < mg.config().kingOfTheHillMinutes() * 60) {
      return;
    }

    if (mg.config().gameConfig().gameMode === GameMode.FFA) {
      let best: Player | null = null;
      for (const p of mg.allPlayers()) {
        if (p.crownTicks() === 0) continue;
        if (best === null || p.crownTicks() > best.crownTicks()) best = p;
      }
      mg.setWinner(best ?? holder, mg.stats().stats());
    } else {
      const byTeam = new Map<Team, number>();
      for (const p of mg.allPlayers()) {
        const team = p.team();
        if (team === null || p.crownTicks() === 0) continue;
        byTeam.set(team, (byTeam.get(team) ?? 0) + p.crownTicks());
      }
      let best: Team | null = null;
      let bestTicks = -1;
      for (const [team, t] of byTeam) {
        if (t > bestTicks) {
          best = team;
          bestTicks = t;
        }
      }
      mg.setWinner(best ?? holder?.team() ?? null, mg.stats().stats());
    }
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}

/** Alive player (not a tribe) with the most land; ties go to the lower smallID. */
export function crownHolder(mg: Game): Player | null {
  let best: Player | null = null;
  for (const p of mg.players()) {
    if (p.type() === PlayerType.Bot || !p.isAlive()) continue;
    if (
      best === null ||
      p.numTilesOwned() > best.numTilesOwned() ||
      (p.numTilesOwned() === best.numTilesOwned() &&
        p.smallID() < best.smallID())
    ) {
      best = p;
    }
  }
  return best;
}
