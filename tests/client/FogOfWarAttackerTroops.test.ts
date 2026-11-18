import { describe, expect, it } from "vitest";
import { FogOfWar } from "../../src/client/FogOfWar";

if (typeof (globalThis as any).ImageData === "undefined") {
  (globalThis as any).ImageData = class {
    data: Uint8ClampedArray;
    constructor(
      public width: number,
      public height: number,
    ) {
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
}

function fakeGame(attackerIDs: number[]) {
  const me: any = {
    smallID: () => 1,
    isFriendly: (p: any) => p.smallID() === 2,
    incomingAttacks: () => attackerIDs.map((id) => ({ attackerID: id })),
  };
  const ally = { smallID: () => 2 };
  const enemy = { smallID: () => 3 };
  const other = { smallID: () => 4 };
  return {
    myPlayer: () => me,
    playerViews: () => [me, ally, enemy, other],
  } as any;
}

describe("Fog of War: troops of a player attacking you", () => {
  it("shows only the attacker's troops, other stats stay hidden", () => {
    const fog = new FogOfWar(16, 16) as any;
    fog.wasActive = true;
    fog.updateFriendly(fakeGame([3]));
    expect(fog.hidesStatsOf(3)).toBe(true);
    expect(fog.showsTroopsOf(3)).toBe(true);
    expect(fog.showsTroopsOf(4)).toBe(false);
    expect(fog.showsTroopsOf(2)).toBe(true);
  });

  it("hides the troops again once the attack is over", () => {
    const fog = new FogOfWar(16, 16) as any;
    fog.wasActive = true;
    fog.updateFriendly(fakeGame([3]));
    fog.updateFriendly(fakeGame([]));
    expect(fog.showsTroopsOf(3)).toBe(false);
  });
});
