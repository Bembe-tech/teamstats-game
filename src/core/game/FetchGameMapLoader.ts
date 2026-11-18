import { GameMapType } from "./Game";
import { GameMapLoader, MapData } from "./GameMapLoader";
import { isTspMap, tspMapFileUrl } from "./TspMaps";

export class FetchGameMapLoader implements GameMapLoader {
  private maps: Map<GameMapType, MapData>;

  public constructor(
    private readonly pathResolver: string | ((path: string) => string),
  ) {
    this.maps = new Map<GameMapType, MapData>();
  }

  public getMapData(map: GameMapType): MapData {
    const cachedMap = this.maps.get(map);
    if (cachedMap) {
      return cachedMap;
    }

    const key = Object.keys(GameMapType).find(
      (k) => GameMapType[k as keyof typeof GameMapType] === map,
    );
    const fileName = key?.toLowerCase();
    const tsp = isTspMap(map);

    if (!fileName && !tsp) {
      throw new Error(`Unknown map: ${map}`);
    }
    // TeamStats maps (TspMaps.ts) come from the game's front, not from the bundled assets.
    const url = (path: string) =>
      tsp ? tspMapFileUrl(map, path) : this.url(fileName!, path);

    const mapData = {
      mapBin: () => this.loadBinaryFromUrl(url("map.bin")),
      map4xBin: () => this.loadBinaryFromUrl(url("map4x.bin")),
      map16xBin: () => this.loadBinaryFromUrl(url("map16x.bin")),
      manifest: () => this.loadJsonFromUrl(url("manifest.json")),
      webpPath: url("thumbnail.webp"),
      // Layers ship as .png (older maps) or .webp (newer OpenFront maps).
      layerPng: (layerId: string) =>
        this.loadImageBitmap(url(`${layerId}.png`)).catch(() =>
          this.loadImageBitmap(url(`${layerId}.webp`)),
        ),
    } satisfies MapData;

    this.maps.set(map, mapData);
    return mapData;
  }

  private resolveUrl(path: string): string {
    if (typeof this.pathResolver === "function") {
      return this.pathResolver(path);
    }
    return `${this.pathResolver}/${path}`;
  }

  private url(map: string, path: string) {
    return this.resolveUrl(`${map}/${path}`);
  }

  private async loadBinaryFromUrl(url: string) {
    const startTime = performance.now();
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.statusText}`);
    }

    const data = await response.arrayBuffer();
    console.log(
      `[MapLoader] ${url}: ${(performance.now() - startTime).toFixed(0)}ms`,
    );
    return new Uint8Array(data);
  }

  private async loadJsonFromUrl(url: string) {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.statusText}`);
    }

    return response.json();
  }

  private async loadImageBitmap(url: string): Promise<ImageBitmap> {
    const startTime = performance.now();
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.statusText}`);
    }
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    console.log(
      `[MapLoader] ${url}: ${(performance.now() - startTime).toFixed(0)}ms`,
    );
    return bitmap;
  }
}
