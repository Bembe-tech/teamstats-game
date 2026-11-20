// TeamStats.Pro "Your Profile" (Bembe 2026-11-15): a button in the top bar and a panel.
// Logged out: log in with Discord at teamstats.pro (front.cjs /login -> site /play -> ticket).
// Logged in: who you are on the site, your game settings as JSON (export / import), and the settings sync:
// every localStorage key starting with "settings." is kept on the teamstats.pro account (front.cjs
// /api/tsp/settings, signed on to the site) and brought into any browser where you log in. Not logged in,
// the settings stay in this browser only (localStorage, as before). On the first login with no settings on
// the account yet, the panel asks whether to move this browser's settings to the account.
import { html, LitElement, nothing, render } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { verifiedBadge } from "./components/ui/VerifiedBadge";
import {
  drawPattern,
  setTspPatternChoice,
  tspGallerySkins,
  tspPatternChoice,
  type TspGallerySkin,
} from "./TspPattern";

export interface TspMe {
  loggedIn: boolean;
  id?: string;
  name?: string;
  tag?: string;
  avatar?: string;
  profile?: string;
  site?: string;
  login?: string | null;
}

let mePromise: Promise<TspMe> | null = null;
export function tspMe(): Promise<TspMe> {
  mePromise ??= fetch("/api/tsp/me", { credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<TspMe>) : { loggedIn: false }))
    .catch(() => ({ loggedIn: false }));
  return mePromise;
}

const PREFIX = "settings.";
const SKIP = new Set(["settings.audio.resetVersion"]);
const SYNC_USER_KEY = "tsp.sync.user"; // account this browser's settings belong to
const DECLINED_KEY = "tsp.sync.declined"; // account whose "move settings?" was answered No
const RELOAD_GUARD = "tsp.sync.reloaded";
const MAX_BYTES = 200 * 1024;

export function localSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(PREFIX) || SKIP.has(k)) continue;
    const v = localStorage.getItem(k);
    if (v !== null) out[k] = v;
  }
  return out;
}
const snapshot = (s: Record<string, string>) =>
  JSON.stringify(
    Object.keys(s)
      .sort()
      .map((k) => [k, s[k]]),
  );

function writeLocal(s: Record<string, string>) {
  for (const k of Object.keys(localSettings()))
    if (!(k in s)) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(s))
    if (k.startsWith(PREFIX) && typeof v === "string")
      localStorage.setItem(k, v);
}

type SyncState =
  | "off" // not logged in: browser only
  | "ask" // logged in, account empty, this browser has settings
  | "declined" // answered No on this browser
  | "synced"
  | "saving"
  | "error";
let syncState: SyncState = "off";
let lastSaved = 0;
let lastSnap = "";
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

async function remoteGet(): Promise<{
  settings: Record<string, string> | null;
} | null> {
  try {
    const r = await fetch("/api/tsp/settings", { credentials: "same-origin" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
export async function saveToAccount(): Promise<boolean> {
  const s = localSettings();
  const body = JSON.stringify({ settings: s });
  if (body.length > MAX_BYTES) {
    syncState = "error";
    changed();
    return false;
  }
  syncState = "saving";
  changed();
  try {
    const r = await fetch("/api/tsp/settings", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!r.ok) throw new Error(String(r.status));
    lastSnap = snapshot(s);
    lastSaved = Date.now();
    syncState = "synced";
    const me = await tspMe();
    if (me.id) {
      localStorage.setItem(SYNC_USER_KEY, me.id);
      localStorage.removeItem(DECLINED_KEY);
    }
    changed();
    return true;
  } catch {
    syncState = "error";
    changed();
    return false;
  }
}

let started = false;
export async function startSettingsSync() {
  if (started) return;
  started = true;
  const me = await tspMe();
  if (!me.loggedIn || !me.id) {
    syncState = "off";
    changed();
    return;
  }
  const remote = await remoteGet();
  if (remote === null) {
    syncState = "error";
    changed();
    return;
  }
  const local = localSettings();
  if (remote.settings && Object.keys(remote.settings).length) {
    const same = snapshot(remote.settings) === snapshot(local);
    if (!same) {
      writeLocal(remote.settings);
      localStorage.setItem(SYNC_USER_KEY, me.id);
      // the game read its settings at start: reload once so it uses the account's
      if (sessionStorage.getItem(RELOAD_GUARD) !== me.id) {
        sessionStorage.setItem(RELOAD_GUARD, me.id);
        location.reload();
        return;
      }
    }
    lastSnap = snapshot(localSettings());
    syncState = "synced";
  } else if (Object.keys(local).length === 0) {
    lastSnap = snapshot(local);
    syncState = "synced";
  } else if (localStorage.getItem(DECLINED_KEY) === me.id) {
    syncState = "declined";
  } else {
    syncState = "ask";
  }
  changed();
  // Changes made in the settings screens: saved to the account a moment later.
  setInterval(() => {
    if (syncState !== "synced") return;
    const snap = snapshot(localSettings());
    if (snap !== lastSnap) void saveToAccount();
  }, 5000);
}
export function declineMove() {
  void tspMe().then((me) => {
    if (me.id) localStorage.setItem(DECLINED_KEY, me.id);
    syncState = "declined";
    changed();
  });
}

const S = {
  overlay:
    "position:fixed;inset:0;z-index:10000;background:rgba(3,5,10,.72);display:flex;align-items:center;justify-content:center;padding:16px",
  card: "width:min(560px,100%);max-height:90vh;overflow:auto;border-radius:18px;background:linear-gradient(180deg,rgba(18,26,38,.98),rgba(9,12,18,.98));border:1px solid rgba(110,168,255,.28);box-shadow:0 24px 80px rgba(0,0,0,.55);padding:22px;color:#edf2f7;font:14px Inter,system-ui,sans-serif",
  btn: "padding:10px 14px;border-radius:10px;border:1px solid #2c3949;background:#101721;color:#edf2f7;font-weight:700;cursor:pointer",
  main: "padding:10px 14px;border-radius:10px;border:0;background:#3d7dff;color:#fff;font-weight:800;cursor:pointer;text-decoration:none;display:inline-block",
  muted: "color:#8f9bab;font-size:12.5px;line-height:1.5",
  h: "margin:18px 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8f9bab",
};

@customElement("tsp-profile-button")
export class TspProfileButton extends LitElement {
  @property({ type: String }) size: "desktop" | "mobile" = "desktop";
  @state() private me: TspMe | null = null;
  @state() private open = false;
  @state() private json = "";
  @state() private note = "";

  createRenderRoot() {
    return this;
  }
  private onSync = () => this.requestUpdate();
  // "Choose skin" from elsewhere (the lobby's waiting screen, JoinLobbyModal.ts): one instance answers.
  private static skinOpener: TspProfileButton | null = null;
  private reloadAfterPick = false;
  private onOpenSkins = (e: Event) => {
    if (TspProfileButton.skinOpener !== this) return;
    this.reloadAfterPick =
      (e as CustomEvent<{ reload?: boolean }>).detail?.reload === true;
    this.loadSkins();
    this.preview = this.currentSkin();
    this.skinModal = true;
  };
  // The windows live in a box on <body>: the nav bar has a backdrop blur, which would trap
  // position:fixed inside the bar.
  private portal: HTMLDivElement | null = null;
  connectedCallback() {
    super.connectedCallback();
    listeners.add(this.onSync);
    TspProfileButton.skinOpener ??= this;
    window.addEventListener("tsp-open-skins", this.onOpenSkins);
    void tspMe().then((m) => {
      this.me = m;
      void startSettingsSync();
    });
  }
  disconnectedCallback() {
    this.portal?.remove();
    this.portal = null;
    listeners.delete(this.onSync);
    window.removeEventListener("tsp-open-skins", this.onOpenSkins);
    if (TspProfileButton.skinOpener === this)
      TspProfileButton.skinOpener = null;
    super.disconnectedCallback();
  }
  @state() private skins: TspGallerySkin[] | null = null;
  @state() private skinQuery = "";
  @state() private skinSort: "top" | "new" | "name" = "top";
  @state() private pickedPattern: string | null = tspPatternChoice();
  @state() private skinModal = false;
  @state() private preview: TspGallerySkin | null = null;

  // Star ratings (front.cjs /api/tsp/skin-rate -> teamstats.pro): only logged-in players rate, like the
  // gallery on the site. mine = this account's stars by skin id, own = its own skins (no rating those).
  @state() private rates: {
    loggedIn: boolean;
    login?: string | null;
    mine: Record<string, number>;
    own: string[];
  } | null = null;
  @state() private hoverStars = 0;
  @state() private rateNote = "";
  @state() private rateBusy = false;

  private loadSkins() {
    if (this.skins === null)
      void tspGallerySkins().then((s) => (this.skins = s));
    if (this.rates === null || !this.rates.loggedIn) void this.loadRates();
  }
  private async loadRates() {
    try {
      const r = await fetch("/api/tsp/skin-rate", {
        credentials: "same-origin",
      });
      const d = await r.json();
      this.rates = {
        loggedIn: !!d.loggedIn,
        login: d.login ?? null,
        mine: d.loggedIn && d.mine ? d.mine : {},
        own: d.loggedIn && Array.isArray(d.own) ? d.own : [],
      };
    } catch {
      this.rates = { loggedIn: false, login: null, mine: {}, own: [] };
    }
  }
  private async rateSkin(s: TspGallerySkin, stars: number) {
    if (!this.rates?.loggedIn || this.rateBusy) return;
    if ((this.rates.mine[s.id] ?? 0) === stars) stars = 0; // same star again takes the rating back
    this.rateBusy = true;
    this.rateNote = "";
    try {
      const r = await fetch("/api/tsp/skin-rate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skin: s.id, stars }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.item)
        throw new Error(d.error ?? "Could not save the rating.");
      // the same object sits in this.skins and this.preview
      s.rating = Number(d.item.rating) || 0;
      s.ratings = Number(d.item.ratings) || 0;
      const mine = { ...this.rates.mine };
      if (d.item.myRating) mine[s.id] = d.item.myRating;
      else delete mine[s.id];
      this.rates = { ...this.rates, mine };
      this.skins = this.skins ? [...this.skins] : this.skins;
      this.rateNote = stars
        ? "Thanks! Your rating is saved."
        : "Rating removed.";
    } catch (e) {
      this.rateNote = (e as Error).message;
    }
    this.rateBusy = false;
  }
  private rateBox(p: TspGallerySkin, site: string) {
    const r = this.rates;
    const own = !!r?.own.includes(p.id);
    const mine = r?.mine[p.id] ?? 0;
    const shown = this.hoverStars || mine;
    const avg = p.rating
      ? html`<b style="color:#ffd166">★ ${p.rating.toFixed(1)}</b>
          <span style="color:#8f9bab"
            >(${p.ratings ?? 0} rating${p.ratings === 1 ? "" : "s"})</span
          >`
      : html`<span style="color:#8f9bab">No ratings yet</span>`;
    let body;
    if (r === null) body = html`<div style=${S.muted}>Loading…</div>`;
    else if (!r.loggedIn)
      body = html`<div style=${S.muted + ";margin-bottom:6px"}>
          Log in with Discord to rate skins.
        </div>
        ${r.login
          ? html`<a
              href=${r.login}
              style=${S.btn + ";display:block;text-align:center"}
              >Log in to rate</a
            >`
          : nothing}`;
    else if (own)
      body = html`<div style=${S.muted}>
        This is your skin. Others rate it.
      </div>`;
    else
      body = html`<div
          style="display:flex;gap:2px"
          @mouseleave=${() => (this.hoverStars = 0)}
          role="radiogroup"
          aria-label="Your rating"
        >
          ${[1, 2, 3, 4, 5].map(
            (n) =>
              html`<button
                title=${mine === n
                  ? "Click again to remove your rating"
                  : n + " star" + (n > 1 ? "s" : "")}
                aria-label=${n + " star" + (n > 1 ? "s" : "")}
                aria-checked=${mine === n ? "true" : "false"}
                role="radio"
                ?disabled=${this.rateBusy}
                @mouseenter=${() => (this.hoverStars = n)}
                @click=${() => this.rateSkin(p, n)}
                style="background:none;border:0;padding:0 2px;cursor:pointer;font-size:26px;line-height:1;color:${n <=
                shown
                  ? "#ffd166"
                  : "#3a4558"}"
              >
                ★
              </button>`,
          )}
        </div>
        <div style=${S.muted + ";font-size:12px"}>
          ${this.rateNote ||
          (mine ? "Your rating: " + mine + " ★" : "Click a star to rate.")}
        </div>`;
    return html`<div
      style="margin:10px 0;padding:10px 12px;border-radius:12px;border:1px solid #1f2938;background:#0a0f18"
    >
      <div style="font-size:13px;margin-bottom:6px">${avg}</div>
      ${body}
      <a
        href=${site + "/skin-gallery.html"}
        target="_blank"
        rel="noopener"
        style="display:block;margin-top:8px;color:#6ea8ff;font-size:12.5px"
        >Comments in the gallery on teamstats.pro ↗</a
      >
    </div>`;
  }
  private currentSkin(): TspGallerySkin | null {
    return this.skins?.find((s) => s.pattern === this.pickedPattern) ?? null;
  }
  private pickPattern(p: string | null) {
    setTspPatternChoice(p);
    this.pickedPattern = p;
    // in a lobby: join again so the new skin is used in this game
    if (this.reloadAfterPick) setTimeout(() => location.reload(), 300);
  }
  private patternCanvas(s: TspGallerySkin, w: number, h: number) {
    return html`<canvas
      width=${w}
      height=${h}
      style="display:block;width:100%;height:auto;border-radius:8px;image-rendering:pixelated;background:#0b1018"
      data-code=${s.code}
      data-p=${s.primary}
      data-s=${s.secondary}
    ></canvas>`;
  }

  // In the profile panel: what you wear now and a button that opens the gallery window.
  private skinsSection() {
    this.loadSkins();
    const cur = this.currentSkin();
    return html`<div
      style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:12px;border:1px solid #232c3c;background:#0b1018"
    >
      <div style="width:96px;flex:none">
        ${cur
          ? this.patternCanvas(cur, 96, 60)
          : html`<div
              style="height:60px;border-radius:8px;background:#1a2230;display:grid;place-items:center;color:#8f9bab;font-size:11px"
            >
              Plain colour
            </div>`}
      </div>
      <div style="flex:1;min-width:0">
        <b>${cur ? cur.name : this.pickedPattern ? "Skin" : "No skin"}</b>
        <div style=${S.muted}>
          ${cur?.owner ? "by " + cur.owner + " · " : ""}Free for everyone
        </div>
      </div>
      <button
        style=${S.main}
        @click=${() => {
          this.preview = cur;
          this.skinModal = true;
        }}
      >
        Choose skin
      </button>
    </div>`;
  }

  // The gallery window: big grid, search, sort, preview and "Use this skin".
  private skinWindow() {
    const site = this.me?.site ?? "https://teamstats.pro";
    const q = this.skinQuery.trim().toLowerCase();
    const all = this.skins ?? [];
    const list = all
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.owner.toLowerCase().includes(q),
      )
      .slice()
      .sort((a, b) =>
        this.skinSort === "name"
          ? a.name.localeCompare(b.name)
          : this.skinSort === "new"
            ? (b.created ?? "").localeCompare(a.created ?? "")
            : b.rating - a.rating,
      );
    const p = this.preview;
    const worn = (s: TspGallerySkin | null) =>
      (s?.pattern ?? null) === this.pickedPattern;
    const card = (s: TspGallerySkin) =>
      html`<button
        @click=${() => {
          this.preview = s;
          this.rateNote = "";
          this.hoverStars = 0;
        }}
        @dblclick=${() => this.pickPattern(s.pattern)}
        title=${s.name + (s.owner ? " by " + s.owner : "")}
        style="text-align:left;padding:8px;border-radius:14px;cursor:pointer;background:#0d1320;border:2px solid ${p?.pattern ===
        s.pattern
          ? "#57e6ff"
          : worn(s)
            ? "#3d7dff"
            : "#1f2938"};color:#edf2f7;display:flex;flex-direction:column;gap:6px;min-width:0"
      >
        ${this.patternCanvas(s, 160, 100)}
        <span
          style="font-weight:800;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          >${s.name}</span
        >
        <span
          style="display:flex;justify-content:space-between;gap:6px;font-size:11px;color:#8f9bab"
        >
          <span
            style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            >${s.owner ? "by " + s.owner : ""}</span
          >
          <span style="flex:none"
            >${worn(s)
              ? html`<b style="color:#6ea8ff">WORN</b>`
              : s.rating
                ? "★ " + s.rating.toFixed(1)
                : ""}</span
          >
        </span>
      </button>`;
    const close = () => {
      this.skinModal = false;
      this.reloadAfterPick = false;
    };
    return html`<div
      style=${S.overlay + ";z-index:10001"}
      @click=${(e: Event) => e.target === e.currentTarget && close()}
    >
      <div
        style=${S.card +
        ";width:min(1040px,100%);max-height:92vh;display:flex;flex-direction:column;padding:0;overflow-y:auto"}
        role="dialog"
        aria-label="Skin Gallery"
      >
        <div
          style="display:flex;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid #1f2938;flex-wrap:wrap"
        >
          <div style="flex:1;min-width:200px">
            <div
              style="font:900 22px Orbitron,Inter,system-ui,sans-serif;letter-spacing:.04em"
            >
              SKIN <span style="color:#57e6ff">GALLERY</span>
            </div>
            <div style=${S.muted}>
              All skins are <b style="color:#5ee39a">free</b>. Pick one and
              everyone in your games sees it on your territory.
            </div>
          </div>
          <a
            href=${site + "/skin-creator.html"}
            target="_blank"
            rel="noopener"
            style=${S.main}
            >＋ Create your own skin</a
          >
          <button style=${S.btn} @click=${close} aria-label="Close">✕</button>
        </div>
        <div
          style="display:flex;gap:8px;padding:12px 20px;border-bottom:1px solid #1f2938;flex-wrap:wrap"
        >
          <input
            placeholder="Search skins or creators"
            .value=${this.skinQuery}
            @input=${(e: Event) =>
              (this.skinQuery = (e.target as HTMLInputElement).value)}
            style="flex:1;min-width:180px;padding:10px 12px;border-radius:10px;border:1px solid #232c3c;background:#05060a;color:#edf2f7"
          />
          ${(["top", "new", "name"] as const).map(
            (k) =>
              html`<button
                style=${S.btn +
                (this.skinSort === k
                  ? ";border-color:#57e6ff;color:#57e6ff"
                  : "")}
                @click=${() => (this.skinSort = k)}
              >
                ${k === "top" ? "Top rated" : k === "new" ? "Newest" : "A–Z"}
              </button>`,
          )}
        </div>
        <div style="display:flex;flex:1;min-height:0;flex-wrap:wrap">
          <div
            style="flex:1 1 520px;min-width:0;overflow:auto;padding:16px 20px;max-height:62vh"
          >
            ${this.skins === null
              ? html`<div style=${S.muted}>Loading the Skin Gallery…</div>`
              : list.length
                ? html`<div
                    style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(140px,40vw),1fr));gap:10px"
                  >
                    ${list.map(card)}
                  </div>`
                : html`<div style=${S.muted}>
                    ${all.length
                      ? "No skin matches that search."
                      : "The Skin Gallery has no public skins yet."}
                  </div>`}
          </div>
          <div
            style="flex:0 1 280px;min-width:240px;padding:16px 20px;border-left:1px solid #1f2938;background:rgba(5,8,14,.5)"
          >
            ${p
              ? html`${this.patternCanvas(p, 256, 160)}
                  <div style="font-weight:900;font-size:17px;margin-top:10px">
                    ${p.name}
                  </div>
                  <div style=${S.muted}>${p.owner ? "by " + p.owner : ""}</div>
                  <div style="display:flex;gap:6px;margin:10px 0">
                    <span
                      title="Territory colour"
                      style="width:22px;height:22px;border-radius:6px;border:1px solid #fff3;background:${p.primary}"
                    ></span>
                    <span
                      title="Pattern colour"
                      style="width:22px;height:22px;border-radius:6px;border:1px solid #fff3;background:${p.secondary}"
                    ></span>
                  </div>
                  ${worn(p)
                    ? html`<button style=${S.btn + ";width:100%"} disabled>
                        ✓ You wear this skin
                      </button>`
                    : html`<button
                        style=${S.main + ";width:100%"}
                        @click=${() => this.pickPattern(p.pattern)}
                      >
                        Use this skin
                      </button>`}
                  ${this.rateBox(p, site)}`
              : html`<div style=${S.muted}>
                  Click a skin to see it here. Double-click to wear it at once.
                </div>`}
            ${this.pickedPattern
              ? html`<button
                  style=${S.btn + ";width:100%;margin-top:14px"}
                  @click=${() => this.pickPattern(null)}
                >
                  Remove skin (plain colour)
                </button>`
              : nothing}
            <div
              style="margin-top:16px;padding:12px;border-radius:12px;border:1px solid rgba(94,227,154,.3);background:rgba(94,227,154,.06);font-size:12.5px;line-height:1.5;color:#cbd5e1"
            >
              <b style="color:#5ee39a">Free, always.</b> Skins cost nothing and
              unlock nothing. Make your own in the
              <a
                href=${site + "/skin-creator.html"}
                target="_blank"
                rel="noopener"
                style="color:#6ea8ff"
                >Skin Creator</a
              >, share it in the gallery and anyone can play with it.
              ${this.reloadAfterPick
                ? "Your pick is used in this lobby right away"
                : "Your pick applies from your next game"}${this.me?.loggedIn
                ? " and is saved on your account."
                : " and is saved in this browser."}
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  updated() {
    this.portal ??= document.body.appendChild(document.createElement("div"));
    render(
      html`${this.open ? this.panel() : nothing}
      ${this.skinModal ? this.skinWindow() : nothing}`,
      this.portal,
      { host: this },
    );
    for (const c of this.portal.querySelectorAll<HTMLCanvasElement>(
      "canvas[data-code]",
    )) {
      if (c.dataset.drawn === c.dataset.code) continue;
      drawPattern(
        c,
        c.dataset.code ?? "",
        c.dataset.p ?? "#fff",
        c.dataset.s ?? "#000",
      );
      c.dataset.drawn = c.dataset.code ?? "";
    }
    // first login with browser settings: open the panel once to ask
    if (
      syncState === "ask" &&
      !this.open &&
      this.getClientRects().length > 0 &&
      !sessionStorage.getItem("tsp.asked")
    ) {
      sessionStorage.setItem("tsp.asked", "1");
      this.open = true;
    }
  }

  private openSettings() {
    this.open = false;
    document.querySelector<HTMLElement>('[data-page="page-settings"]')?.click();
  }
  private exportJson() {
    this.json = JSON.stringify(localSettings(), null, 1);
    this.note =
      "Copied the settings below. Keep them or paste them into another browser.";
    void navigator.clipboard?.writeText(this.json).catch(() => {});
  }
  private importJson() {
    try {
      const v = JSON.parse(this.json) as Record<string, unknown>;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
      const s: Record<string, string> = {};
      for (const [k, x] of Object.entries(v))
        if (k.startsWith(PREFIX))
          s[k] = typeof x === "string" ? x : JSON.stringify(x);
      if (!Object.keys(s).length) throw new Error();
      for (const [k, x] of Object.entries(s)) localStorage.setItem(k, x);
      this.note = "Imported. The page reloads to use them.";
      const after = () => location.reload();
      if (this.me?.loggedIn && syncState !== "declined" && syncState !== "off")
        void saveToAccount().then(after);
      else setTimeout(after, 600);
    } catch {
      this.note =
        'That is not a settings JSON (it should look like {"settings.graphics": "..."}).';
    }
  }

  private statusLine() {
    switch (syncState) {
      case "off":
        return "Settings are saved in this browser only.";
      case "ask":
        return "Your account has no settings yet.";
      case "declined":
        return "Settings stay in this browser (you chose not to move them).";
      case "saving":
        return "Saving to your account…";
      case "error":
        return "Could not reach your account right now; settings are kept in this browser.";
      default:
        return lastSaved
          ? `Saved to your account at ${new Date(lastSaved).toLocaleTimeString()}.`
          : "Saved to your teamstats.pro account.";
    }
  }

  private panel() {
    const me = this.me;
    const close = () => {
      this.open = false;
      this.note = "";
    };
    return html`<div
      style=${S.overlay}
      @click=${(e: Event) => e.target === e.currentTarget && close()}
    >
      <div style=${S.card} role="dialog" aria-label="Your Profile">
        <div style="display:flex;align-items:center;gap:14px">
          ${me?.loggedIn && me.avatar
            ? html`<img
                src=${me.avatar}
                alt=""
                style="width:56px;height:56px;border-radius:50%;border:2px solid #232c3c"
              />`
            : nothing}
          <div style="flex:1;min-width:0">
            <div
              style="font-size:20px;font-weight:900;display:flex;align-items:center;gap:6px"
            >
              ${me?.loggedIn
                ? html`${me.tag ? `[${me.tag}] ` : ""}${me.name}
                  ${verifiedBadge(
                    "w-5 h-5",
                    "text-cyan-300",
                    "Verified TeamStats.pro player",
                  )}`
                : "Your Profile"}
            </div>
            <div style=${S.muted}>${this.statusLine()}</div>
          </div>
          <button style=${S.btn} @click=${close} aria-label="Close">✕</button>
        </div>

        ${!me?.loggedIn
          ? html`<p style=${S.muted + ";margin-top:16px"}>
                Log in with Discord at TeamStats.pro to play under your site
                name and clan tag with the verified check, keep your game
                settings on your account in every browser and get your games on
                your profile. You can always play without logging in.
              </p>
              <a style=${S.main} href=${me?.login ?? "/login"}
                >Log in with Discord</a
              >`
          : html`
              ${syncState === "ask"
                ? html`<div
                    style="margin-top:16px;padding:14px;border-radius:12px;border:1px solid rgba(87,230,255,.35);background:rgba(87,230,255,.07)"
                  >
                    <b>Move this browser's settings to your account?</b>
                    <div style=${S.muted}>
                      Then they follow you to every browser where you log in.
                    </div>
                    <div
                      style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"
                    >
                      <button style=${S.main} @click=${() => saveToAccount()}>
                        Yes, move them
                      </button>
                      <button style=${S.btn} @click=${declineMove}>
                        No, keep them here
                      </button>
                    </div>
                  </div>`
                : nothing}
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
                ${me.profile
                  ? html`<a
                      style=${S.main}
                      href=${me.profile}
                      target="_blank"
                      rel="noopener"
                      >My games on teamstats.pro</a
                    >`
                  : nothing}
                ${syncState === "declined" || syncState === "error"
                  ? html`<button style=${S.btn} @click=${() => saveToAccount()}>
                      Save settings to my account
                    </button>`
                  : nothing}
                <a style=${S.btn + ";text-decoration:none"} href="/logout"
                  >Log out</a
                >
              </div>
            `}

        <div style=${S.h}>Territory pattern</div>
        ${this.skinsSection()}

        <div style=${S.h}>Game settings</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button style=${S.btn} @click=${this.openSettings}>
            Open settings (graphics, sound, keys)
          </button>
          <button style=${S.btn} @click=${this.exportJson}>Export JSON</button>
          <button style=${S.btn} @click=${this.importJson}>Import JSON</button>
        </div>
        <textarea
          style="margin-top:10px;width:100%;min-height:110px;border-radius:10px;border:1px solid #232c3c;background:#05060a;color:#edf2f7;font:12px ui-monospace,monospace;padding:10px;box-sizing:border-box"
          placeholder="Paste a settings JSON here, then Import JSON. (A graphics preset JSON goes in Settings → Graphics.)"
          .value=${this.json}
          @input=${(e: Event) =>
            (this.json = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
        ${this.note ? html`<div style=${S.muted}>${this.note}</div>` : nothing}
      </div>
    </div>`;
  }

  render() {
    const me = this.me;
    const small = this.size === "mobile";
    return html`<button
      class="flex items-center gap-2 rounded-full cursor-pointer text-white/80 hover:text-malibu-blue transition-colors ${small
        ? "px-2 h-9"
        : "px-3 h-10"}"
      style="border:1px solid rgba(110,168,255,.25);background:rgba(16,23,33,.7)"
      @click=${() => (this.open = true)}
      title="Your Profile"
    >
      ${me?.loggedIn && me.avatar
        ? html`<img
            src=${me.avatar}
            alt=""
            style="width:22px;height:22px;border-radius:50%"
          />`
        : html`<svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z"
            />
          </svg>`}
      ${small
        ? nothing
        : html`<span class="text-xs font-bold uppercase tracking-wider"
            >${me?.loggedIn ? "Your Profile" : "Log in"}</span
          >`}
    </button> `;
  }
}
