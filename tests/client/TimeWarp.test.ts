// TeamStats.Pro "OpenFront 4D", client half: the past view replays what the
// player was shown, the forecast predicts land fronts and boat landings.
import { TimeWarp } from "../../src/client/TimeWarp";

const W = 100;
const H = 100;
const ME = 1;
const ENEMY = 3;
const ref = (x: number, y: number) => y * W + x;

function frame(tick: number, tiles: Uint16Array, changed: number[] | null) {
  return {
    tick,
    inSpawnPhase: false,
    tileState: tiles,
    trailState: new Uint16Array(W * H),
    railroadState: new Uint8Array(W * H),
    units: new Map(),
    players: new Map(),
    names: new Map(),
    events: { deadUnits: [], conquestEvents: [], bonusEvents: [] },
    changedTiles: changed,
    railroadDirty: false,
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

function view(incoming: object[] = []) {
  const me = {
    smallID: () => ME,
    isAlive: () => true,
    isFriendly: () => false,
    outgoingAttacks: () => [],
    incomingAttacks: () => incoming,
  };
  return {
    myPlayer: () => me,
    inSpawnPhase: () => false,
    playerBySmallID: (id: number) => ({ isPlayer: () => id !== 0 }),
    motionPlans: () => new Map(),
    isLand: () => true,
  } as never;
}

// My land: the left half. Each tick the enemy takes one more column of it,
// from the right edge of my land inwards (column 49, 48, ...).
function run(warp: TimeWarp, ticks: number, gv = view()) {
  const tiles = new Uint16Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) tiles[ref(x, y)] = x < 50 ? ME : ENEMY;
  let last = warp.filter(gv, frame(0, tiles, null)) as {
    tileState: Uint16Array;
  };
  for (let t = 1; t <= ticks; t++) {
    const col = 50 - t;
    const changed: number[] = [];
    for (let y = 0; y < H; y++) {
      tiles[ref(col, y)] = ENEMY;
      changed.push(ref(col, y));
    }
    last = warp.filter(gv, frame(t, tiles, changed)) as never;
  }
  return { tiles, last };
}

describe("TimeWarp past view", () => {
  test("live: the frame passes through untouched", () => {
    const warp = new TimeWarp(W, H);
    const { tiles, last } = run(warp, 20);
    expect(last.tileState).toBe(tiles);
  });

  test("looking back shows the map as it was, and keeps the delay", () => {
    const warp = new TimeWarp(W, H);
    const { tiles } = run(warp, 30);
    warp.setPast(1); // 10 ticks back: tick 20, columns 30..49 lost
    const back = warp.filter(view(), frame(30, tiles, [])) as never as {
      tileState: Uint16Array;
      changedTiles: number[] | null;
    };
    expect(back.changedTiles).toBeNull(); // full upload when entering
    expect(back.tileState[ref(30, 5)]).toBe(ENEMY);
    expect(back.tileState[ref(29, 5)]).toBe(ME);
    expect(back.tileState[ref(25, 5)]).toBe(ME);
    // The game goes on: the view follows 10 ticks behind
    const changed: number[] = [];
    for (let y = 0; y < H; y++) {
      tiles[ref(19, y)] = ENEMY;
      changed.push(ref(19, y));
    }
    const next = warp.filter(view(), frame(31, tiles, changed)) as never as {
      tileState: Uint16Array;
      changedTiles: number[];
    };
    expect(next.tileState[ref(29, 5)]).toBe(ENEMY); // tick 21's column
    expect(next.tileState[ref(28, 5)]).toBe(ME);
    expect(next.changedTiles.length).toBe(H);
  });

  test("back to live: one full upload of the real map", () => {
    const warp = new TimeWarp(W, H);
    const { tiles } = run(warp, 30);
    warp.setPast(2);
    warp.filter(view(), frame(30, tiles, []));
    warp.setPast(0);
    const live = warp.filter(view(), frame(31, tiles, [])) as never as {
      tileState: Uint16Array;
      changedTiles: number[] | null;
    };
    expect(live.tileState).toBe(tiles);
    expect(live.changedTiles).toBeNull();
  });

  test("history is capped at 15 s", () => {
    const warp = new TimeWarp(W, H);
    run(warp, 45); // only 45 columns to lose
    expect(warp.availableSeconds()).toBeLessThanOrEqual(15);
    expect(warp.availableSeconds()).toBeGreaterThanOrEqual(4);
  });
});

describe("TimeWarp forecast", () => {
  test("an incoming attack marks the land it takes in the next 10 s", () => {
    const warp = new TimeWarp(W, H);
    const attack = {
      attackerID: ENEMY,
      targetID: ME,
      troops: 100_000,
      id: "a1",
      retreating: false,
    };
    // A column (100 tiles) per tick: more than the 2000 tiles I have left
    run(warp, 30, view([attack]));
    expect(warp.fronts.length).toBe(1);
    expect(warp.fronts[0].incoming).toBe(true);
    expect(warp.fronts[0].tiles).toBe(2000);
    expect(warp.fronts[0].endsInS).toBeNull();
  });

  test("the attack running out of troops shortens the forecast", () => {
    const warp = new TimeWarp(W, H);
    const attack = {
      attackerID: ENEMY,
      targetID: ME,
      troops: 1000,
      id: "a1",
      retreating: false,
    };
    const gv = view([attack]);
    const tiles = new Uint16Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) tiles[ref(x, y)] = x < 50 ? ME : ENEMY;
    warp.filter(gv, frame(0, tiles, null));
    for (let t = 1; t <= 30; t++) {
      const changed: number[] = [];
      for (let y = 0; y < H; y++) {
        tiles[ref(50 - t, y)] = ENEMY;
        changed.push(ref(50 - t, y));
      }
      attack.troops = 1000 - t * 30; // 30 troops a tick: 100 left = 3.3 ticks
      warp.filter(gv, frame(t, tiles, changed));
    }
    expect(warp.fronts.length).toBe(1);
    expect(warp.fronts[0].endsInS).toBe(1);
    expect(warp.fronts[0].tiles).toBe(333); // 100 tiles/tick x 3.33 ticks
  });
});

describe("TimeWarp never stops the game", () => {
  test("an error inside turns the 4D views off and shows the live map", () => {
    const warp = new TimeWarp(W, H);
    const { tiles } = run(warp, 20);
    const bad = {
      ...(view() as object),
      myPlayer: () => {
        throw new Error("boom");
      },
    } as never;
    // tick 25: a forecast tick, the broken view throws inside
    const out = warp.filter(bad, frame(25, tiles, [])) as never as {
      tileState: Uint16Array;
      changedTiles: number[] | null;
    };
    expect(warp.failed).toContain("boom");
    expect(out.tileState).toBe(tiles);
    expect(out.changedTiles).toBeNull(); // one full upload of the live map
    // From now on frames pass through untouched, even when looking back
    warp.setPast(5);
    const f = frame(26, tiles, []);
    expect(warp.filter(view(), f)).toBe(f);
  });

  test("a drawing error does not escape the frame loop", () => {
    const warp = new TimeWarp(W, H);
    const canvas = {
      clientWidth: 100,
      clientHeight: 100,
      style: { filter: "" },
      insertAdjacentElement: () => {
        throw new Error("no canvas");
      },
    } as never;
    expect(() => warp.drawOverlay(canvas, 0, 0, 1)).not.toThrow();
    expect(warp.failed).toContain("no canvas");
  });

  test("a tick with a huge number of changes restarts the history", () => {
    const warp = new TimeWarp(2048, 1100); // 2.25M tiles
    const tiles = new Uint16Array(2048 * 1100);
    warp.filter(view(), frame(0, tiles, null));
    tiles.fill(ME);
    warp.filter(view(), frame(1, tiles, null)); // every tile changed
    expect(warp.failed).toBeNull();
    expect(warp.logEntries()).toBe(0);
    warp.setPast(1);
    const back = warp.filter(view(), frame(2, tiles, [])) as never as {
      tileState: Uint16Array;
    };
    expect(back.tileState[5]).toBe(ME); // history starts at the reset
  });
});
