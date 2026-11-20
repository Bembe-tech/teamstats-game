// TeamStats.Pro "Select Silo mode" (lobby option `selectSilo`), the client half.
//
// The player numbers their missile silos 1-9 (radial menu on the silo). With a
// nuke selected (atom, hydrogen or MIRV), the mouse wheel switches the launch
// silo in number order instead of zooming. The chosen silo's unit id goes with
// the build_unit intent (Transport) and the sim launches from it
// (core/game/SiloSelect.ts), so only the choice is client state.
//
// On purpose nothing is chosen when a nuke is picked: a plain click still fires
// from the nearest ready silo, so fast reactions stay one click. The wheel
// cycles nearest -> 1 -> 2 -> ... -> nearest.
import { UnitType } from "../core/game/Game";
import type { UIState } from "./UIState";
import { translateText } from "./Utils";
import type { GameView, UnitView } from "./view";

export const MAX_SILO_NUMBER = 9;

const NUKE_TYPES: ReadonlySet<UnitType> = new Set([
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
]);

export function isSiloNukeType(t: UnitType | null | undefined): boolean {
  return t !== null && t !== undefined && NUKE_TYPES.has(t);
}

// Mirrors render-settings.json "structure" + the structure vertex shader, so
// the number badge sits on the lower edge of the silo icon at every zoom.
const ICON_SIZE = 60;
const SILO_SHAPE_SCALE = 1.55;
const DOTS_ZOOM = 1.2;
const DOT_SCALE = 0.3;
const SCALE_FACTOR_ZOOMED_OUT = 3;
const ICON_GROW_ZOOM = 7;

function siloHalfSizePx(zoom: number): number {
  let iconScale: number;
  if (zoom <= DOTS_ZOOM) iconScale = DOT_SCALE;
  else if (zoom >= ICON_GROW_ZOOM) iconScale = zoom / ICON_GROW_ZOOM;
  else iconScale = Math.min(1, zoom / SCALE_FACTOR_ZOOMED_OUT);
  return ICON_SIZE * iconScale * 0.5 * SILO_SHAPE_SCALE;
}

export type LaunchSilo =
  | { ok: true; siloId: number | undefined }
  | { ok: false; reason: string };

export class SiloSelect {
  /** Set by ClientGameRunner for the running game, null when the mode is off. */
  static current: SiloSelect | null = null;

  /** silo number (1-9) -> silo unit id */
  private readonly numbers = new Map<number, number>();
  /** Chosen silo number, null = nearest ready silo (the normal game rule). */
  private selected: number | null = null;
  private lastGhost: UnitType | null = null;
  private lastWheelAt = 0;
  private flash: { text: string; until: number } | null = null;

  private overlay: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private lastKey = "";

  constructor(
    private readonly game: GameView,
    private readonly uiState: UIState,
  ) {}

  // ---- numbering ---------------------------------------------------------

  /** Own, still standing silo with this unit id, or null. */
  private mySilo(id: number): UnitView | null {
    const me = this.game.myPlayer();
    const u = this.game.unit(id);
    if (!me || !u || !u.isActive() || u.type() !== UnitType.MissileSilo) {
      return null;
    }
    return u.owner().id() === me.id() ? u : null;
  }

  /** Drops numbers of silos that were destroyed, deleted or captured. */
  private prune(): void {
    for (const [n, id] of this.numbers) {
      if (this.mySilo(id) === null) {
        this.numbers.delete(n);
        if (this.selected === n) this.selected = null;
      }
    }
  }

  numberOf(siloId: number): number | null {
    for (const [n, id] of this.numbers) if (id === siloId) return n;
    return null;
  }

  /** Gives the silo number n; a silo that had n before loses it. */
  assign(siloId: number, n: number): void {
    if (n < 1 || n > MAX_SILO_NUMBER || this.mySilo(siloId) === null) return;
    const old = this.numberOf(siloId);
    if (old !== null) this.numbers.delete(old);
    this.numbers.set(n, siloId);
    this.lastKey = "";
  }

  clear(siloId: number): void {
    const n = this.numberOf(siloId);
    if (n === null) return;
    this.numbers.delete(n);
    if (this.selected === n) this.selected = null;
    this.lastKey = "";
  }

  /** Silo currently holding number n (any state), or null. */
  siloWithNumber(n: number): UnitView | null {
    const id = this.numbers.get(n);
    return id === undefined ? null : this.mySilo(id);
  }

  // ---- launch silo -------------------------------------------------------

  private nukeGhostActive(): boolean {
    return isSiloNukeType(this.uiState.ghostStructure as UnitType | null);
  }

  /** Picking a nuke (or switching to another one) always starts at "nearest". */
  private syncGhost(): void {
    const g = (this.uiState.ghostStructure as UnitType | null) ?? null;
    const nuke = isSiloNukeType(g) ? g : null;
    if (nuke !== this.lastGhost) {
      this.selected = null;
      this.lastGhost = nuke;
    }
  }

  /** Wheel over the map: true when it was used to switch silos (no zoom). */
  onWheel(deltaY: number): boolean {
    this.syncGhost();
    if (!this.nukeGhostActive()) return false;
    this.prune();
    if (this.numbers.size === 0) {
      this.showFlash(translateText("select_silo.none_numbered"));
      return true;
    }
    // One notch = one step, also for trackpads that send many small events
    const now = performance.now();
    if (Math.abs(deltaY) < 2 || now - this.lastWheelAt < 120) return true;
    this.lastWheelAt = now;
    const order: (number | null)[] = [
      null,
      ...[...this.numbers.keys()].sort((a, b) => a - b),
    ];
    const i = order.indexOf(this.selected);
    const step = deltaY > 0 ? 1 : -1;
    this.selected = order[(i + step + order.length) % order.length];
    this.lastKey = "";
    return true;
  }

  /** Chosen silo when a nuke ghost is active (for the trajectory preview). */
  selectedSilo(): UnitView | null {
    this.syncGhost();
    if (this.selected === null || !this.nukeGhostActive()) return null;
    return this.siloWithNumber(this.selected);
  }

  /**
   * Silo for a nuke launch being sent now. Without a choice the sim keeps its
   * nearest-silo rule. A chosen silo that is reloading or under construction
   * blocks the launch (firing from another silo is what the player avoided).
   */
  launchSilo(type: UnitType): LaunchSilo {
    if (!isSiloNukeType(type)) return { ok: true, siloId: undefined };
    this.syncGhost();
    this.prune();
    if (this.selected === null) return { ok: true, siloId: undefined };
    const silo = this.siloWithNumber(this.selected);
    if (silo === null) {
      this.selected = null;
      return { ok: true, siloId: undefined };
    }
    if (silo.isUnderConstruction() || silo.isInCooldown()) {
      const reason = translateText("select_silo.reloading", {
        n: this.selected,
      });
      this.showFlash(reason);
      return { ok: false, reason };
    }
    return { ok: true, siloId: silo.id() };
  }

  private showFlash(text: string): void {
    this.flash = { text, until: performance.now() + 1800 };
    this.lastKey = "";
  }

  // ---- drawing -----------------------------------------------------------

  drawOverlay(
    glCanvas: HTMLCanvasElement,
    centerX: number,
    centerY: number,
    scale: number,
  ): void {
    if (this.overlay === null) {
      const c = document.createElement("canvas");
      c.style.cssText =
        "position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none";
      glCanvas.insertAdjacentElement("afterend", c);
      this.overlay = c;
      this.ctx = c.getContext("2d");
    }
    const c = this.overlay;
    const ctx = this.ctx;
    if (ctx === null) return;
    const cssW = glCanvas.clientWidth;
    const cssH = glCanvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (
      c.width !== Math.round(cssW * dpr) ||
      c.height !== Math.round(cssH * dpr)
    ) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
      this.lastKey = "";
    }

    this.syncGhost();
    this.prune();
    const now = performance.now();
    if (this.flash !== null && now > this.flash.until) this.flash = null;
    const ghost = this.nukeGhostActive();

    const badges: { n: number; x: number; y: number; ready: boolean }[] = [];
    for (const [n, id] of this.numbers) {
      const silo = this.mySilo(id);
      if (silo === null) continue;
      const ready = !silo.isInCooldown() && !silo.isUnderConstruction();
      badges.push({
        n,
        x: this.game.x(silo.tile()),
        y: this.game.y(silo.tile()),
        ready,
      });
    }
    const key = `${centerX.toFixed(2)},${centerY.toFixed(2)},${scale.toFixed(4)}|${badges
      .map((b) => `${b.n}:${b.x}:${b.y}:${b.ready ? 1 : 0}`)
      .join(",")}|${ghost ? 1 : 0}:${this.selected}|${this.flash?.text ?? ""}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);

    const s = scale * dpr;
    const tx = (cssW / 2) * dpr - centerX * s;
    const ty = (cssH / 2) * dpr - centerY * s;
    const half = siloHalfSizePx(s);
    const r = Math.max(7 * dpr, Math.min(16 * dpr, half * 0.42));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `bold ${Math.round(r * 1.35)}px sans-serif`;
    for (const b of badges) {
      const sx = (b.x + 0.5) * s + tx;
      // bottom center of the silo icon
      const sy = (b.y + 0.5) * s + ty + half * 0.92;
      if (sx < -40 || sy < -40 || sx > c.width + 40 || sy > c.height + 40) {
        continue;
      }
      const chosen = ghost && this.selected === b.n;
      if (chosen) {
        ctx.beginPath();
        ctx.arc(sx, sy, r * 1.55, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,200,40,0.35)";
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = chosen
        ? "#f5b800"
        : b.ready
          ? "rgba(20,24,32,0.9)"
          : "rgba(90,30,30,0.9)";
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r * 0.18);
      ctx.strokeStyle = chosen ? "#ffffff" : b.ready ? "#f5b800" : "#ff6b6b";
      ctx.stroke();
      ctx.fillStyle = chosen ? "#111111" : "#ffffff";
      ctx.fillText(String(b.n), sx, sy + r * 0.06);
    }

    // Launch silo pill while a nuke is in hand, plus short notices
    const lines: { text: string; warn: boolean }[] = [];
    if (ghost) {
      const silo =
        this.selected === null ? null : this.siloWithNumber(this.selected);
      let text: string;
      let warn = false;
      if (this.selected === null || silo === null) {
        text = translateText("select_silo.launch_nearest");
      } else if (silo.isInCooldown() || silo.isUnderConstruction()) {
        text = translateText("select_silo.reloading", { n: this.selected });
        warn = true;
      } else {
        text = translateText("select_silo.launch_from", { n: this.selected });
      }
      lines.push({ text, warn });
    }
    if (
      this.flash !== null &&
      !lines.some((l) => l.text === this.flash!.text)
    ) {
      lines.push({ text: this.flash.text, warn: true });
    }
    if (lines.length > 0) {
      ctx.font = `bold ${Math.round(14 * dpr)}px sans-serif`;
      // just above the bottom control panel, stacked upwards
      let y = c.height - 130 * dpr;
      for (const l of lines) {
        const w = ctx.measureText(l.text).width + 24 * dpr;
        const h = 26 * dpr;
        const x = c.width / 2;
        ctx.fillStyle = l.warn ? "rgba(120,20,20,0.88)" : "rgba(15,18,26,0.85)";
        ctx.beginPath();
        ctx.roundRect(x - w / 2, y - h / 2, w, h, 13 * dpr);
        ctx.fill();
        ctx.strokeStyle = l.warn ? "#ff6b6b" : "#f5b800";
        ctx.lineWidth = 1.5 * dpr;
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(l.text, x, y + 1);
        y -= h + 6 * dpr;
      }
    }
  }

  dispose(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.ctx = null;
  }
}
