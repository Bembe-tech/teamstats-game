// TeamStats.Pro "King of the Hill 2" (lobby option kingOfTheHill2): the
// powered throne. Rules and numbers: game/Throne.ts.
//
// Every second:
//  - sides are players (FFA) or teams; a side's garrison is the sum of its
//    players' garrisons at the throne
//  - the side with the biggest garrison reigns; a challenger takes the throne
//    when its garrison beats the holder's by takeoverMarginPercent
//  - the reign clock of the holder runs only while its garrison is at least
//    armySharePercent of the whole army of its stationing players AND it pays
//    the gold for that second;
//    gold and garrison bleed both grow with the side's reign time so far
//  - first side with kingOfTheHill2Minutes of reign wins; the land win is off
//    (WinCheckExecution), last side standing still wins
//  - nations play for the throne too (send/withdraw, attack the zone)
import {
  Execution,
  Game,
  GameMode,
  MessageType,
  Player,
  PlayerType,
  Team,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import {
  THRONE_DEFAULTS,
  ThroneStatus,
  ThroneView,
  throneGoldPerSecond,
  throneHolderDrain,
  thronePlace,
} from "../game/Throne";
import { throneZone, throneZoneOwners } from "../game/ThroneZone";
import { canSendTroopTransport, troopTransportExecution } from "./AirTransport";
import { AttackExecution } from "./AttackExecution";
import { sendToThrone, withdrawFromThrone } from "./ThroneOrderExecution";

const HARD_TIME_LIMIT_SECONDS = 170 * 60;

interface Side {
  key: string;
  team: Team | null;
  members: Player[];
  garrison: number;
  army: number;
  minSmallID: number;
}

export class ThroneExecution implements Execution {
  private active = true;
  private mg: Game | null = null;
  private holder: string | null = null;
  private reign = new Map<string, number>();
  private status = ThroneStatus.None;
  private paid = 0;
  private lastStatus = ThroneStatus.None;
  private maxSides = 0;
  private tries = 0;
  private announcedAt = -1000;

  init(mg: Game): void {
    this.mg = mg;
  }

  /** Current holder side key (tests). */
  holderKey(): string | null {
    return this.holder;
  }

  reignOf(key: string): number {
    return this.reign.get(key) ?? 0;
  }

  tick(ticks: number): void {
    const mg = this.mg;
    if (mg === null) throw new Error("Not initialized");
    if (ticks % 10 !== 0) return;
    if (thronePlace(mg.map()) === null) {
      this.active = false;
      return;
    }

    const owners = throneZoneOwners(mg);
    // Garrisons cut off from the throne melt away, dead players lose theirs
    for (const p of mg.allPlayers()) {
      const g = p.throneGarrison();
      if (g <= 0) continue;
      if (!p.isAlive()) {
        this.setView(p, { garrison: 0 });
      } else if (!owners.has(p.smallID())) {
        this.setView(p, {
          garrison: drain(g, THRONE_DEFAULTS.strandedDrain),
        });
      }
    }

    const sides = this.sides(mg);
    this.maxSides = Math.max(this.maxSides, sides.size);
    this.pickHolder(mg, sides);

    const share = mg.config().kingOfTheHill2ArmyShare();
    const holder = this.holder === null ? null : sides.get(this.holder)!;
    this.paid = 0;
    if (holder === null) {
      this.status = ThroneStatus.None;
    } else {
      const r = this.reignOf(holder.key);
      if (holder.garrison * 100 < share * holder.army) {
        this.status = ThroneStatus.LowArmy;
      } else if (this.pay(holder, throneGoldPerSecond(r))) {
        this.status = ThroneStatus.Powered;
        this.paid = throneGoldPerSecond(r);
        this.reign.set(holder.key, r + 1);
        for (const m of holder.members) {
          if (m.throneGarrison() > 0) m.addCrownTicks(10);
        }
      } else {
        this.status = ThroneStatus.NoGold;
      }
      if (
        this.status !== this.lastStatus &&
        this.status !== ThroneStatus.Powered
      ) {
        for (const m of holder.members) {
          mg.displayMessage(
            this.status === ThroneStatus.LowArmy
              ? "events_display.throne_low_army"
              : "events_display.throne_no_gold",
            MessageType.ATTACK_FAILED,
            m.id(),
            undefined,
            { share },
          );
        }
      }
    }
    this.lastStatus = this.status;

    // Bleeding: the holder by its reign so far, everyone else a little
    for (const side of sides.values()) {
      const rate =
        side.key === this.holder
          ? throneHolderDrain(this.reignOf(side.key))
          : THRONE_DEFAULTS.idleDrain;
      for (const m of side.members) {
        const g = m.throneGarrison();
        if (g > 0) this.setView(m, { garrison: drain(g, rate) });
      }
    }

    this.publish(mg, sides);

    if (ticks % 50 === 0) this.nations(mg, sides, ticks);

    this.checkWin(mg, sides);
  }

  private sides(mg: Game): Map<string, Side> {
    const teams = mg.config().gameConfig().gameMode !== GameMode.FFA;
    const out = new Map<string, Side>();
    for (const p of mg.allPlayers()) {
      if (p.type() === PlayerType.Bot || !p.isAlive()) continue;
      const team = teams ? p.team() : null;
      const key = team !== null ? `t:${team}` : `p:${p.smallID()}`;
      let s = out.get(key);
      if (s === undefined) {
        s = {
          key,
          team,
          members: [],
          garrison: 0,
          army: 0,
          minSmallID: p.smallID(),
        };
        out.set(key, s);
      }
      s.members.push(p);
      s.garrison += p.throneGarrison();
      // The share counts the armies of the side's stationing players only, so
      // a teammate far from the throne does not block it
      if (p.throneGarrison() > 0) s.army += p.troops() + p.throneGarrison();
      s.minSmallID = Math.min(s.minSmallID, p.smallID());
    }
    return out;
  }

  private pickHolder(mg: Game, sides: Map<string, Side>): void {
    let best: Side | null = null;
    for (const s of sides.values()) {
      if (s.garrison <= 0) continue;
      if (
        best === null ||
        s.garrison > best.garrison ||
        (s.garrison === best.garrison && s.minSmallID < best.minSmallID)
      ) {
        best = s;
      }
    }
    const cur = this.holder === null ? undefined : sides.get(this.holder);
    if (cur === undefined || cur.garrison <= 0) {
      if (this.holder !== null) {
        mg.displayMessage(
          "events_display.throne_empty",
          MessageType.ATTACK_FAILED,
          null,
        );
      }
      this.holder = best?.key ?? null;
      if (best !== null) this.announce(mg, best);
      return;
    }
    if (best === null || best.key === cur.key) return;
    if (
      best.garrison * 100 >
      cur.garrison * (100 + THRONE_DEFAULTS.takeoverMarginPercent)
    ) {
      this.holder = best.key;
      this.announce(mg, best);
    }
  }

  private announce(mg: Game, side: Side): void {
    this.lastStatus = ThroneStatus.None;
    // At most one takeover message every 10 s (the panel shows it live)
    if (mg.ticks() - this.announcedAt < 100) return;
    this.announcedAt = mg.ticks();
    mg.displayMessage(
      "events_display.throne_taken",
      MessageType.CAPTURED_ENEMY_UNIT,
      null,
      undefined,
      { name: sideName(side) },
    );
  }

  /** Takes `cost` gold from the side's garrisoning players, richest first. */
  private pay(side: Side, cost: number): boolean {
    const payers = side.members
      .filter((m) => m.throneGarrison() > 0)
      .sort((a, b) =>
        a.gold() === b.gold()
          ? a.smallID() - b.smallID()
          : a.gold() > b.gold()
            ? -1
            : 1,
      );
    let total = 0n;
    for (const m of payers) total += m.gold();
    let left = BigInt(Math.ceil(cost));
    if (total < left) return false;
    for (const m of payers) {
      if (left <= 0n) break;
      const take = m.gold() < left ? m.gold() : left;
      m.removeGold(take);
      left -= take;
    }
    return true;
  }

  private publish(mg: Game, sides: Map<string, Side>): void {
    for (const side of sides.values()) {
      const reigning = side.key === this.holder;
      for (const m of side.members) {
        this.setView(m, {
          reign: this.reignOf(side.key),
          status: reigning ? this.status : ThroneStatus.None,
          paid: reigning ? this.paid : 0,
        });
      }
    }
    for (const p of mg.allPlayers()) {
      if (!p.isAlive() && p.throne() !== null && p.throne()!.status !== 0) {
        this.setView(p, { status: ThroneStatus.None, paid: 0 });
      }
    }
  }

  private setView(p: Player, patch: Partial<ThroneView>): void {
    const old = p.throne() ?? { garrison: 0, reign: 0, status: 0, paid: 0 };
    const next = { ...old, ...patch };
    if (
      next.garrison === old.garrison &&
      next.reign === old.reign &&
      next.status === old.status &&
      next.paid === old.paid &&
      p.throne() !== null
    ) {
      return;
    }
    p.setThrone(next);
  }

  private checkWin(mg: Game, sides: Map<string, Side>): void {
    const need = mg.config().kingOfTheHill2Minutes() * 60;
    let winner: Side | null = null;
    if (this.holder !== null && this.reignOf(this.holder) >= need) {
      winner = sides.get(this.holder) ?? null;
    } else if (sides.size === 1 && this.maxSides > 1) {
      winner = [...sides.values()][0];
    } else if (mg.elapsedGameSeconds() >= HARD_TIME_LIMIT_SECONDS) {
      for (const s of sides.values()) {
        if (winner === null || this.reignOf(s.key) > this.reignOf(winner.key)) {
          winner = s;
        }
      }
    } else if (sides.size === 0) {
      return;
    }
    if (winner === null) return;
    if (winner.team !== null) {
      mg.setWinner(winner.team, mg.stats().stats());
    } else {
      const top = [...winner.members].sort(
        (a, b) => b.throneGarrison() - a.throneGarrison(),
      )[0];
      mg.setWinner(top, mg.stats().stats());
    }
    this.active = false;
  }

  // Nations: keep the throne powered, challenge when it is in reach, and send
  // troops to the zone when they have no foothold there.
  private nations(mg: Game, sides: Map<string, Side>, ticks: number): void {
    const place = thronePlace(mg.map())!;
    const share = mg.config().kingOfTheHill2ArmyShare();
    const owners = throneZoneOwners(mg);
    const holder = this.holder === null ? null : sides.get(this.holder)!;
    for (const side of sides.values()) {
      for (const n of side.members) {
        if (n.type() !== PlayerType.Nation) continue;
        if (!owners.has(n.smallID())) {
          // Every 20 s, staggered: get a foothold in the zone
          if ((ticks / 50 + n.smallID()) % 4 === 0)
            this.reachZone(mg, n, place.tile);
          continue;
        }
        const reigning = holder !== null && holder.key === side.key;
        const r = this.reignOf(side.key);
        const cost = throneGoldPerSecond(r);
        if (reigning) {
          // Cannot pay for long or the bleed is too high: go home
          if (n.gold() < BigInt(cost * 3)) {
            withdrawFromThrone(mg, n);
            continue;
          }
          const want =
            ((side.army + (n.throneGarrison() > 0 ? 0 : n.troops())) *
              (share + 5)) /
              100 -
            side.garrison;
          if (want > 0 && want <= n.troops() * 0.5) {
            sendToThrone(
              mg,
              n,
              Math.ceil((want / Math.max(1, n.troops())) * 100),
            );
          }
          continue;
        }
        // Not reigning: challenge if it is affordable and in reach
        const target = Math.max(
          holder === null
            ? 0
            : (holder.garrison *
                (100 + THRONE_DEFAULTS.takeoverMarginPercent + 15)) /
                100,
          ((side.army + (n.throneGarrison() > 0 ? 0 : n.troops())) *
            (share + 5)) /
            100,
        );
        const want = target - side.garrison;
        if (
          want > 0 &&
          want <= n.troops() * 0.55 &&
          n.gold() >= BigInt(cost * 20)
        ) {
          sendToThrone(
            mg,
            n,
            Math.ceil((want / Math.max(1, n.troops())) * 100),
          );
        } else if (
          n.throneGarrison() > 0 &&
          holder !== null &&
          want > n.troops()
        ) {
          // Hopeless: bring the idle garrison home
          withdrawFromThrone(mg, n);
        }
      }
    }
  }

  private reachZone(mg: Game, n: Player, throneTile: TileRef): void {
    const zone = throneZone(mg);
    if (zone.length === 0 || n.troops() < 1000) return;
    // A zone tile next to our land: attack whoever holds it
    let next: TileRef | null = null;
    for (const t of zone) {
      if (mg.ownerID(t) === n.smallID()) continue;
      let touches = false;
      mg.forEachNeighbor(t, (nb) => {
        if (mg.ownerID(nb) === n.smallID()) touches = true;
      });
      if (touches) {
        next = t;
        break;
      }
    }
    if (next !== null) {
      const owner = mg.owner(next);
      if (owner.isPlayer()) {
        if (n.isFriendly(owner)) return;
        mg.addExecution(new AttackExecution(n.troops() * 0.3, n, owner.id()));
      } else {
        mg.addExecution(new AttackExecution(n.troops() * 0.3, n, null));
      }
      return;
    }
    // Otherwise by boat (or troop plane): a zone shore tile not held by a
    // friend (sampled around the zone, rotating each try), else the throne
    const shore = zone.filter((t) => mg.isShoreline(t));
    const candidates: TileRef[] = [];
    if (shore.length > 0) {
      const step = Math.max(1, Math.floor(shore.length / 8));
      const offset = (this.tries++ * 7) % step;
      for (let i = offset; i < shore.length; i += step)
        candidates.push(shore[i]);
    }
    candidates.push(throneTile);
    for (const t of candidates) {
      const owner = mg.owner(t);
      if (owner.isPlayer() && (owner === n || n.isFriendly(owner))) continue;
      if (canSendTroopTransport(mg, n, t) === false) continue;
      mg.addExecution(
        troopTransportExecution(mg, n, t, Math.floor(n.troops() * 0.3)),
      );
      return;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}

/** Garrison after one second of `rate` (in 1/10000) bleed. */
function drain(g: number, rate: number): number {
  return Math.max(0, g - Math.ceil((g * rate) / 10000));
}

function sideName(side: Side): string {
  if (side.team !== null) return String(side.team);
  return side.members[0].displayName();
}
