// TeamStats.Pro "OpenFront 4D": the timeline above the bottom HUD.
//   left of "now": the last 15 s (click or drag to look back; events that
//   happened: attacks started, Time Echoes, ghosts, paradoxes, orders fired)
//   right of "now": the next 30 s (your delayed orders, boats landing,
//   attacks running out of troops, the end of a freeze)
import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { PAST_VIEW_MAX_SECONDS } from "../../../core/game/TimeWarp";
import { Controller } from "../../Controller";
import { TimeWarp } from "../../TimeWarp";
import { GameView } from "../../view";

const FUTURE_S = 30;
const TONE: Record<string, string> = {
  me: "#7dd3fc",
  foe: "#f87171",
  info: "#d1d5db",
  order: "#fcd34d",
  boat: "#86efac",
};

interface Mark {
  s: number; // seconds from now (negative = past)
  icon: string;
  text: string;
  color: string;
}

@customElement("time-warp-timeline")
export class TimeWarpTimeline extends LitElement implements Controller {
  public game: GameView;
  private dragging = false;

  createRenderRoot() {
    this.style.position = "fixed";
    this.style.left = "50%";
    this.style.transform = "translateX(-50%)";
    this.style.zIndex = "210";
    this.style.width = "min(560px, 96vw)";
    this.style.pointerEvents = "auto";
    this.style.bottom = "120px";
    return this;
  }

  getTickIntervalMs(): number {
    return 250;
  }

  tick() {
    // Sit just above the bottom HUD (attacks list + control panel)
    let top = window.innerHeight;
    for (const sel of ["attacks-display", "control-panel"]) {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      if (r && r.height > 0 && r.top > 0) top = Math.min(top, r.top);
    }
    this.style.bottom = `${Math.max(0, window.innerHeight - top + 6)}px`;
    this.requestUpdate();
  }

  private marks(warp: TimeWarp): Mark[] {
    const now = this.game.ticks();
    const out: Mark[] = [];
    for (const e of warp.events) {
      out.push({
        s: (e.tick - now) / 10,
        icon: e.icon,
        text: e.text,
        color: TONE[e.tone],
      });
    }
    const me = this.game.myPlayer();
    if (me !== null) {
      for (const o of me.delayedOrders()) {
        out.push({
          s: (o.fireTick - now) / 10,
          icon: "⏱",
          text: `your ${o.kind === "build_unit" ? "build / bomb" : o.kind}`,
          color: TONE.order,
        });
      }
      const shield = (me.timeShieldUntil() - now) / 10;
      if (shield > 0) {
        out.push({
          s: shield,
          icon: "🛡",
          text: "freeze on you ends",
          color: TONE.me,
        });
      }
    }
    for (const b of warp.boats) {
      if (!b.mine && !b.hostile) continue;
      out.push({
        s: b.etaS,
        icon: "⚓",
        text: b.mine ? "your boat lands" : "enemy boat lands",
        color: b.mine ? TONE.boat : TONE.foe,
      });
    }
    for (const f of warp.fronts) {
      if (f.endsInS === null) continue;
      out.push({
        s: f.endsInS,
        icon: "🔮",
        text: f.incoming ? "attack on you runs out" : "your attack runs out",
        color: f.incoming ? TONE.foe : TONE.me,
      });
    }
    return out.filter((m) => m.s >= -PAST_VIEW_MAX_SECONDS && m.s <= FUTURE_S);
  }

  private pctOf(s: number): number {
    const span = PAST_VIEW_MAX_SECONDS + FUTURE_S;
    return ((s + PAST_VIEW_MAX_SECONDS) / span) * 100;
  }

  private seekFromEvent(e: PointerEvent, warp: TimeWarp) {
    const bar = this.querySelector(".tw-bar") as HTMLElement | null;
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    const span = PAST_VIEW_MAX_SECONDS + FUTURE_S;
    const s = ((e.clientX - r.left) / r.width) * span - PAST_VIEW_MAX_SECONDS;
    const avail = Math.min(PAST_VIEW_MAX_SECONDS, warp.availableSeconds());
    warp.setPast(s >= 0 ? 0 : Math.min(avail, Math.max(1, Math.round(-s))));
    this.requestUpdate();
  }

  render() {
    const warp = TimeWarp.current;
    if (!this.game || !warp || warp.failed !== null) return nothing;
    const past = warp.pastSeconds();
    const avail = Math.min(PAST_VIEW_MAX_SECONDS, warp.availableSeconds());
    const nowPct = this.pctOf(0);
    return html`
      <div
        class="tw-bar relative h-7 rounded-md bg-gray-900/80 backdrop-blur-sm shadow select-none cursor-pointer text-[11px]"
        @pointerdown=${(e: PointerEvent) => {
          this.dragging = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          this.seekFromEvent(e, warp);
        }}
        @pointermove=${(e: PointerEvent) => {
          if (this.dragging) this.seekFromEvent(e, warp);
        }}
        @pointerup=${() => {
          this.dragging = false;
        }}
      >
        <div
          class="absolute top-0 bottom-0 rounded-l-md bg-amber-900/40"
          style="left:${this.pctOf(-avail)}%;width:${nowPct -
          this.pctOf(-avail)}%"
          title="Look back (click or drag)"
        ></div>
        <div
          class="absolute top-0 bottom-0 right-0 rounded-r-md bg-cyan-900/25"
          style="left:${nowPct}%"
          title="Forecast"
        ></div>
        <div
          class="absolute top-0 bottom-0 w-0.5 bg-white"
          style="left:${nowPct}%"
        ></div>
        ${past > 0
          ? html`<div
              class="absolute top-[-3px] bottom-[-3px] w-1 rounded bg-amber-400"
              style="left:calc(${this.pctOf(-past)}% - 2px)"
            ></div>`
          : nothing}
        ${this.marks(warp).map(
          (m) =>
            html`<span
              class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 leading-none"
              style="left:${this.pctOf(
                m.s,
              )}%;color:${m.color};text-shadow:0 0 3px #000"
              title="${m.s < 0
                ? `${Math.round(-m.s)} s ago`
                : `in ${Math.round(m.s)} s`}: ${m.text}"
              >${m.icon}</span
            >`,
        )}
        <span class="absolute top-0 left-1 text-[9px] text-gray-400"
          >-${PAST_VIEW_MAX_SECONDS}s</span
        >
        <span
          class="absolute top-0 -translate-x-1/2 text-[9px] text-white"
          style="left:${nowPct}%"
          >${past > 0 ? `-${past}s` : "now"}</span
        >
        <span class="absolute top-0 right-1 text-[9px] text-gray-400"
          >+${FUTURE_S}s</span
        >
      </div>
    `;
  }
}
