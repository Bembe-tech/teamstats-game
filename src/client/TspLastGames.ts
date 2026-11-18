// TeamStats.Pro: "Last games" on the home page (Bembe 2026-11-18). teamstats/front.cjs keeps every
// finished game on disk (/api/tsp/last-games, /api/tsp/game/<id>); "Watch replay" opens /game/<id>,
// which replays the archived game in this client (JoinLobbyModal.checkArchivedGame). A replay plays
// only on the build it was recorded on, so older games after an update show no button.
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

interface LastGame {
  gameID: string;
  map: string;
  mode: string;
  teams: string | null;
  fog: boolean;
  start: number;
  end: number;
  duration: number;
  winnerTeam: string | null;
  winners: string[];
  players: string[];
  replay: boolean;
}

const nice = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2");
const PAGE = 10;

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
function length(sec: number): string {
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

@customElement("tsp-last-games")
export class TspLastGames extends LitElement {
  @state() private games: LastGame[] = [];
  @state() private loaded = false;
  @state() private shown = PAGE;
  private timer: ReturnType<typeof setInterval> | undefined;

  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    void this.load();
    this.timer = setInterval(() => {
      if (document.visibilityState === "visible" && this.offsetParent !== null)
        void this.load();
    }, 60000);
  }
  disconnectedCallback() {
    clearInterval(this.timer);
    super.disconnectedCallback();
  }
  private async load() {
    try {
      const r = await fetch("/api/tsp/last-games?limit=50");
      if (!r.ok) return;
      const d = (await r.json()) as { games?: LastGame[] };
      this.games = d.games ?? [];
    } catch {
      // keep the last list
    } finally {
      this.loaded = true;
    }
  }

  private winnerText(g: LastGame): string {
    if (g.winnerTeam)
      return `${g.winnerTeam} won${g.winners.length ? ` (${g.winners.join(", ")})` : ""}`;
    if (g.winners.length) return `${g.winners.join(", ")} won`;
    return "No winner";
  }

  render() {
    if (!this.loaded) return nothing;
    const list = this.games.slice(0, this.shown);
    return html`<section
      style="margin-top:14px;border:1px solid rgba(110,168,255,.22);border-radius:16px;background:rgba(10,14,22,.72);padding:14px 16px"
    >
      <div
        style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px"
      >
        <span
          style="font:800 12px Inter,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#8f9bab"
          >Last games</span
        >
        <span style="font-size:12px;color:#8f9bab"
          >${this.games.length ? "Watch any finished game again" : ""}</span
        >
      </div>
      ${list.length === 0
        ? html`<div style="color:#8f9bab;font-size:13px;padding:6px 0">
            No finished games yet.
          </div>`
        : list.map(
            (g) =>
              html`<div
                style="display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid rgba(255,255,255,.06)"
              >
                <div style="flex:1;min-width:0">
                  <div
                    style="font-weight:800;font-size:14px;color:#edf2f7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
                  >
                    ${nice(g.map) || "Game"}
                    <span style="color:#8f9bab;font-weight:600"
                      >·
                      ${nice(g.mode)}${g.teams && /team/i.test(g.mode)
                        ? ` (${g.teams})`
                        : ""}${g.fog ? " · Fog of War" : ""}</span
                    >
                  </div>
                  <div
                    style="font-size:12px;color:#57e6ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
                  >
                    🏆 ${this.winnerText(g)}
                  </div>
                  <div
                    style="font-size:12px;color:#8f9bab;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
                    title=${g.players.join(", ")}
                  >
                    ${ago(g.end)} · ${length(g.duration)} · ${g.players.length}
                    player${g.players.length === 1 ? "" : "s"}:
                    ${g.players.slice(0, 8).join(", ")}${g.players.length > 8
                      ? ", …"
                      : ""}
                  </div>
                </div>
                ${g.replay
                  ? html`<a
                      href=${"/game/" + g.gameID}
                      style="padding:8px 14px;border-radius:10px;background:#3d7dff;color:#fff;font-weight:800;text-decoration:none;flex:none"
                      >Watch replay</a
                    >`
                  : html`<span
                      style="font-size:12px;color:#8f9bab;flex:none;max-width:110px;text-align:right"
                      title="This game was played on an older version of the game, which cannot replay it any more."
                      >Older version</span
                    >`}
              </div>`,
          )}
      ${this.games.length > this.shown
        ? html`<button
            type="button"
            @click=${() => (this.shown += PAGE)}
            style="margin-top:8px;width:100%;padding:9px;border-radius:10px;border:1px solid rgba(110,168,255,.25);background:transparent;color:#6ea8ff;font-weight:700;cursor:pointer"
          >
            Show more
          </button>`
        : nothing}
    </section>`;
  }
}
