// TeamStats maps (Bembe 2026-11-18): public maps of the teamstats.pro Map Gallery, offered in the
// map picker's "TeamStats maps" section.
//
// A TeamStats map travels in GameConfig.gameMap as "tsp:<gallery id>:<version>" instead of a
// GameMapType value. The version grows on every edit of the map in the gallery, so one value always
// means the same terrain (games and replays stay deterministic). Its files come from the game's
// own front (teamstats/front.cjs), which fetches them once from teamstats.pro
// (/api/play/maps/<id>/<v>/<file>, built by JR-WEBPAGE play-maps.js) and keeps a copy:
//   /api/tsp/maps                      list of the public maps
//   /api/tsp/maps/<id>/<v>/<file>      manifest.json, map.bin, map4x.bin, map16x.bin, thumbnail.webp
import { GameMapType } from "./Maps.gen";

export const TSP_MAP_RE = /^tsp:([A-Za-z0-9_-]{4,20}):(\d{1,9})$/;

export interface TspMapInfo {
  id: string;
  v: number;
  name: string;
  description?: string;
  owner?: string;
  type?: string;
  w: number;
  h: number;
  nations: number;
  rating: number;
  ratings: number;
}

export function isTspMap(map: unknown): boolean {
  return typeof map === "string" && TSP_MAP_RE.test(map);
}

export function parseTspMap(map: string): { id: string; v: number } | null {
  const m = TSP_MAP_RE.exec(map);
  return m ? { id: m[1], v: Number(m[2]) } : null;
}

/** The gameMap value of a TeamStats map (not a GameMapType member, but carried as one). */
export function tspMapValue(id: string, v: number): GameMapType {
  return `tsp:${id}:${v}` as GameMapType;
}

/**
 * URL of one file of a TeamStats map (served by the game's front, same origin). Absolute in the
 * browser: the game worker runs from a blob: URL, where a bare path cannot be fetched.
 */
export function tspMapFileUrl(map: string, file: string): string {
  const p = parseTspMap(map);
  if (!p) throw new Error(`Not a TeamStats map: ${map}`);
  const path = `/api/tsp/maps/${p.id}/${p.v}/${file}`;
  const origin = (globalThis as { location?: { origin?: string } }).location
    ?.origin;
  return origin && origin !== "null" ? origin + path : path;
}

// Names and details of the maps the front listed, for labels anywhere in the client.
const known = new Map<string, TspMapInfo>();

export function rememberTspMaps(items: TspMapInfo[]): void {
  for (const it of items) known.set(tspMapValue(it.id, it.v), it);
}

export function tspMapInfo(map: string): TspMapInfo | undefined {
  return known.get(map);
}

export function tspMapName(map: string): string {
  return known.get(map)?.name ?? "TeamStats map";
}
