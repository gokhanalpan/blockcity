// Grid <-> world. One cell is GRID.CELL_UNITS world units (the models are built in Roblox studs: 4 per
// cell). The island's front edge (row y = 0, where the entrance is) lies on z = 0 and the grid extends
// toward +z; a model's front faces -z at rot 0 and turns by rot * 90 degrees about Y, matching
// District.frontCells.

import * as THREE from "three";
import { GRID } from "@/config/tuning";

export const CELL = GRID.CELL_UNITS;

// World position of a footprint's base centre.
export function tilePosition(x: number, y: number, w: number, h: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set((x + w / 2) * CELL, 0, (y + h / 2) * CELL);
}

export function tileRotation(rot: number): number {
  return (rot * Math.PI) / 2;
}

export function cellCentre(x: number, y: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set((x + 0.5) * CELL, 0, (y + 0.5) * CELL);
}

// Cell under a world point (may be outside the grid).
export function worldToCell(p: THREE.Vector3): [number, number] {
  return [Math.floor(p.x / CELL), Math.floor(p.z / CELL)];
}
