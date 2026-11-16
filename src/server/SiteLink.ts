// TeamStats.Pro: which player of a game is which teamstats.pro account, and the finished game sent back to
// the site (Bembe 2026-11-15). teamstats/front.cjs puts the Discord id of a logged-in player on the game
// socket as x-tsp-user (it drops any such header the browser sent); Worker.ts keeps it here by the
// server-made clientID at join. At the end of a game Archive.ts turns the record into a short summary and
// POSTs it to the front on this machine, which signs it and passes it on to the site.
import { base64url } from "jose";
import { decodePatternData } from "../core/PatternDecoder";
import type { GameRecord } from "../core/Schemas";
import { logger } from "./Logger";

const log = logger.child({ component: "SiteLink" });

const byClient = new Map<string, { user: string; at: number }>();
const KEEP_MS = 24 * 3600 * 1000;

export function siteUserHeader(
  v: string | string[] | undefined,
): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && /^\d{5,25}$/.test(s) ? s : null;
}

// The verified tick (Bembe 2026-11-16): logged in with teamstats.pro, whatever name the player
// picked. Nobody may wear the name of another verified player of the same game, though: the
// later one keeps the name but not the tick (Worker.ts passes the names already ticked).
export function siteVerified(
  user: string | string[] | undefined,
  username: string,
  takenVerifiedNames: Iterable<string>,
): boolean {
  if (!siteUserHeader(user)) return false;
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const me = norm(username);
  for (const n of takenVerifiedNames) if (norm(n) === me) return false;
  return true;
}

// The Discord avatar of a logged-in player (x-tsp-avatar, set by front.cjs from its signed cookie).
export function siteAvatar(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" &&
    /^https:\/\/cdn\.discordapp\.com\/[A-Za-z0-9_./?=-]{5,180}$/.test(s)
    ? s
    : null;
}

// Territory patterns from the public Skin Gallery of teamstats.pro (PLAY_SITE/api/skins, only what anyone
// may see there; private skins never show up). The player's pick is "tsp_<gallery id as hex>"; the colours
// come with the skin. Refreshed every 10 minutes.
type GalleryPattern = {
  name: string;
  patternData: string;
  colorPalette: { name: string; primaryColor: string; secondaryColor: string };
};
let gallery: { at: number; byName: Map<string, GalleryPattern> } = {
  at: 0,
  byName: new Map(),
};
let galleryLoading: Promise<void> | null = null;
const galleryName = (id: string) =>
  "tsp_" + Buffer.from(id, "base64url").toString("hex").slice(0, 28);
async function loadGallery() {
  const site = String(
    process.env.SKIN_GALLERY_SITE ??
      process.env.PLAY_SITE ??
      "https://teamstats.pro",
  ).replace(/\/+$/, "");
  if (site === "off") return;
  try {
    const r = await fetch(`${site}/api/skins`, {
      headers: {
        "User-Agent": "TeamStatsPro-Game/1.0 (+https://teamstats.pro/play)",
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(String(r.status));
    const d = (await r.json()) as {
      items?: {
        id: string;
        code?: string;
        primary?: string;
        secondary?: string;
        private?: boolean;
      }[];
    };
    const byName = new Map<string, GalleryPattern>();
    for (const s of d.items ?? []) {
      if (s.private || !s.code || !/^[A-Za-z0-9_-]{4,20}$/.test(s.id)) continue;
      try {
        decodePatternData(s.code, base64url.decode);
      } catch {
        continue;
      }
      const name = galleryName(s.id);
      byName.set(name, {
        name,
        patternData: s.code,
        colorPalette: {
          name,
          primaryColor: s.primary ?? "#ffffff",
          secondaryColor: s.secondary ?? "#000000",
        },
      });
    }
    gallery = { at: Date.now(), byName };
  } catch (e) {
    log.warn(`cannot load the skin gallery: ${e}`);
    gallery.at = Date.now() - 9 * 60 * 1000; // try again in a minute
  }
}
export async function galleryPattern(
  name: string | undefined,
): Promise<GalleryPattern | null> {
  if (!name || !/^tsp_[0-9a-f]{4,28}$/.test(name)) return null;
  if (Date.now() - gallery.at > 10 * 60 * 1000 || !gallery.byName.has(name)) {
    if (Date.now() - gallery.at > 60 * 1000 || gallery.at === 0) {
      galleryLoading ??= loadGallery().finally(() => (galleryLoading = null));
      await galleryLoading;
    }
  }
  return gallery.byName.get(name) ?? null;
}

export function rememberSiteUser(clientID: string, user: string | null) {
  if (!user) return;
  byClient.set(clientID, { user, at: Date.now() });
  if (byClient.size > 5000) {
    const cutoff = Date.now() - KEEP_MS;
    for (const [k, v] of byClient) if (v.at < cutoff) byClient.delete(k);
  }
}

function count(v: unknown): number {
  if (Array.isArray(v)) return v.reduce((a: number, x) => a + count(x), 0);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function siteSummary(record: GameRecord) {
  const winner = record.info.winner;
  const winners = new Set<string>(winner ? (winner.slice(2) as string[]) : []);
  if (winner && winner[0] === "player") winners.add(String(winner[1]));
  const cfg = record.info.config;
  const players = record.info.players.map((p) => {
    const st = (p.stats ?? {}) as Record<string, unknown>;
    return {
      clientID: p.clientID,
      username: p.username,
      clanTag: p.clanTag ?? null,
      siteUser: byClient.get(p.clientID)?.user ?? null,
      won: winners.has(p.clientID),
      eliminated: st.killedAt !== undefined,
      place: st.deathPosition ?? null,
      kills: Array.isArray(st.kills) ? st.kills.length : 0,
      conquests: count(st.conquests),
      tiles: st.finalTiles !== undefined ? Number(st.finalTiles) : null,
    };
  });
  return {
    gameID: record.info.gameID,
    start: record.info.start,
    end: record.info.end,
    map: String(cfg.gameMap),
    mode: String(cfg.gameMode),
    teams: cfg.playerTeams === undefined ? null : String(cfg.playerTeams),
    fog: cfg.fogOfWar === true,
    winner: winner
      ? {
          type: String(winner[0]),
          name:
            winner[0] === "player"
              ? (players.find((p) => p.clientID === winner[1])?.username ?? "")
              : String(winner[1]),
        }
      : null,
    players,
  };
}

export async function sendToSite(record: GameRecord) {
  const port = Number(process.env.TSP_FRONT_PORT ?? 0);
  const key = process.env.API_KEY ?? "";
  if (!port || !key) return;
  const summary = siteSummary(record);
  if (!summary.players.some((p) => p.siteUser)) return;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/internal/game-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tsp-internal": key },
      body: JSON.stringify(summary),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) log.warn(`front refused the game result: ${r.status}`);
  } catch (e) {
    log.warn(`cannot hand the game result to the front: ${e}`);
  }
}
