// TeamStats.Pro "King of the Hill 2": the throne panel (top center).
// Who reigns and whether the throne is powered, reign progress of the top
// sides, what the reign costs right now, and the player's own garrison with
// send / withdraw buttons. Rules: core/game/Throne.ts.
import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import { GameMode, PlayerType } from "../../../core/game/Game";
import {
  ThroneStatus,
  throneGoldPerSecond,
  throneHolderDrain,
  thronePlace,
  throneZoneTiles,
} from "../../../core/game/Throne";
import { Controller } from "../../Controller";
import { SendThroneIntentEvent } from "../../Transport";
import { renderNumber, renderTroops } from "../../Utils";
import { GameView, PlayerView } from "../../view";

interface SideRow {
  key: string;
  name: string;
  color: string;
  reign: number;
  garrison: number;
  army: number;
  status: number;
  paid: number;
  mine: boolean;
}

function mmss(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}

@customElement("throne-panel")
export class ThronePanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  private open = true;
  private zone: number[] | null = null;
  private sentAt = -1000;

  createRenderRoot() {
    this.style.position = "fixed";
    // Right edge under the game controls (the leaderboard owns the top left)
    this.style.right = "8px";
    this.style.top = "48px";
    this.style.zIndex = "900";
    this.style.pointerEvents = "auto";
    return this;
  }

  getTickIntervalMs(): number {
    return 250;
  }

  tick() {
    this.requestUpdate();
  }

  private sides(): SideRow[] {
    const teams = this.game.config().gameConfig().gameMode !== GameMode.FFA;
    const me = this.game.myPlayer();
    const myKey =
      me === null
        ? null
        : teams && me.team() !== null
          ? `t:${me.team()}`
          : `p:${me.smallID()}`;
    const out = new Map<string, SideRow>();
    for (const p of this.game.playerViews()) {
      if (!p.isAlive() || p.type() === PlayerType.Bot) continue;
      const team = teams ? p.team() : null;
      const key = team !== null ? `t:${team}` : `p:${p.smallID()}`;
      const t = p.throne();
      let row = out.get(key);
      if (row === undefined) {
        row = {
          key,
          name: team !== null ? String(team) : p.displayName(),
          color: p.territoryColor().toHex(),
          reign: 0,
          garrison: 0,
          army: 0,
          status: 0,
          paid: 0,
          mine: key === myKey,
        };
        out.set(key, row);
      }
      row.reign = Math.max(row.reign, t?.reign ?? 0);
      row.garrison += t?.garrison ?? 0;
      if ((t?.garrison ?? 0) > 0) row.army += p.troops() + t!.garrison;
      if ((t?.status ?? 0) !== 0) {
        row.status = t!.status;
        row.paid = Math.max(row.paid, t!.paid);
      }
    }
    return [...out.values()];
  }

  private ownsZone(me: PlayerView): boolean {
    if (this.zone === null) {
      const place = thronePlace(this.game);
      this.zone = place === null ? [] : throneZoneTiles(this.game, place);
    }
    const id = me.smallID();
    for (const t of this.zone) if (this.game.ownerID(t) === id) return true;
    return false;
  }

  private send(action: "send" | "withdraw", percent: number) {
    this.sentAt = this.game.ticks();
    this.eventBus.emit(new SendThroneIntentEvent(action, percent));
  }

  render() {
    if (!this.game || this.game.inSpawnPhase()) return nothing;
    const need = this.game.config().kingOfTheHill2Minutes() * 60;
    const share = this.game.config().kingOfTheHill2ArmyShare();
    const sides = this.sides();
    const holder = sides.find((s) => s.status !== ThroneStatus.None) ?? null;
    const top = [...sides]
      .filter((s) => s.reign > 0 || s.garrison > 0 || s.mine)
      .sort((a, b) => b.reign - a.reign || b.garrison - a.garrison)
      .slice(0, 4);

    let statusText: string;
    let statusClass: string;
    if (holder === null) {
      statusText = "Empty";
      statusClass = "text-gray-300";
    } else if (holder.status === ThroneStatus.Powered) {
      statusText = "⚡ Powered";
      statusClass = "text-green-400";
    } else if (holder.status === ThroneStatus.LowArmy) {
      statusText = "⚠ Low army";
      statusClass = "text-amber-400";
    } else {
      statusText = "💰 No gold";
      statusClass = "text-red-400";
    }

    return html`
      <div
        class="rounded-lg bg-gray-900/85 text-white text-xs shadow-lg px-3 py-2 w-[340px] max-w-[92vw]"
        style="backdrop-filter: blur(4px)"
      >
        <div
          class="flex items-center gap-2 cursor-pointer select-none"
          @click=${() => {
            this.open = !this.open;
            this.requestUpdate();
          }}
        >
          <span class="text-base">🏰</span>
          ${holder === null
            ? html`<span class="font-semibold">King of the Hill 2</span>`
            : html`<span
                  class="inline-block w-3 h-3 rounded-full"
                  style="background:${holder.color}"
                ></span
                ><span class="font-semibold truncate max-w-[140px]"
                  >${holder.name}</span
                >
                <span class="text-gray-300 whitespace-nowrap"
                  >${mmss(holder.reign)} / ${mmss(need)}</span
                >`}
          <span class="${statusClass} ml-auto whitespace-nowrap"
            >${statusText}</span
          >
          <span class="text-gray-400">${this.open ? "▾" : "▸"}</span>
        </div>
        ${this.open ? this.renderBody(top, holder, need, share) : nothing}
      </div>
    `;
  }

  private renderBody(
    top: SideRow[],
    holder: SideRow | null,
    need: number,
    share: number,
  ) {
    const me = this.game.myPlayer();
    return html`
      <div class="mt-1 flex flex-col gap-1">
        ${top.map(
          (s) =>
            html`<div class="flex items-center gap-2">
              <span
                class="inline-block w-2 h-2 rounded-full"
                style="background:${s.color}"
              ></span>
              <span
                class="w-24 truncate ${s.mine ? "font-semibold" : ""}"
                title=${s.name}
                >${s.status !== 0 ? "👑 " : ""}${s.name}</span
              >
              <div class="flex-1 h-2 rounded bg-gray-700 overflow-hidden">
                <div
                  class="h-2"
                  style="width:${Math.min(
                    100,
                    (s.reign / need) * 100,
                  )}%;background:${s.color}"
                ></div>
              </div>
              <span class="w-28 text-right text-gray-300 whitespace-nowrap"
                >${mmss(s.reign)} · 🛡${renderTroops(s.garrison)}</span
              >
            </div>`,
        )}
        ${holder !== null && holder.status === ThroneStatus.LowArmy
          ? html`<div class="text-amber-400">
              Unpowered: the garrison is below ${share}% of the army of the
              stationing players. The clock is stopped.
            </div>`
          : nothing}
        ${holder !== null && holder.status === ThroneStatus.NoGold
          ? html`<div class="text-red-400">
              Unpowered: not enough gold to pay this second. The clock is
              stopped.
            </div>`
          : nothing}
        ${holder !== null
          ? html`<div class="text-gray-300">
              Reign cost now:
              <b class="text-yellow-300"
                >${renderNumber(throneGoldPerSecond(holder.reign))} gold/s</b
              >, garrison
              −${(throneHolderDrain(holder.reign) / 100).toFixed(1)}%/s · grows
              every second of reign
            </div>`
          : nothing}
        ${me !== null && me.isAlive()
          ? this.renderMine(me, top, share)
          : nothing}
      </div>
    `;
  }

  private renderMine(me: PlayerView, top: SideRow[], share: number) {
    const mine = top.find((s) => s.mine);
    const g = me.throneGarrison();
    const army = (mine?.army ?? 0) + (g > 0 ? 0 : me.troops());
    const pct = army > 0 ? ((mine?.garrison ?? g) / army) * 100 : 0;
    const inZone = this.ownsZone(me);
    const pending = this.game.ticks() - this.sentAt < 5;
    const btn = (label: string, ok: boolean, fn: () => void, title = "") =>
      html`<button
        class="rounded px-2 py-0.5 ${ok && !pending
          ? "bg-amber-700 hover:bg-amber-600"
          : "bg-gray-700 opacity-60 cursor-not-allowed"}"
        ?disabled=${!ok || pending}
        title=${title}
        @click=${fn}
      >
        ${label}
      </button>`;
    return html`<div class="border-t border-gray-700 pt-1 mt-1">
      <div class="flex items-center gap-2 flex-wrap">
        <span
          >Your garrison: <b>${renderTroops(g)}</b>
          <span class="${pct >= share ? "text-green-400" : "text-amber-400"}"
            >(${pct.toFixed(0)}% of army, need ${share}%)</span
          ></span
        >
        <span class="ml-auto flex gap-1">
          ${btn(
            "+10%",
            inZone,
            () => this.send("send", 10),
            "Send 10% of your troops to the throne",
          )}
          ${btn(
            "+25%",
            inZone,
            () => this.send("send", 25),
            "Send 25% of your troops to the throne",
          )}
          ${btn(
            "Withdraw",
            inZone && g > 0,
            () => this.send("withdraw", 0),
            "Bring the whole garrison home",
          )}
        </span>
      </div>
      ${inZone
        ? nothing
        : html`<div class="text-amber-300">
            ${g > 0
              ? "Cut off! Your garrison loses 10% a second: retake a tile in the throne zone."
              : "Take a tile in the throne zone (the ring at the map center) to station troops."}
          </div>`}
    </div>`;
  }
}
