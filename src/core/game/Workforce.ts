// TeamStats.Pro "Troops and Workers" (lobby option troopsAndWorkers): the old
// OpenFront population split, brought back as a mode. OpenFront had it until
// August 2025 (upstream commit 3b8a3616 "Remove workers & troop ratio bar").
//
// - A player's population is troops + workers. It grows like troops do in the
//   normal game (same formula and cap, the cap is now the population cap).
// - The troop ratio slider (1-100%) says which share of the population should
//   be troops. New population is split by it, and every tick up to 1/1000 of
//   the cap moves between workers and troops towards the target (5x faster
//   from troops to workers).
// - Workers make the gold: 0.045 x workers^0.7 per tick (the old formula),
//   instead of the flat 100 per tick. More workers = more gold, fewer troops.
// - Nukes kill workers as well as troops.
import type { Game, Player } from "./Game";
import { PlayerType } from "./Game";

export const WORKFORCE = {
  /** Starting troop ratio (%) for everyone; bots and nations keep it. */
  startPercent: 70,
  /** Gold per tick = goldFactor * workers^goldExponent (old OpenFront). */
  goldFactor: 0.045,
  goldExponent: 0.7,
  /** Max share of the population cap moved between troops and workers per tick. */
  adjustShareOfCap: 1 / 1000,
  /** Troops become workers this many times faster than the other way round. */
  downSpeed: 5,
  /** How often (ticks) the workers count is sent to the client view. */
  viewEveryTicks: 10,
} as const;

/** What the client sees of a player's workforce. */
export interface WorkforceView {
  workers: number;
  /** Target troop ratio, percent 1-100. */
  percent: number;
}

/**
 * One tick of the population for a player in Troops and Workers mode.
 * Replaces the normal "addTroops(troopIncreaseRate)" step. Returns the gold
 * the workers made this tick (already added).
 */
export function workforceTick(mg: Game, p: Player): bigint {
  const config = mg.config();
  if (p.type() === PlayerType.Bot || p.type() === PlayerType.Nation) {
    if (p.targetTroopPercent() !== WORKFORCE.startPercent) {
      p.setTargetTroopPercent(WORKFORCE.startPercent);
    }
  }
  const ratio = p.targetTroopPercent() / 100;

  // Growth of the whole population, split by the slider
  const popInc = config.troopIncreaseRate(p);
  if (popInc > 0) {
    p.addTroops(popInc * ratio);
    p.addWorkers(popInc * (1 - ratio));
  }

  // Move troops <-> workers towards the target ratio
  const maxDiff = config.maxTroops(p) * WORKFORCE.adjustShareOfCap;
  const target = (p.troops() + p.workers()) * ratio;
  const diff = target - p.troops();
  if (diff > 0) {
    const moved = p.removeWorkers(Math.min(diff, maxDiff));
    p.addTroops(moved);
  } else if (diff < 0) {
    const moved = p.removeTroops(
      Math.min(-diff, maxDiff * WORKFORCE.downSpeed),
    );
    p.addWorkers(moved);
  }

  const gold = config.goldAdditionRate(p);
  p.addGold(gold);

  if (mg.ticks() % WORKFORCE.viewEveryTicks === 0) p.refreshWorkforceView();
  return gold;
}
