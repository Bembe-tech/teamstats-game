// TeamStats.Pro "Airports and Planes": fighters (Warship units) fly over
// everything, so a selected fighter may be sent to land as well as water.
// Client-only: the move still goes through the normal move_warship intent,
// the simulation (MoveWarshipExecution) stays the same for every client.

/** Shared between WarshipSelectionController and ClientGameRunner. */
export const fighterClick: {
  // true while at least one own warship / fighter is selected
  selected: boolean;
  // the last mouse-up the selection controller used as a move order
  consumed: object | null;
} = { selected: false, consumed: null };

/** May selected warships be ordered to this tile? */
export function moveTargetAllowed(
  isWater: boolean,
  airports: boolean,
): boolean {
  return isWater || airports;
}

/**
 * A land click that moves selected fighters must not also start an attack
 * or a boat/plane landing on that tile. Works in both handler orders: the
 * controller either already marked this event, or still holds a selection.
 */
export function clickTakenByFighters(
  event: object,
  isWater: boolean,
  airports: boolean,
): boolean {
  if (!airports || isWater) return false;
  return fighterClick.consumed === event || fighterClick.selected;
}
