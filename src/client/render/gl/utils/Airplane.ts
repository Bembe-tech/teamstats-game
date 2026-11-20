// TeamStats.Pro "Airports and Planes": airplane silhouettes shared by the
// airport icon (StructurePass) and the flying planes (AirOverlay). All point
// up (-y), are centered on (0,0) and are about 52 units long.

/** Airliner: long wings, tail plane. Used for the airport and cargo planes. */
export function airplanePath(): Path2D {
  const p = new Path2D();
  p.moveTo(0, -26);
  p.quadraticCurveTo(4.5, -22, 4.5, -12);
  p.lineTo(4.5, -6);
  p.lineTo(26, 6);
  p.lineTo(26, 11);
  p.lineTo(4.5, 5);
  p.lineTo(3.5, 16);
  p.lineTo(11, 22);
  p.lineTo(11, 26);
  p.lineTo(0, 23);
  p.lineTo(-11, 26);
  p.lineTo(-11, 22);
  p.lineTo(-3.5, 16);
  p.lineTo(-4.5, 5);
  p.lineTo(-26, 11);
  p.lineTo(-26, 6);
  p.lineTo(-4.5, -6);
  p.lineTo(-4.5, -12);
  p.quadraticCurveTo(-4.5, -22, 0, -26);
  p.closePath();
  return p;
}

/** Transport: wide straight wings, fat body, high tail. */
export function transportPlanePath(): Path2D {
  const p = new Path2D();
  p.moveTo(0, -26);
  p.quadraticCurveTo(6.5, -24, 6.5, -14);
  p.lineTo(6.5, -9);
  p.lineTo(26, -7);
  p.lineTo(26, -1);
  p.lineTo(6.5, 0);
  p.lineTo(5, 15);
  p.lineTo(14, 18);
  p.lineTo(14, 23);
  p.lineTo(0, 22);
  p.lineTo(-14, 23);
  p.lineTo(-14, 18);
  p.lineTo(-5, 15);
  p.lineTo(-6.5, 0);
  p.lineTo(-26, -1);
  p.lineTo(-26, -7);
  p.lineTo(-6.5, -9);
  p.lineTo(-6.5, -14);
  p.quadraticCurveTo(-6.5, -24, 0, -26);
  p.closePath();
  return p;
}

/** Fighter jet: delta wing, pointed nose. */
export function fighterPath(): Path2D {
  const p = new Path2D();
  p.moveTo(0, -26);
  p.lineTo(3.5, -12);
  p.lineTo(4, -2);
  p.lineTo(20, 12);
  p.lineTo(20, 16);
  p.lineTo(5, 12);
  p.lineTo(9, 22);
  p.lineTo(9, 25);
  p.lineTo(0, 22);
  p.lineTo(-9, 25);
  p.lineTo(-9, 22);
  p.lineTo(-5, 12);
  p.lineTo(-20, 16);
  p.lineTo(-20, 12);
  p.lineTo(-4, -2);
  p.lineTo(-3.5, -12);
  p.closePath();
  return p;
}
