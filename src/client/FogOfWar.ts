// TeamStats.Pro: Fog of War (lobby option `fogOfWar`).
//
// The game itself is unchanged: every browser still simulates everything.
// This only decides what the local player is SHOWN. Each tick it works out
// which parts of the map the player (and allies/teammates) can see, then
// filters the FrameData before it goes to the renderer:
//   - vision: a band around friendly land, bigger circles around friendly
//     units (warships and SAMs see far, so scouting with ships pays off);
//   - territory outside vision shows what was last seen there ("memory");
//   - enemy units, structures, names, trails and attack effects outside
//     vision are hidden; nuke detonations stay visible (a flash on the
//     horizon), incoming nukes only once they fly into vision;
//   - a dark overlay (drawn by drawOverlay on a 2D canvas over the map)
//     covers everything outside vision.
//   - spawn phase: other players are hidden everywhere (no dark overlay,
//     the map stays readable for picking a spot);
//   - the player's OWN nukes (not allies') light up the sky around them in
//     flight, and the blast area stays visible for a few seconds after the
//     detonation, then goes back under the fog.
// No fog for spectators or after the player died.

import { UnitType } from "../core/game/Game";
import { FALLOUT_BIT, OWNER_MASK } from "./render/gl/utils/TileCodec";
import type {
  AttackRingInput,
  FrameData,
  NameEntry,
  NukeTelegraphData,
  UnitState,
} from "./render/types";
import type { GameView } from "./view";

const CELL = 4; // vision grid cell size in tiles
const LAND_VISION = 22; // tiles of vision beyond friendly land
const FOG_ALPHA = 150; // 0-255 darkness outside vision

// Vision radius (tiles) of friendly units and structures.
const UNIT_VISION: Record<string, number> = {
  [UnitType.Warship]: 70,
  [UnitType.TransportShip]: 26,
  [UnitType.TradeShip]: 20,
  [UnitType.Train]: 18,
  [UnitType.Port]: 45,
  [UnitType.SAMLauncher]: 75,
  [UnitType.DefensePost]: 45,
  [UnitType.MissileSilo]: 35,
  [UnitType.City]: 35,
  [UnitType.Factory]: 30,
};

// Own nukes: vision around the missile in flight, and around the blast for
// NUKE_REVEAL_TICKS after it detonates (radius by bomb type, in tiles).
const NUKE_FLIGHT_VISION = 30;
const NUKE_REVEAL_TICKS = 60; // 6 s at 10 ticks/s
const NUKE_BLAST_VISION: Record<string, number> = {
  [UnitType.AtomBomb]: 45,
  [UnitType.HydrogenBomb]: 110,
  [UnitType.MIRVWarhead]: 30,
};

const NUKES = new Set<string>([
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.MIRVWarhead,
]);

export class FogOfWar {
  /** The running game's fog, for HUD parts (leaderboard, hover info). */
  static current: FogOfWar | null = null;

  private readonly seenPlayers = new Uint8Array(OWNER_MASK + 1);
  private readonly cw: number;
  private readonly ch: number;
  private readonly vis: Uint8Array; // 1 = cell visible this tick
  private readonly prevVis: Uint8Array;
  private readonly dist: Uint16Array;
  private readonly fogTile: Uint16Array; // what the renderer gets
  private readonly fogTrail: Uint16Array;
  private readonly friendly = new Uint8Array(OWNER_MASK + 1);
  private initialized = false;
  private mySmallID = 0;
  private spawnPhase = false;
  // Blasts of the player's own nukes still in view: tile x, y, radius, until tick
  private reveals: { x: number; y: number; r: number; until: number }[] = [];
  private wasActive = false;

  private readonly image: HTMLCanvasElement;
  private readonly soft: HTMLCanvasElement;
  private readonly imageData: ImageData;
  private overlay: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private lastCam = "";
  private imageDirty = true;

  constructor(
    private readonly w: number,
    private readonly h: number,
  ) {
    this.cw = Math.ceil(w / CELL);
    this.ch = Math.ceil(h / CELL);
    const n = this.cw * this.ch;
    this.vis = new Uint8Array(n);
    this.prevVis = new Uint8Array(n);
    this.dist = new Uint16Array(n);
    this.fogTile = new Uint16Array(w * h);
    this.fogTrail = new Uint16Array(w * h);
    this.image = document.createElement("canvas");
    this.image.width = this.cw;
    this.image.height = this.ch;
    this.imageData = new ImageData(this.cw, this.ch);
    this.soft = document.createElement("canvas");
    this.soft.width = this.cw;
    this.soft.height = this.ch;
  }

  /** False when the HUD may show this tile's owner and units. */
  hidesTile(ref: number): boolean {
    return this.wasActive && this.vis[this.cellOf(ref)] !== 1;
  }

  /** False when the leaderboard may list this player. */
  hidesPlayer(smallID: number): boolean {
    return this.wasActive && this.seenPlayers[smallID & OWNER_MASK] !== 1;
  }

  /** True while the fog is shown (drawOverlay draws only then). */
  active(): boolean {
    return this.wasActive;
  }

  private cellOf(ref: number): number {
    const x = ref % this.w;
    const y = (ref / this.w) | 0;
    return ((y / CELL) | 0) * this.cw + ((x / CELL) | 0);
  }

  private visibleXY(x: number, y: number): boolean {
    const cx = (x / CELL) | 0;
    const cy = (y / CELL) | 0;
    if (cx < 0 || cy < 0 || cx >= this.cw || cy >= this.ch) return false;
    return this.vis[cy * this.cw + cx] === 1;
  }

  private shouldFog(gameView: GameView): boolean {
    if (!gameView.config().fogOfWar()) return false;
    const me = gameView.myPlayer();
    if (me === null) return false;
    // In the spawn phase the player has no land yet: still fogged (spawns hidden)
    return gameView.inSpawnPhase() || me.isAlive();
  }

  /** Returns the FrameData the local player is allowed to see. */
  filter(gameView: GameView, frame: FrameData): FrameData {
    if (!this.shouldFog(gameView)) {
      if (!this.wasActive) return frame;
      // Fog just lifted (death, end of game): show the real map again.
      this.wasActive = false;
      this.imageDirty = true;
      return { ...frame, changedTiles: null, structuresDirty: true };
    }
    this.wasActive = true;

    this.updateFriendly(gameView);
    const wasSpawn = this.spawnPhase;
    this.spawnPhase = gameView.inSpawnPhase();
    if (wasSpawn !== this.spawnPhase) this.imageDirty = true;
    this.trackOwnNukeBlasts(frame);
    this.prevVis.set(this.vis);
    this.computeVision(frame);

    const tiles = frame.tileState;
    const trails = frame.trailState;
    const friendly = this.friendly;
    let full = !this.initialized || frame.changedTiles === null;
    const changed: number[] = [];
    let trailMin = frame.trailDirtyRowMin;
    let trailMax = frame.trailDirtyRowMax;
    let flipped = false;

    if (full) {
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        const seen = this.vis[this.cellOf(i)] === 1;
        this.fogTile[i] =
          seen || friendly[t & OWNER_MASK] ? t : t & FALLOUT_BIT;
        this.fogTrail[i] = seen ? trails[i] : 0;
      }
      this.initialized = true;
      flipped = true;
    } else {
      for (const ref of frame.changedTiles!) {
        const t = tiles[ref];
        if (
          (this.vis[this.cellOf(ref)] === 1 || friendly[t & OWNER_MASK]) &&
          this.fogTile[ref] !== t
        ) {
          this.fogTile[ref] = t;
          changed.push(ref);
        }
      }
      // Cells that came into or went out of vision.
      for (let c = 0; c < this.vis.length; c++) {
        if (this.vis[c] === this.prevVis[c]) continue;
        flipped = true;
        const nowSeen = this.vis[c] === 1;
        const cx = (c % this.cw) * CELL;
        const cy = ((c / this.cw) | 0) * CELL;
        const x1 = Math.min(cx + CELL, this.w);
        const y1 = Math.min(cy + CELL, this.h);
        for (let y = cy; y < y1; y++) {
          for (let x = cx; x < x1; x++) {
            const i = y * this.w + x;
            if (nowSeen && this.fogTile[i] !== tiles[i]) {
              this.fogTile[i] = tiles[i];
              changed.push(i);
            }
            this.fogTrail[i] = nowSeen ? trails[i] : 0;
          }
        }
        if (trailMax < trailMin) {
          trailMin = cy;
          trailMax = y1 - 1;
        } else {
          trailMin = Math.min(trailMin, cy);
          trailMax = Math.max(trailMax, y1 - 1);
        }
      }
      // Trail rows the game changed this tick: copy only what is in vision.
      if (frame.trailDirtyRowMax >= frame.trailDirtyRowMin) {
        for (
          let y = Math.max(0, frame.trailDirtyRowMin);
          y <= Math.min(this.h - 1, frame.trailDirtyRowMax);
          y++
        ) {
          const row = ((y / CELL) | 0) * this.cw;
          for (let x = 0; x < this.w; x++) {
            const i = y * this.w + x;
            this.fogTrail[i] =
              this.vis[row + ((x / CELL) | 0)] === 1 ? trails[i] : 0;
          }
        }
      }
    }
    if (flipped) this.imageDirty = true;

    // Units: friendly ones always, others only inside vision.
    const units = new Map<number, UnitState>();
    let enemyNukeSeen = false;
    for (const [id, u] of frame.units) {
      if (
        friendly[u.ownerID & OWNER_MASK] ||
        this.vis[this.cellOf(u.pos)] === 1
      ) {
        units.set(id, u);
        if (NUKES.has(u.unitType) && !friendly[u.ownerID & OWNER_MASK]) {
          enemyNukeSeen = true;
        }
      }
    }

    const deadUnits = frame.events.deadUnits.filter(
      (d) =>
        friendly[d.ownerSmallID & OWNER_MASK] ||
        (NUKES.has(d.unitType) && d.reachedTarget) ||
        this.vis[this.cellOf(d.pos)] === 1,
    );
    const conquestEvents = frame.events.conquestEvents.filter((e) =>
      this.visibleXY(e.x, e.y),
    );
    const bonusEvents = frame.events.bonusEvents.filter(
      (e) =>
        friendly[e.smallID & OWNER_MASK] ||
        this.vis[this.cellOf(e.tile)] === 1,
    );
    const attackRings: AttackRingInput[] = frame.attackRings.filter((r) =>
      this.visibleXY(r.x, r.y),
    );
    const nukeTelegraphs: NukeTelegraphData[] = frame.nukeTelegraphs.filter(
      (t) => t.relation !== 2 || enemyNukeSeen,
    );

    const names = new Map<string, NameEntry>();
    for (const [key, n] of frame.names) {
      let small = 0;
      try {
        small = gameView.player(n.playerID).smallID();
      } catch {
        // player not known yet: treat as not friendly
      }
      if (friendly[small] || this.visibleXY(n.x, n.y)) names.set(key, n);
    }

    return {
      ...frame,
      tileState: this.fogTile,
      trailState: this.fogTrail,
      changedTiles: full ? null : changed,
      trailDirtyRowMin: trailMin,
      trailDirtyRowMax: trailMax,
      units,
      structuresDirty: frame.structuresDirty || flipped,
      events: { ...frame.events, deadUnits, conquestEvents, bonusEvents },
      attackRings,
      nukeTelegraphs,
      names,
    };
  }

  // Detonations of the player's own nukes this tick start a reveal; old ones expire.
  private trackOwnNukeBlasts(frame: FrameData): void {
    const tick = frame.tick;
    this.reveals = this.reveals.filter((b) => b.until > tick);
    for (const d of frame.events.deadUnits) {
      if ((d.ownerSmallID & OWNER_MASK) !== this.mySmallID) continue;
      if (!d.reachedTarget) continue;
      const r = NUKE_BLAST_VISION[d.unitType];
      if (r === undefined) continue;
      this.reveals.push({
        x: d.pos % this.w,
        y: (d.pos / this.w) | 0,
        r,
        until: tick + NUKE_REVEAL_TICKS,
      });
    }
  }

  private updateFriendly(gameView: GameView): void {
    this.friendly.fill(0);
    const me = gameView.myPlayer();
    if (me === null) return;
    this.mySmallID = me.smallID();
    this.friendly[me.smallID()] = 1;
    for (const p of gameView.playerViews()) {
      if (p !== me && me.isFriendly(p)) this.friendly[p.smallID()] = 1;
    }
  }

  // Chamfer distance (3/4 weights, in cells) from friendly land, then
  // circles around friendly units.
  private computeVision(frame: FrameData): void {
    const { cw, ch, w, h, dist, friendly } = this;
    const INF = 0xffff;
    dist.fill(INF);
    const tiles = frame.tileState;
    for (let y = 0; y < h; y++) {
      const rowCell = ((y / CELL) | 0) * cw;
      const rowTile = y * w;
      for (let x = 0; x < w; x++) {
        if (friendly[tiles[rowTile + x] & OWNER_MASK]) {
          dist[rowCell + ((x / CELL) | 0)] = 0;
        }
      }
    }
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = y * cw + x;
        let d = dist[i];
        if (d === 0) continue;
        if (x > 0) d = Math.min(d, dist[i - 1] + 3);
        if (y > 0) {
          d = Math.min(d, dist[i - cw] + 3);
          if (x > 0) d = Math.min(d, dist[i - cw - 1] + 4);
          if (x < cw - 1) d = Math.min(d, dist[i - cw + 1] + 4);
        }
        dist[i] = d;
      }
    }
    for (let y = ch - 1; y >= 0; y--) {
      for (let x = cw - 1; x >= 0; x--) {
        const i = y * cw + x;
        let d = dist[i];
        if (d === 0) continue;
        if (x < cw - 1) d = Math.min(d, dist[i + 1] + 3);
        if (y < ch - 1) {
          d = Math.min(d, dist[i + cw] + 3);
          if (x < cw - 1) d = Math.min(d, dist[i + cw + 1] + 4);
          if (x > 0) d = Math.min(d, dist[i + cw - 1] + 4);
        }
        dist[i] = d;
      }
    }
    const limit = Math.round((LAND_VISION / CELL) * 3);
    if (this.spawnPhase) {
      // Picking a spawn: no vision at all, so no other player shows anywhere
      // (own land is always shown, see filter()).
      this.vis.fill(0);
      this.seenPlayers.fill(0);
      this.seenPlayers.set(friendly);
      return;
    }
    for (let i = 0; i < dist.length; i++) this.vis[i] = dist[i] <= limit ? 1 : 0;

    // Own nukes: the missile in flight and its recent blasts.
    for (const u of frame.units.values()) {
      if ((u.ownerID & OWNER_MASK) !== this.mySmallID) continue;
      if (NUKES.has(u.unitType)) {
        this.stamp(u.pos % w, (u.pos / w) | 0, NUKE_FLIGHT_VISION);
      }
    }
    for (const b of this.reveals) this.stamp(b.x, b.y, b.r);

    for (const u of frame.units.values()) {
      if (!friendly[u.ownerID & OWNER_MASK]) continue;
      const r = UNIT_VISION[u.unitType];
      if (r === undefined) continue;
      this.stamp(u.pos % w, (u.pos / w) | 0, r);
    }

    // Players with any land in vision (for the leaderboard).
    const seen = this.seenPlayers;
    seen.set(friendly);
    for (let y = 0; y < h; y++) {
      const rowCell = ((y / CELL) | 0) * cw;
      const rowTile = y * w;
      for (let x = 0; x < w; x++) {
        const o = tiles[rowTile + x] & OWNER_MASK;
        if (o !== 0 && this.vis[rowCell + ((x / CELL) | 0)] === 1) seen[o] = 1;
      }
    }
  }

  private stamp(tx: number, ty: number, radius: number): void {
    const { cw, ch } = this;
    const cx = tx / CELL;
    const cy = ty / CELL;
    const r = radius / CELL;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(cw - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(ch - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy <= r2) this.vis[y * cw + x] = 1;
      }
    }
  }

  /**
   * Draws the dark fog over the map. `centerX/centerY` = world tile at the
   * middle of the canvas, `scale` = CSS pixels per tile (the camera the
   * WebGL view uses this frame).
   */
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
      this.overlayCtx = c.getContext("2d");
    }
    const ctx = this.overlayCtx!;
    const c = this.overlay;
    const cssW = glCanvas.clientWidth;
    const cssH = glCanvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
      this.lastCam = "";
    }
    if (!this.wasActive) {
      if (this.lastCam !== "off") {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, c.width, c.height);
        this.lastCam = "off";
      }
      return;
    }
    const cam = `${centerX.toFixed(2)},${centerY.toFixed(2)},${scale.toFixed(4)}`;
    if (!this.imageDirty && cam === this.lastCam) return;
    if (this.imageDirty) {
      const px = this.imageData.data;
      for (let i = 0; i < this.vis.length; i++) {
        px[i * 4 + 3] = this.spawnPhase || this.vis[i] === 1 ? 0 : FOG_ALPHA;
      }
      this.image.getContext("2d")!.putImageData(this.imageData, 0, 0);
      // Blur the cell grid a little so the fog edge is soft, not blocky.
      const sctx = this.soft.getContext("2d")!;
      sctx.clearRect(0, 0, this.cw, this.ch);
      sctx.filter = "blur(1.2px)";
      sctx.drawImage(this.image, 0, 0);
      sctx.filter = "none";
      this.imageDirty = false;
    }
    this.lastCam = cam;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const s = scale * dpr;
    ctx.setTransform(
      s,
      0,
      0,
      s,
      (cssW / 2) * dpr - centerX * s,
      (cssH / 2) * dpr - centerY * s,
    );
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.soft, 0, 0, this.cw * CELL, this.ch * CELL);
  }
}
