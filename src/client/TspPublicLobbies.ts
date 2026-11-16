// TeamStats.Pro: public lobbies on the home page (Bembe 2026-11-16). A host flips "Public game" in
// the lobby (HostLobbyModal.ts); teamstats/front.cjs keeps the list (/api/tsp/public-lobbies) and
// drops a lobby once it starts or closes. Anyone can join, guests too. Polled every 8 seconds while
// the home page is visible.
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

interface PublicLobby {
  gameID: string;
  host: string;
  avatar: string;
  map: string;
  mode: string;
  teams: string | null;
  fog: boolean;
  players: number;
  maxPlayers: number | null;
  since: number;
}

const nice = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2");

@customElement("tsp-public-lobbies")
export class TspPublicLobbies extends LitElement {
  @state() private lobbies: PublicLobby[] = [];
  @state() private loaded = false;
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
    }, 8000);
  }
  disconnectedCallback() {
    clearInterval(this.timer);
    super.disconnectedCallback();
  }
  private async load() {
    try {
      const r = await fetch("/api/tsp/public-lobbies");
      if (!r.ok) return;
      const d = (await r.json()) as { lobbies?: PublicLobby[] };
      this.lobbies = d.lobbies ?? [];
    } catch {
      // keep the last list
    } finally {
      this.loaded = true;
    }
  }

  render() {
    if (!this.loaded) return nothing;
    return html`<section
      style="margin-top:14px;border:1px solid rgba(110,168,255,.22);border-radius:16px;background:rgba(10,14,22,.72);padding:14px 16px"
    >
      <div
        style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px"
      >
        <span
          style="font:800 12px Inter,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#8f9bab"
          >Public lobbies</span
        >
        <span style="font-size:12px;color:#8f9bab"
          >${this.lobbies.length
            ? `${this.lobbies.length} open`
            : "Host one and switch it to Public game"}</span
        >
      </div>
      ${this.lobbies.length === 0
        ? html`<div style="color:#8f9bab;font-size:13px;padding:6px 0">
            No public lobbies right now.
          </div>`
        : this.lobbies.map(
            (l) =>
              html`<div
                style="display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid rgba(255,255,255,.06)"
              >
                ${l.avatar
                  ? html`<img
                      src=${l.avatar}
                      alt=""
                      referrerpolicy="no-referrer"
                      style="width:30px;height:30px;border-radius:50%;flex:none"
                    />`
                  : html`<span
                      style="width:30px;height:30px;border-radius:50%;flex:none;background:#1a2230"
                    ></span>`}
                <div style="flex:1;min-width:0">
                  <div
                    style="font-weight:800;font-size:14px;color:#edf2f7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
                  >
                    ${nice(l.map) || "Lobby"}
                    <span style="color:#8f9bab;font-weight:600"
                      >·
                      ${nice(l.mode)}${l.teams ? ` (${l.teams})` : ""}${l.fog
                        ? " · Fog of War"
                        : ""}</span
                    >
                  </div>
                  <div style="font-size:12px;color:#8f9bab">
                    Host ${l.host} ·
                    ${l.players}${l.maxPlayers ? "/" + l.maxPlayers : ""}
                    player${l.players === 1 ? "" : "s"}
                  </div>
                </div>
                <a
                  href=${"/game/" + l.gameID}
                  style="padding:8px 16px;border-radius:10px;background:#3d7dff;color:#fff;font-weight:800;text-decoration:none;flex:none"
                  >Join</a
                >
              </div>`,
          )}
    </section>`;
  }
}
