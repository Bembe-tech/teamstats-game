// TeamStats.Pro Fog of War: hidden spawns, and the player's own nukes
// revealing their flight and blast for a few seconds (not allies' nukes).
import { FogOfWar } from "../../src/client/FogOfWar";

const W = 200;
const H = 200;
const ME = 1;
const ALLY = 2;
const ENEMY = 3;

function view(spawnPhase: boolean) {
  const me = {
    smallID: () => ME,
    isAlive: () => true,
    isFriendly: (p: { smallID(): number }) => p.smallID() === ALLY,
  };
  const ally = { smallID: () => ALLY };
  const enemy = { smallID: () => ENEMY };
  return {
    config: () => ({ fogOfWar: () => true }),
    inSpawnPhase: () => spawnPhase,
    myPlayer: () => me,
    playerViews: () => [me, ally, enemy],
    player: () => ({ smallID: () => ENEMY }),
  } as never;
}

function frame(
  tick: number,
  tiles: Uint16Array,
  units: object[] = [],
  deadUnits: object[] = [],
  rails: Uint8Array = new Uint8Array(W * H),
  railroadDirty = false,
) {
  return {
    tick,
    inSpawnPhase: false,
    tileState: tiles,
    trailState: new Uint16Array(W * H),
    railroadState: rails,
    units: new Map(units.map((u, i) => [i + 1, u])),
    players: new Map(),
    names: new Map(),
    events: { deadUnits, conquestEvents: [], bonusEvents: [] },
    changedTiles: null,
    railroadDirty,
    revealedRailTiles: [],
    trailDirtyRowMin: 1,
    trailDirtyRowMax: 0,
    spiralRibbons: [],
    playerStatus: new Map(),
    relationMatrix: new Uint8Array(0),
    relationSize: 0,
    relationsDirty: false,
    allianceClusters: new Map(),
    nukeTelegraphs: [],
    attackRings: [],
    structuresDirty: false,
  } as never;
}

const ref = (x: number, y: number) => y * W + x;

// My land in the top-left corner, an enemy far away at (150, 150).
function world(): Uint16Array {
  const t = new Uint16Array(W * H);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) t[ref(x, y)] = ME;
  t[ref(150, 150)] = ENEMY;
  return t;
}

describe("Fog of War", () => {
  test("spawn phase: other players are hidden, own land shows", () => {
    const fog = new FogOfWar(W, H);
    const tiles = world();
    tiles[ref(12, 12)] = ENEMY; // right next to me
    const out = fog.filter(view(true), frame(1, tiles)) as unknown as {
      tileState: Uint16Array;
    };
    expect(out.tileState[ref(1, 1)]).toBe(ME);
    expect(out.tileState[ref(12, 12)]).toBe(0);
    expect(out.tileState[ref(150, 150)]).toBe(0);
    expect(fog.hidesPlayer(ENEMY)).toBe(true);
  });

  test("own nuke in flight reveals the land under it, an ally's does not", () => {
    const fog = new FogOfWar(W, H);
    const tiles = world();
    fog.filter(view(false), frame(1, tiles));
    expect(fog.hidesTile(ref(150, 150))).toBe(true);
    fog.filter(
      view(false),
      frame(2, tiles, [
        { unitType: "Atom Bomb", ownerID: ALLY, pos: ref(150, 150) },
      ]),
    );
    expect(fog.hidesTile(ref(150, 150))).toBe(true);
    fog.filter(
      view(false),
      frame(3, tiles, [
        { unitType: "Atom Bomb", ownerID: ME, pos: ref(150, 150) },
      ]),
    );
    expect(fog.hidesTile(ref(150, 150))).toBe(false);
  });

  test("the blast stays visible for a few seconds, then the fog comes back", () => {
    const fog = new FogOfWar(W, H);
    const tiles = world();
    fog.filter(view(false), frame(1, tiles));
    const boom = {
      unitType: "Atom Bomb",
      pos: ref(150, 150),
      reachedTarget: true,
      ownerSmallID: ME,
    };
    fog.filter(view(false), frame(10, tiles, [], [boom]));
    expect(fog.hidesTile(ref(150, 150))).toBe(false);
    fog.filter(view(false), frame(65, tiles));
    expect(fog.hidesTile(ref(150, 150))).toBe(false);
    fog.filter(view(false), frame(71, tiles));
    expect(fog.hidesTile(ref(150, 150))).toBe(true);
  });

  test("railroads in the fog stay hidden, those in view show", () => {
    const fog = new FogOfWar(W, H);
    const tiles = world();
    const rails = new Uint8Array(W * H);
    fog.filter(view(false), frame(1, tiles, [], [], rails));
    rails[ref(150, 150)] = 1; // enemy rail far away
    rails[ref(5, 12)] = 1; // rail next to my land
    const out = fog.filter(
      view(false),
      frame(2, tiles, [], [], rails, true),
    ) as unknown as { railroadState: Uint8Array; railroadDirty: boolean };
    expect(out.railroadDirty).toBe(true);
    expect(out.railroadState[ref(5, 12)]).toBe(1);
    expect(out.railroadState[ref(150, 150)]).toBe(0);
  });

  test("enemy numbers are hidden, an ally's are not", () => {
    const fog = new FogOfWar(W, H);
    fog.filter(view(false), frame(1, world()));
    expect(fog.hidesStatsOf(ENEMY)).toBe(true);
    expect(fog.hidesStatsOf(ALLY)).toBe(false);
    expect(fog.hidesStatsOf(ME)).toBe(false);
  });

  test("my boat shows where it will land", () => {
    const fog = new FogOfWar(W, H);
    const tiles = world();
    fog.filter(view(false), frame(1, tiles));
    expect(fog.hidesTile(ref(150, 150))).toBe(true);
    fog.filter(
      view(false),
      frame(2, tiles, [
        {
          unitType: "Transport",
          ownerID: ME,
          pos: ref(15, 15),
          targetTile: ref(150, 150),
        },
      ]),
    );
    expect(fog.hidesTile(ref(150, 150))).toBe(false);
  });
});
