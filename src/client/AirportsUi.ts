// TeamStats.Pro "Airports and Planes": names and icons in the build menu and
// the radial menu. The menus are module-level tables shared by every game of
// the page, so this swaps the entries in for a game with the mode on and puts
// the normal ones back for any other game.
import { assetUrl } from "../core/AssetUrls";
import { UnitType } from "../core/game/Game";
import { flattenedBuildTable } from "./hud/layers/BuildMenu";
import { boatMenuElement } from "./hud/layers/RadialMenuElements";

const airportIcon = assetUrl("images/AirplaneIconWhite.svg");
const fighterIcon = assetUrl("images/FighterIconWhite.svg");
const troopPlaneIcon = assetUrl("images/TroopPlaneIconWhite.svg");

const AIR: Partial<
  Record<UnitType, { icon: string; key: string; description: string }>
> = {
  [UnitType.Port]: {
    icon: airportIcon,
    key: "unit_type.airport",
    description: "build_menu.desc.airport",
  },
  [UnitType.Warship]: {
    icon: fighterIcon,
    key: "unit_type.fighter",
    description: "build_menu.desc.fighter",
  },
};

let saved: Map<
  object,
  { icon: string; key?: string; description?: string }
> | null = null;
let savedBoatIcon: string | null = null;

export function applyAirportsUi(on: boolean): void {
  if (saved === null) {
    saved = new Map();
    for (const item of flattenedBuildTable) {
      saved.set(item, {
        icon: item.icon,
        key: item.key,
        description: item.description,
      });
    }
    savedBoatIcon = boatMenuElement.icon ?? null;
  }
  for (const item of flattenedBuildTable) {
    const orig = saved.get(item)!;
    const air = on ? AIR[item.unitType] : undefined;
    item.icon = air?.icon ?? orig.icon;
    item.key = air?.key ?? orig.key;
    item.description = air?.description ?? orig.description;
  }
  if (savedBoatIcon !== null) {
    boatMenuElement.icon = on ? troopPlaneIcon : savedBoatIcon;
  }
}
