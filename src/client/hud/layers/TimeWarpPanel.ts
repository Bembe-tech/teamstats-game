// TeamStats.Pro "OpenFront 4D": the in-game 4D panel (right edge, middle).
//   ⏪ past view: look back 1–15 s (sepia map; the game keeps running)
//   🔮 forecast on/off
//   ⌛ Time Echo: uses left, cooldown, cost; 🛡️ while attacks are frozen
import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import {
  ECHO_EARLIEST_TICK_AFTER_SPAWN,
  ECHO_MAX_USES,
  ECHO_WINDOW_TICKS,
  GHOST_MAX_USES,
  GHOST_TROOP_PERCENT,
  GHOST_WINDOW_TICKS,
  ORDER_MAX_PENDING,
  PAST_VIEW_MAX_SECONDS,
  echoBlock,
  echoCost,
  ghostBlock,
  ghostCost,
} from "../../../core/game/TimeWarp";
import { Controller } from "../../Controller";
import { TimeWarp } from "../../TimeWarp";
import {
  SendTimeEchoIntentEvent,
  SendTimeGhostIntentEvent,
} from "../../Transport";
import { renderNumber, translateText } from "../../Utils";
import { GameView } from "../../view";

@customElement("time-warp-panel")
export class TimeWarpPanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  private open = true;
  private pastS = 0;
  private lastPastS = 8;
  private echoSentAt = -1000;

  createRenderRoot() {
    this.style.position = "fixed";
    this.style.right = "8px";
    this.style.top = "42%";
    this.style.zIndex = "900";
    this.style.pointerEvents = "auto";
    return this;
  }

  getTickIntervalMs(): number {
    return 200;
  }

  tick() {
    this.requestUpdate();
  }

  private warp(): TimeWarp | null {
    return TimeWarp.current;
  }

  private setPast(s: number) {
    this.pastS = s;
    if (s > 0) this.lastPastS = s;
    this.warp()?.setPast(s);
    this.requestUpdate();
  }

  private togglePast() {
    this.setPast(this.pastS > 0 ? 0 : this.lastPastS);
  }

  private echo() {
    this.echoSentAt = this.game.ticks();
    this.eventBus.emit(new SendTimeEchoIntentEvent());
  }

  render() {
    const warp = this.warp();
    if (!this.game || !warp) return nothing;
    const me = this.game.myPlayer();
    const box =
      "bg-gray-900/85 backdrop-blur-sm rounded-lg shadow-lg text-white text-xs p-2 w-44 flex flex-col gap-1.5 select-none";
    if (!this.open) {
      return html`<button
        class="bg-gray-900/85 rounded-lg px-2 py-1 text-white text-sm font-bold"
        @click=${() => {
          this.open = true;
          this.requestUpdate();
        }}
      >
        4D
      </button>`;
    }
    const avail = Math.min(PAST_VIEW_MAX_SECONDS, warp.availableSeconds());
    this.pastS = warp.pastSeconds(); // the timeline can change it too
    if (this.pastS > 0) this.lastPastS = this.pastS;
    const viewing = this.pastS > 0;

    return html`
      <div class=${box}>
        <div class="flex items-center justify-between">
          <span class="font-bold tracking-wide">⏳ OpenFront 4D</span>
          <button
            class="text-gray-400 hover:text-white px-1"
            title=${translateText("time_warp.hide")}
            @click=${() => {
              this.open = false;
              this.requestUpdate();
            }}
          >
            –
          </button>
        </div>

        ${warp.failed !== null
          ? html`<div class="text-[10px] text-amber-300 leading-tight">
              ${translateText("time_warp.view_off")}
            </div>`
          : this.renderViews(warp, avail, viewing)}
        ${me && me.isAlive() ? this.renderOrders(warp) : nothing}
        ${me ? this.renderEcho() : nothing}
        ${me ? this.renderGhost(warp) : nothing}
      </div>
    `;
  }

  private renderViews(warp: TimeWarp, avail: number, viewing: boolean) {
    return html`
      <button
        class="rounded px-2 py-1 text-left ${viewing
          ? "bg-amber-700"
          : "bg-gray-700 hover:bg-gray-600"}"
        ?disabled=${avail < 1}
        title=${translateText("time_warp.past_hint")}
        @click=${() => this.togglePast()}
      >
        ⏪
        ${viewing
          ? translateText("time_warp.past_on", { s: this.pastS })
          : translateText("time_warp.past")}
      </button>
      ${viewing
        ? html`<input
            type="range"
            min="1"
            max=${Math.max(1, avail)}
            .value=${String(Math.min(this.pastS, Math.max(1, avail)))}
            @input=${(e: Event) =>
              this.setPast(Number((e.target as HTMLInputElement).value))}
          />`
        : nothing}

      <button
        class="rounded px-2 py-1 text-left ${warp.forecastOn
          ? "bg-cyan-800"
          : "bg-gray-700 hover:bg-gray-600"}"
        title=${translateText("time_warp.forecast_hint")}
        @click=${() => {
          warp.forecastOn = !warp.forecastOn;
          this.requestUpdate();
        }}
      >
        🔮
        ${translateText(
          warp.forecastOn ? "time_warp.forecast_on" : "time_warp.forecast_off",
        )}
      </button>
    `;
  }

  /** Delayed orders: pick a delay, the next attack / boat / build waits. */
  private renderOrders(warp: TimeWarp) {
    const me = this.game.myPlayer()!;
    const now = this.game.ticks();
    const armed = warp.orderDelayTicks;
    const pending = me.delayedOrders();
    const btn = (s: number) =>
      html`<button
        class="rounded px-1.5 py-0.5 ${armed === s * 10
          ? "bg-amber-600"
          : "bg-gray-700 hover:bg-gray-600"}"
        @click=${() => {
          warp.orderDelayTicks = armed === s * 10 ? 0 : s * 10;
          this.requestUpdate();
        }}
      >
        ${s}s
      </button>`;
    return html`
      <div class="flex flex-col gap-1">
        <div
          class="flex items-center gap-1"
          title=${translateText("time_warp.order_hint", {
            n: ORDER_MAX_PENDING,
          })}
        >
          <span>⏱</span>
          ${[5, 10, 20, 30, 60].map(btn)}
        </div>
        ${armed > 0
          ? html`<label
              class="flex items-center gap-1 text-[10px] text-amber-200"
            >
              <input
                type="checkbox"
                .checked=${warp.orderDelaySticky}
                @change=${(e: Event) => {
                  warp.orderDelaySticky = (
                    e.target as HTMLInputElement
                  ).checked;
                }}
              />
              ${translateText(
                warp.orderDelaySticky
                  ? "time_warp.order_armed_all"
                  : "time_warp.order_armed",
                { s: armed / 10 },
              )}
            </label>`
          : nothing}
        ${pending.length > 0
          ? html`<div class="text-[10px] text-amber-100 leading-tight">
              ${pending.map(
                (o) =>
                  html`<div>
                    ⏱ ${Math.max(0, Math.ceil((o.fireTick - now) / 10))}s
                    ${translateText(`time_warp.order_${o.kind}`)}
                  </div>`,
              )}
            </div>`
          : nothing}
      </div>
    `;
  }

  private ghostSentAt = -1000;

  private renderGhost(warp: TimeWarp) {
    const me = this.game.myPlayer()!;
    const now = this.game.ticks();
    const state = { used: me.ghostUses(), readyTick: me.ghostReadyTick() };
    const gold = me.gold();
    let block: string = ghostBlock(
      true,
      me.isAlive(),
      this.game.inSpawnPhase(),
      this.game.ticksSinceStart(),
      now,
      state,
      gold,
    );
    if (
      block === "ok" &&
      warp.lostRecently(me.smallID(), GHOST_WINDOW_TICKS / 10) === 0
    ) {
      block = "nothing_lost";
    }
    const pending = now - this.ghostSentAt < 20;
    let status = "";
    switch (block) {
      case "ok":
        status = translateText("time_warp.ghost_cost", {
          gold: renderNumber(Number(ghostCost(gold))),
          pct: GHOST_TROOP_PERCENT,
        });
        break;
      case "nothing_lost":
        status = translateText("time_warp.ghost_nothing", {
          s: GHOST_WINDOW_TICKS / 10,
        });
        break;
      case "cooldown":
        status = translateText("time_warp.echo_cooldown", {
          s: Math.ceil((state.readyTick - now) / 10),
        });
        break;
      case "gold":
        status = translateText("time_warp.ghost_gold");
        break;
      case "no_uses":
        status = translateText("time_warp.echo_none");
        break;
    }
    if (!me.isAlive() || block === "too_early" || block === "spawn") {
      return nothing;
    }
    return html`
      <button
        class="rounded px-2 py-1 text-left ${block === "ok" && !pending
          ? "bg-violet-800 hover:bg-violet-700"
          : "bg-gray-700 opacity-60 cursor-not-allowed"}"
        ?disabled=${block !== "ok" || pending}
        title=${translateText("time_warp.ghost_hint", {
          s: GHOST_WINDOW_TICKS / 10,
          pct: GHOST_TROOP_PERCENT,
        })}
        @click=${() => {
          this.ghostSentAt = this.game.ticks();
          this.eventBus.emit(new SendTimeGhostIntentEvent());
        }}
      >
        👻 ${translateText("time_warp.ghost")}
        (${GHOST_MAX_USES - state.used}/${GHOST_MAX_USES})
      </button>
      ${status
        ? html`<div class="text-[10px] text-gray-300 leading-tight">
            ${status}
          </div>`
        : nothing}
    `;
  }

  private renderEcho() {
    const me = this.game.myPlayer()!;
    const now = this.game.ticks();
    const state = { used: me.echoUses(), readyTick: me.echoReadyTick() };
    const gold = me.gold();
    const block = echoBlock(
      true,
      me.isAlive(),
      this.game.inSpawnPhase(),
      this.game.ticksSinceStart(),
      now,
      state,
      gold,
    );
    const left = ECHO_MAX_USES - state.used;
    const shieldS = Math.ceil((me.timeShieldUntil() - now) / 10);
    const pending = now - this.echoSentAt < 20;
    let status: string;
    switch (block) {
      case "ok":
        status = translateText("time_warp.echo_cost", {
          gold: renderNumber(Number(echoCost(gold))),
        });
        break;
      case "cooldown":
        status = translateText("time_warp.echo_cooldown", {
          s: Math.ceil((state.readyTick - now) / 10),
        });
        break;
      case "too_early":
        status = translateText("time_warp.echo_too_early", {
          s: Math.ceil(
            (ECHO_EARLIEST_TICK_AFTER_SPAWN - this.game.ticksSinceStart()) / 10,
          ),
        });
        break;
      case "gold":
        status = translateText("time_warp.echo_gold");
        break;
      case "no_uses":
        status = translateText("time_warp.echo_none");
        break;
      default:
        status = "";
    }
    return html`
      <button
        class="rounded px-2 py-1 text-left ${block === "ok" && !pending
          ? "bg-purple-700 hover:bg-purple-600"
          : "bg-gray-700 opacity-60 cursor-not-allowed"}"
        ?disabled=${block !== "ok" || pending}
        title=${translateText("time_warp.echo_hint", {
          s: ECHO_WINDOW_TICKS / 10,
        })}
        @click=${() => this.echo()}
      >
        ⌛ ${translateText("time_warp.echo")} (${left}/${ECHO_MAX_USES})
      </button>
      ${status
        ? html`<div class="text-[10px] text-gray-300 leading-tight">
            ${status}
          </div>`
        : nothing}
      ${shieldS > 0
        ? html`<div class="text-[11px] text-purple-300 font-bold">
            🛡️ ${translateText("time_warp.shield", { s: shieldS })}
          </div>`
        : nothing}
    `;
  }
}
