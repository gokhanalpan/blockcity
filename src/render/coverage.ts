// The area a building reaches, drawn on the ground: a translucent fill in the colour of its kind with
// a stronger border. The area is exactly what the simulation uses: the footprint grown by the radius
// in every direction (a square), clipped to the island.

import * as THREE from "three";
import { MOOD } from "@/config/tuning";
import type { TileDef } from "@/sim/tileDefs";
import { CELL } from "./coords";

export type CoverageKind = "police" | "health" | "school" | "fire" | "fun" | "park" | "parking" | "smoke";

export const COVERAGE_COLOURS: Record<CoverageKind, number> = {
  police: 0x3d7bff,
  health: 0xff4d6d,
  school: 0xffc233,
  fire: 0xff7a1a,
  fun: 0xb05cff,
  park: 0x3fcf5a,
  parking: 0x5ab4ff,
  smoke: 0x8a6a4a,
};

export const COVERAGE_LABELS: Record<CoverageKind, string> = {
  police: "police cover",
  health: "health cover",
  school: "school cover",
  fire: "fire cover",
  fun: "fun nearby",
  park: "park nearby",
  parking: "parking for big venues",
  smoke: "smoke: homes here lose happiness",
};

// What a building reaches, if anything. A service comes first, then parking, greenery, smoke.
export function coverageOf(def: TileDef): { kind: CoverageKind; radius: number } | null {
  if (def.service && def.radius > 0) return { kind: def.service, radius: def.radius };
  if (def.parking && def.radius > 0) return { kind: "parking", radius: def.radius };
  if (def.amenity || def.cleans > 0) return { kind: "park", radius: def.radius > 0 ? def.radius : MOOD.AMENITY_RADIUS };
  if (def.pollution > 0) return { kind: "smoke", radius: MOOD.POLLUTION_RADIUS };
  return null;
}

// The covered cells (inclusive) for a footprint at (x, y) of w x h, clipped to the grid.
export function coverageCells(x: number, y: number, w: number, h: number, radius: number, size: number): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: Math.max(0, x - radius),
    y0: Math.max(0, y - radius),
    x1: Math.min(size - 1, x + w - 1 + radius),
    y1: Math.min(size - 1, y + h - 1 + radius),
  };
}

const Y = 0.34; // above roads and building slabs, below walls (which hide it where they stand)

// A fill plus a border frame over the given cells. `strong` for the selected building, lighter while
// placing. The caller adds it to the scene and calls disposeArea when done.
export function areaMesh(cells: { x0: number; y0: number; x1: number; y1: number }, kind: CoverageKind, strong = true): THREE.Group {
  const colour = COVERAGE_COLOURS[kind];
  const x0 = cells.x0 * CELL;
  const z0 = cells.y0 * CELL;
  const x1 = (cells.x1 + 1) * CELL;
  const z1 = (cells.y1 + 1) * CELL;
  const g = new THREE.Group();
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(x1 - x0, z1 - z0),
    new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: strong ? 0.22 : 0.18, depthWrite: false }),
  );
  fill.rotation.x = -Math.PI / 2;
  fill.position.set((x0 + x1) / 2, Y, (z0 + z1) / 2);
  fill.renderOrder = 8;
  g.add(fill);
  // the border: four strips, thick enough to read from far away
  const b = 0.8;
  const frameMat = new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: strong ? 0.9 : 0.75, depthWrite: false });
  const strip = (w: number, d: number, cx: number, cz: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), frameMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(cx, Y + 0.01, cz);
    m.renderOrder = 9;
    g.add(m);
  };
  strip(x1 - x0, b, (x0 + x1) / 2, z0 + b / 2);
  strip(x1 - x0, b, (x0 + x1) / 2, z1 - b / 2);
  strip(b, z1 - z0 - 2 * b, x0 + b / 2, (z0 + z1) / 2);
  strip(b, z1 - z0 - 2 * b, x1 - b / 2, (z0 + z1) / 2);
  return g;
}

export function disposeArea(g: THREE.Group): void {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
}