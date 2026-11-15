// TeamStats.Pro "Your Profile" (Bembe 2026-11-15): a button in the top bar and a panel.
// Logged out: log in with Discord at teamstats.pro (front.cjs /login -> site /play -> ticket).
// Logged in: who you are on the site, your game settings as JSON (export / import), and the settings sync:
// every localStorage key starting with "settings." is kept on the teamstats.pro account (front.cjs
// /api/tsp/settings, signed on to the site) and brought into any browser where you log in. Not logged in,
// the settings stay in this browser only (localStorage, as before). On the first login with no settings on
// the account yet, the panel asks whether to move this browser's settings to the account.
import { html, LitElement, nothing } from "lit";
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
  connectedCallback() {
    super.connectedCallback();
    listeners.add(this.onSync);
    void tspMe().then((m) => {
      this.me = m;
      void startSettingsSync();
    });
  }
  disconnectedCallback() {
    listeners.delete(this.onSync);
    super.disconnectedCallback();
  }
  @state() private skins: TspGallerySkin[] | null = null;
  @state() private skinQuery = "";
  @state() private pickedPattern: string | null = tspPatternChoice();

  private pickPattern(p: string | null) {
    setTspPatternChoice(p);
    this.pickedPattern = p;
  }
  private skinsSection() {
    if (this.skins === null) {
      void tspGallerySkins().then((s) => (this.skins = s));
      return html`<div style=${S.muted}>Loading the Skin Gallery…</div>`;
    }
    const q = this.skinQuery.trim().toLowerCase();
    const list = this.skins
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.owner.toLowerCase().includes(q),
      )
      .slice(0, 60);
    const tile = (s: TspGallerySkin | null) => {
      const on = (s?.pattern ?? null) === this.pickedPattern;
      return html`<button
        title=${s
          ? `${s.name}${s.owner ? " by " + s.owner : ""}`
          : "No pattern"}
        @click=${() => this.pickPattern(s?.pattern ?? null)}
        style="padding:4px;border-radius:10px;cursor:pointer;background:#0b1018;border:2px solid ${on
          ? "#57e6ff"
          : "#232c3c"};display:flex;flex-direction:column;align-items:center;gap:4px;width:84px"
      >
        ${s
          ? html`<canvas
              width="72"
              height="48"
              style="border-radius:6px;image-rendering:pixelated"
              data-code=${s.code}
              data-p=${s.primary}
              data-s=${s.secondary}
            ></canvas>`
          : html`<div
              style="width:72px;height:48px;border-radius:6px;background:#1a2230;display:grid;place-items:center;color:#8f9bab;font-size:11px"
            >
              None
            </div>`}
        <span
          style="font-size:10.5px;color:#cbd5e1;max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          >${s ? s.name : "Plain colour"}</span
        >
      </button>`;
    };
    return html`<input
        placeholder="Search skins or creators"
        .value=${this.skinQuery}
        @input=${(e: Event) =>
          (this.skinQuery = (e.target as HTMLInputElement).value)}
        style="width:100%;box-sizing:border-box;padding:9px 10px;border-radius:10px;border:1px solid #232c3c;background:#05060a;color:#edf2f7"
      />
      <div
        style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;max-height:260px;overflow:auto"
      >
        ${tile(null)} ${list.map((s) => tile(s))}
      </div>
      <div style=${S.muted + ";margin-top:6px"}>
        ${this.skins.length
          ? "From the public Skin Gallery on teamstats.pro. Everyone in the game sees your pattern. It applies from your next game."
          : "The Skin Gallery has no public skins yet."}
      </div>`;
  }

  updated() {
    for (const c of this.querySelectorAll<HTMLCanvasElement>(
      "canvas[data-code]:not([data-drawn])",
    )) {
      drawPattern(
        c,
        c.dataset.code ?? "",
        c.dataset.p ?? "#fff",
        c.dataset.s ?? "#000",
      );
      c.dataset.drawn = "1";
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
      </button>
      ${this.open ? this.panel() : nothing}`;
  }
}
