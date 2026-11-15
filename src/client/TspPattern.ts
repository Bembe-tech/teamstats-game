// TeamStats.Pro: the territory pattern picked from the teamstats.pro Skin Gallery ("Your Profile").
// Kept under a "settings." key, so it follows the settings: on the account when logged in, in this
// browser otherwise (TspProfile.ts). The value is the gallery pattern's name, "tsp_<hex id>".
export const TSP_PATTERN_KEY = "settings.tspPattern";

export interface TspGallerySkin {
  id: string;
  pattern: string; // "tsp_<hex>", what the game server knows it by
  name: string;
  code: string;
  primary: string;
  secondary: string;
  owner: string;
  rating: number;
  created?: string;
}

export function tspPatternChoice(): string | null {
  try {
    const v = localStorage.getItem(TSP_PATTERN_KEY);
    return v && /^tsp_[0-9a-f]{4,28}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function setTspPatternChoice(pattern: string | null) {
  if (pattern) localStorage.setItem(TSP_PATTERN_KEY, pattern);
  else localStorage.removeItem(TSP_PATTERN_KEY);
}

let skins: Promise<TspGallerySkin[]> | null = null;
export function tspGallerySkins(): Promise<TspGallerySkin[]> {
  skins ??= fetch("/api/tsp/skins")
    .then((r) => (r.ok ? r.json() : { items: [] }))
    .then((d: { items?: TspGallerySkin[] }) => d.items ?? [])
    .catch(() => []);
  return skins;
}

// Draws a pattern code (base64url, OpenFront pattern bytes: see the site's skin-format.js) on a canvas.
export function drawPattern(
  canvas: HTMLCanvasElement,
  code: string,
  primary: string,
  secondary: string,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let bytes: Uint8Array;
  try {
    const b64 = code.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return;
  }
  if (bytes.length < 3) return;
  const w = (((bytes[1] >> 3) & 0x1f) | ((bytes[2] & 0x03) << 5)) + 2;
  const h = ((bytes[2] >> 2) & 0x3f) + 2;
  const cw = canvas.width,
    ch = canvas.height;
  const cell = Math.max(1, Math.floor(Math.min(cw / w, ch / h, 6)));
  for (let y = 0; y * cell < ch; y++)
    for (let x = 0; x * cell < cw; x++) {
      const i = (y % h) * w + (x % w);
      const bit = (bytes[3 + (i >> 3)] >> (i & 7)) & 1;
      ctx.fillStyle = bit ? secondary : primary;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
}
