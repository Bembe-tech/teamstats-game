// Loads the TeamStats maps (public maps of the teamstats.pro Map Gallery) from the game's front
// for the map picker, and remembers their names for labels (core/game/TspMaps.ts).
import { rememberTspMaps, TspMapInfo } from "../core/game/TspMaps";

export interface TspMapList {
  items: TspMapInfo[];
  /** teamstats.pro Map Gallery and Map Creator pages, when the front knows the site. */
  gallery: string | null;
  creator: string | null;
}

const EMPTY: TspMapList = { items: [], gallery: null, creator: null };
let cached: { at: number; list: Promise<TspMapList> } | null = null;

export function loadTspMaps(): Promise<TspMapList> {
  if (cached && Date.now() - cached.at < 2 * 60 * 1000) return cached.list;
  const list = fetch("/api/tsp/maps", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : EMPTY))
    .then((d): TspMapList => {
      const items: TspMapInfo[] = Array.isArray(d?.items) ? d.items : [];
      rememberTspMaps(items);
      return {
        items,
        gallery: typeof d?.gallery === "string" ? d.gallery : null,
        creator: typeof d?.creator === "string" ? d.creator : null,
      };
    })
    .catch(() => EMPTY);
  cached = { at: Date.now(), list };
  return list;
}

// Names show up in lobby lists and the game too, so fetch once at start.
void loadTspMaps();
