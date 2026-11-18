import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { assetUrl } from "../../../core/AssetUrls";
import {
  Difficulty,
  GameMapType,
  MapCategory,
  mapCategoryOrder,
  MapInfo,
  maps,
} from "../../../core/game/Game";
import {
  TspMapInfo,
  tspMapName,
  tspMapValue,
} from "../../../core/game/TspMaps";
import { loadTspMaps, TspMapList } from "../../TspMapsClient";
import { translateText } from "../../Utils";
import "./MapDisplay";
import { getFavoriteMaps, starIcon, toggleFavoriteMap } from "./MapFavorites";
const randomMap = assetUrl("images/RandomMap.webp");

type MapTab = "featured" | "all" | "favorites";

// Featured grid order: ranked maps first (1 = first), unranked alphabetical.
const featuredMaps: MapInfo[] = maps
  .filter((m) => m.categories.includes("featured"))
  .sort(
    (a, b) =>
      (a.featuredRank ?? Number.MAX_SAFE_INTEGER) -
      (b.featuredRank ?? Number.MAX_SAFE_INTEGER),
  );

function mapsInCategory(category: MapCategory): MapInfo[] {
  return maps.filter((m) => m.categories.includes(category));
}

@customElement("map-picker")
export class MapPicker extends LitElement {
  @property({ type: String }) selectedMap: GameMapType = GameMapType.World;
  @property({ type: Boolean }) useRandomMap = false;
  @property({ type: Boolean }) showMedals = false;
  @property({ type: Boolean }) randomMapDivider = false;
  @property({ type: String }) searchQuery = "";
  @property({ attribute: false }) mapWins: Map<GameMapType, Set<Difficulty>> =
    new Map();
  @property({ attribute: false }) onSelectMap?: (map: GameMapType) => void;
  @property({ attribute: false }) onSelectRandom?: () => void;
  // TeamStats.Pro: open on "All" (every map by category), not "Featured"
  @state() private activeTab: MapTab = "all";
  // TeamStats.Pro: every category open, so all maps show at once
  @state() private expandedCategories: Set<string> = new Set(
    mapCategoryOrder.filter((categoryKey) => categoryKey !== "featured"),
  );
  @state() private favorites: GameMapType[] = getFavoriteMaps();
  // TeamStats.Pro: public maps of the teamstats.pro Map Gallery (TspMapsClient.ts)
  @state() private tspMaps: TspMapList = {
    items: [],
    gallery: null,
    creator: null,
  };
  @state() private tspLoading = true;
  @state() private tspExpanded = true;

  connectedCallback() {
    super.connectedCallback();
    loadTspMaps().then((list) => {
      this.tspMaps = list;
      this.tspLoading = false;
    });
  }

  createRenderRoot() {
    return this;
  }

  private handleToggleFavorite(mapValue: GameMapType) {
    this.favorites = toggleFavoriteMap(mapValue);
  }

  private handleMapSelection(mapValue: GameMapType) {
    this.onSelectMap?.(mapValue);
  }

  private handleSelectRandomMap = () => {
    this.onSelectRandom?.();
  };

  private toggleCategory(categoryKey: string) {
    const expanded = new Set(this.expandedCategories);
    if (expanded.has(categoryKey)) {
      expanded.delete(categoryKey);
    } else {
      expanded.add(categoryKey);
    }
    this.expandedCategories = expanded;
  }

  private get allCategories(): MapCategory[] {
    return mapCategoryOrder.filter((categoryKey) => categoryKey !== "featured");
  }

  private toggleExpandAll() {
    this.expandedCategories =
      this.expandedCategories.size > 0
        ? new Set()
        : new Set(this.allCategories);
  }

  private preventImageDrag(event: DragEvent) {
    event.preventDefault();
  }

  private get filteredTspMaps(): TspMapInfo[] {
    const query = this.searchQuery.trim().toLowerCase();
    if (!query) return [];
    return this.tspMaps.items.filter(
      (m) =>
        m.name.toLowerCase().includes(query) ||
        (m.owner ?? "").toLowerCase().includes(query),
    );
  }

  private renderTspCard(info: TspMapInfo) {
    const value = tspMapValue(info.id, info.v);
    const by = info.owner ? ` by ${info.owner}` : "";
    const stars =
      info.ratings > 0 ? ` · ${info.rating.toFixed(1)}★ (${info.ratings})` : "";
    return html`
      <div
        @click=${() => this.handleMapSelection(value)}
        class="cursor-pointer"
        title="${tspMapName(value)}${by} · ${info.w}×${info.h}${stars}"
      >
        <map-display
          .mapKey=${value}
          .selected=${!this.useRandomMap && this.selectedMap === value}
          .translation=${info.name}
        ></map-display>
      </div>
    `;
  }

  private renderTspGrid(list: TspMapInfo[]) {
    return html`<div
      class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
    >
      ${repeat(
        list,
        (m) => `${m.id}:${m.v}`,
        (m) => this.renderTspCard(m),
      )}
    </div>`;
  }

  private renderTspLinks() {
    const { gallery, creator } = this.tspMaps;
    if (!gallery && !creator) return null;
    return html`<div
      class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/50 mb-3 pl-2"
    >
      ${gallery
        ? html`<a
            href=${gallery}
            target="_blank"
            rel="noopener"
            class="underline hover:text-white"
            >Map Gallery on teamstats.pro</a
          >`
        : null}
      ${creator
        ? html`<a
            href=${creator}
            target="_blank"
            rel="noopener"
            class="underline hover:text-white"
            >Make your own map (Map Creator)</a
          >`
        : null}
    </div>`;
  }

  // "TeamStats maps": the first group of the All tab.
  private renderTspSection() {
    const list = this.tspMaps.items;
    const expanded = this.tspExpanded;
    return html`<div class="w-full">
      <button
        type="button"
        aria-expanded=${expanded}
        @click=${() => (this.tspExpanded = !this.tspExpanded)}
        class="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border transition-all duration-200 active:scale-[0.99] ${expanded
          ? "bg-malibu-blue/20 border-malibu-blue/50"
          : "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20"}"
      >
        <span
          class="flex items-center gap-3 text-sm font-bold text-white uppercase tracking-wider"
        >
          <svg
            class="w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${expanded
              ? "rotate-90"
              : ""}"
            viewBox="0 0 12 12"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M4 2l5 4-5 4z" />
          </svg>
          TeamStats maps
        </span>
        <span class="text-xs font-bold text-white/40"
          >${this.tspLoading ? "…" : list.length}</span
        >
      </button>
      ${expanded
        ? html`<div class="mt-4">
            ${this.renderTspLinks()}
            ${this.tspLoading
              ? html`<p class="text-sm text-white/50 pl-2">
                  ${translateText("common.loading")}
                </p>`
              : list.length === 0
                ? html`<p class="text-sm text-white/50 pl-2">
                    No public maps in the teamstats.pro Map Gallery yet.
                  </p>`
                : this.renderTspGrid(list)}
          </div>`
        : null}
    </div>`;
  }

  private get filteredMaps(): MapInfo[] {
    if (!this.searchQuery.trim()) return [];
    const query = this.searchQuery.trim().toLowerCase();
    return maps.filter((m) => {
      const name = translateText(m.translationKey).toLowerCase();
      const id = m.id.toLowerCase();
      return name.includes(query) || id.includes(query);
    });
  }

  private getWins(mapValue: GameMapType): Set<Difficulty> {
    return this.mapWins?.get(mapValue) ?? new Set();
  }

  private renderMapCard(map: MapInfo) {
    return html`
      <div
        @click=${() => this.handleMapSelection(map.type)}
        class="cursor-pointer"
      >
        <map-display
          .mapKey=${map.id}
          .selected=${!this.useRandomMap && this.selectedMap === map.type}
          .showMedals=${this.showMedals}
          .wins=${this.getWins(map.type)}
          .favorite=${this.favorites.includes(map.type)}
          .onToggleFavorite=${() => this.handleToggleFavorite(map.type)}
          .translation=${translateText(map.translationKey)}
        ></map-display>
      </div>
    `;
  }

  private renderMapGrid(mapList: MapInfo[]) {
    // Keyed by map so cards keep their identity when the list shifts
    // (e.g. the selected map gets prepended to the featured grid) —
    // positional reuse would leave stale thumbnails behind.
    return html`<div
      class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
    >
      ${repeat(
        mapList,
        (map) => map.id,
        (map) => this.renderMapCard(map),
      )}
    </div>`;
  }

  private renderSectionHeading(label: string) {
    return html`<h4
      class="text-xs font-bold text-white/40 uppercase tracking-widest mb-4 pl-2"
    >
      ${label}
    </h4>`;
  }

  private renderCategoryBar(categoryKey: MapCategory, mapList: MapInfo[]) {
    const expanded = this.expandedCategories.has(categoryKey);
    return html`<div class="w-full">
      <button
        type="button"
        aria-expanded=${expanded}
        @click=${() => this.toggleCategory(categoryKey)}
        class="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border transition-all duration-200 active:scale-[0.99] ${expanded
          ? "bg-malibu-blue/20 border-malibu-blue/50"
          : "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20"}"
      >
        <span
          class="flex items-center gap-3 text-sm font-bold text-white uppercase tracking-wider"
        >
          <svg
            class="w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${expanded
              ? "rotate-90"
              : ""}"
            viewBox="0 0 12 12"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M4 2l5 4-5 4z" />
          </svg>
          ${translateText(`map_categories.${categoryKey}`)}
        </span>
        <span class="text-xs font-bold text-white/40">${mapList.length}</span>
      </button>
      ${expanded
        ? html`<div class="mt-4">${this.renderMapGrid(mapList)}</div>`
        : null}
    </div>`;
  }

  private renderFeaturedTab() {
    let featuredMapList = featuredMaps;
    const selected = maps.find((m) => m.type === this.selectedMap);
    if (
      !this.useRandomMap &&
      selected !== undefined &&
      !featuredMaps.includes(selected)
    ) {
      featuredMapList = [selected, ...featuredMaps];
    }
    return html`<div class="w-full">
      ${this.renderSectionHeading(translateText("map_categories.featured"))}
      ${this.renderMapGrid(featuredMapList)}
    </div>`;
  }

  private renderAllTab() {
    return html`<div class="space-y-3">
      ${this.renderTspSection()}
      ${this.allCategories.map((categoryKey) =>
        this.renderCategoryBar(categoryKey, mapsInCategory(categoryKey)),
      )}
    </div>`;
  }

  private renderExpandToggle() {
    const anyExpanded = this.expandedCategories.size > 0;
    return html`<div
      class="shrink-0 rounded-xl border border-white/10 bg-black/20 p-1"
    >
      <button
        type="button"
        aria-expanded=${anyExpanded}
        title=${anyExpanded
          ? translateText("common.collapse_all")
          : translateText("common.expand_all")}
        @click=${() => this.toggleExpandAll()}
        class="h-full flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-white/60 hover:text-white transition-all active:scale-95"
      >
        <svg
          class="w-3 h-3 shrink-0 transition-transform duration-200 ${anyExpanded
            ? "rotate-180"
            : ""}"
          viewBox="0 0 12 12"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M2 4l4 5 4-5z" />
        </svg>
        <span class="hidden sm:inline">
          ${anyExpanded
            ? translateText("common.collapse_all")
            : translateText("common.expand_all")}
        </span>
      </button>
    </div>`;
  }

  private renderFavoritesTab() {
    if (this.favorites.length === 0) {
      return html`<div
        class="w-full flex flex-col items-center justify-center gap-3 py-12 px-4 text-center rounded-xl border border-dashed border-white/10 bg-black/20"
      >
        <div class="text-white/30">${starIcon(false, "w-8 h-8")}</div>
        <p class="text-sm text-white/50 leading-relaxed max-w-xs">
          ${translateText("map_component.favorites_empty")}
        </p>
      </div>`;
    }
    const favoriteMaps = this.favorites
      .map((favorite) => maps.find((m) => m.type === favorite))
      .filter((m) => m !== undefined);
    return html`<div class="w-full">
      ${this.renderSectionHeading(translateText("map_categories.favorites"))}
      ${this.renderMapGrid(favoriteMaps)}
    </div>`;
  }

  private renderActiveTab() {
    switch (this.activeTab) {
      case "all":
        return this.renderAllTab();
      case "favorites":
        return this.renderFavoritesTab();
      default:
        return this.renderFeaturedTab();
    }
  }

  private renderSearchResults() {
    const results = this.filteredMaps;
    const tspResults = this.filteredTspMaps;
    if (results.length === 0 && tspResults.length === 0) {
      return html`<div
        class="w-full flex flex-col items-center justify-center gap-3 py-12 px-4 text-center rounded-xl border border-dashed border-white/10 bg-black/20"
      >
        <svg
          class="w-8 h-8 text-white/30"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fill-rule="evenodd"
            d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
            clip-rule="evenodd"
          />
        </svg>
        <p class="text-sm text-white/50 leading-relaxed max-w-xs">
          ${translateText("map_component.no_results")}
        </p>
      </div>`;
    }
    return html`<div class="w-full">
      ${this.renderSectionHeading(
        `${translateText("map_component.search_results")} (${results.length + tspResults.length})`,
      )}
      ${this.renderMapGrid(results)}
      ${tspResults.length > 0
        ? html`<div class="mt-6">
            ${this.renderSectionHeading("TeamStats maps")}
            ${this.renderTspGrid(tspResults)}
          </div>`
        : null}
    </div>`;
  }

  private renderTabButton(tab: MapTab, label: string) {
    const isActive = this.activeTab === tab;
    return html`<button
      type="button"
      role="tab"
      aria-selected=${isActive}
      class="px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all active:scale-95 ${isActive
        ? "bg-malibu-blue/20 text-white shadow-[var(--shadow-malibu-blue-soft)]"
        : "text-white/60 hover:text-white"}"
      @click=${() => (this.activeTab = tab)}
    >
      ${label}
    </button>`;
  }

  render() {
    const isSearching = this.searchQuery.trim().length > 0;
    return html`
      <div class="space-y-8">
        <div class="w-full flex items-center gap-2">
          ${isSearching
            ? null
            : html`<div
                  role="tablist"
                  aria-label="${translateText("map.map")}"
                  class="flex-1 grid grid-cols-3 gap-2 rounded-xl border border-white/10 bg-black/20 p-1"
                >
                  ${this.renderTabButton(
                    "featured",
                    translateText("map.featured"),
                  )}
                  ${this.renderTabButton("all", translateText("map.all"))}
                  ${this.renderTabButton(
                    "favorites",
                    translateText("map.favorites"),
                  )}
                </div>
                ${this.activeTab === "all" ? this.renderExpandToggle() : null}`}
        </div>
        ${isSearching ? this.renderSearchResults() : this.renderActiveTab()}
        <div
          class="w-full ${this.randomMapDivider
            ? "pt-4 border-t border-white/5"
            : ""}"
        >
          ${this.renderSectionHeading(translateText("map_categories.special"))}
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <button
              type="button"
              class="w-full h-full p-3 flex flex-col items-center justify-between rounded-xl border cursor-pointer transition-all duration-200 active:scale-95 gap-3 group ${this
                .useRandomMap
                ? "bg-malibu-blue/20 border-malibu-blue/50 shadow-[var(--shadow-malibu-blue-strong)]"
                : "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20 hover:-translate-y-1"}"
              @click=${this.handleSelectRandomMap}
            >
              <div
                class="w-full aspect-[2/1] relative overflow-hidden rounded-lg bg-black/20"
              >
                <img
                  src=${randomMap}
                  alt=${translateText("map.random")}
                  draggable="false"
                  @dragstart=${this.preventImageDrag}
                  class="w-full h-full object-cover ${this.useRandomMap
                    ? "opacity-100"
                    : "opacity-80"} group-hover:opacity-100 transition-opacity duration-200"
                />
              </div>
              <div
                class="text-xs font-bold text-white uppercase tracking-wider text-center leading-tight break-words hyphens-auto"
              >
                ${translateText("map.random")}
              </div>
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
