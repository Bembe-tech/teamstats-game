// TeamStats.Pro "King of the Hill 2": the throne on the map. A dashed ring
// around the throne zone, a crown at the throne tile in the reigning side's
// color (grey when the throne is empty, pulsing while powered) and a progress
// arc of the holder's reign. Purely visual.
import { ThroneStatus, thronePlace } from "../core/game/Throne";
import type { GameView } from "./view";

export class ThroneOverlay {
  static current: ThroneOverlay | null = null;

  private overlay: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  constructor(private readonly game: GameView) {}

  drawOverlay(
    glCanvas: HTMLCanvasElement,
    centerX: number,
    centerY: number,
    scale: number,
  ): void {
    const place = thronePlace(this.game);
    if (place === null) return;
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
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (this.game.inSpawnPhase()) return;

    const s = scale * dpr;
    const sx = (place.ringX + 0.5 - centerX) * s + (cssW / 2) * dpr;
    const sy = (place.ringY + 0.5 - centerY) * s + (cssH / 2) * dpr;
    const tx = (place.x + 0.5 - centerX) * s + (cssW / 2) * dpr;
    const ty = (place.y + 0.5 - centerY) * s + (cssH / 2) * dpr;
    const r = place.radius * s;

    // Holder
    let color = "#9ca3af";
    let status = ThroneStatus.None;
    let reign = 0;
    for (const p of this.game.playerViews()) {
      const t = p.throne();
      if (t !== null && t.status !== ThroneStatus.None && p.isAlive()) {
        color = p.territoryColor().toHex();
        status = t.status;
        reign = t.reign;
        break;
      }
    }
    const need = this.game.config().kingOfTheHill2Minutes() * 60;
    const now = performance.now();

    // Zone ring
    ctx.save();
    ctx.lineWidth = Math.max(1.5 * dpr, 0.35 * s);
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.strokeStyle = "rgba(255,215,0,0.85)";
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,215,0,0.06)";
    ctx.fill();

    // Reign arc
    if (reign > 0) {
      ctx.lineWidth = Math.max(3 * dpr, 0.7 * s);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(
        sx,
        sy,
        r + ctx.lineWidth,
        -Math.PI / 2,
        -Math.PI / 2 + Math.min(1, reign / need) * Math.PI * 2,
      );
      ctx.stroke();
    }

    // Crown
    const size = Math.max(18 * dpr, Math.min(64 * dpr, 14 * s));
    const pulse =
      status === ThroneStatus.Powered ? 1 + 0.08 * Math.sin(now / 180) : 1;
    ctx.translate(tx, ty);
    ctx.scale(pulse, pulse);
    ctx.beginPath();
    const w = size;
    const h = size * 0.7;
    ctx.moveTo(-w / 2, h / 2);
    ctx.lineTo(-w / 2, -h / 4);
    ctx.lineTo(-w / 4, h / 8);
    ctx.lineTo(0, -h / 2);
    ctx.lineTo(w / 4, h / 8);
    ctx.lineTo(w / 2, -h / 4);
    ctx.lineTo(w / 2, h / 2);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha =
      status === ThroneStatus.Powered || status === 0 ? 1 : 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(1.5 * dpr, size / 14);
    ctx.strokeStyle = "#ffd700";
    ctx.stroke();
    if (status === ThroneStatus.LowArmy || status === ThroneStatus.NoGold) {
      ctx.font = `${Math.round(size * 0.5)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(status === ThroneStatus.NoGold ? "💰" : "⚠", 0, h);
    }
    ctx.restore();
  }

  dispose(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.ctx = null;
  }
}
