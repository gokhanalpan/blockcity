// Roads are drawn from their neighbours, as in the Roblox DistrictWorld.decorateRoad: the asphalt
// slab from the model, curbs on the sides with no road (railings on a bridge), a centre line on an
// avenue and two lane lines on a highway that follow the direction and bend at corners, nothing
// through junctions. One merged geometry per (tier, 4-bit neighbour mask), shared by every road
// tile with that shape.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CELL } from "./coords";
import { buildModel } from "./models";

export type RoadTier = "road" | "avenue" | "highway" | "bridge" | "highway_bridge";

const isBridge = (tier: RoadTier) => tier === "bridge" || tier === "highway_bridge";

// Height of the driving surface: land roads are a 0.2 slab; bridge decks sit higher.
export function surfaceHeight(tier: RoadTier): number {
  return tier === "highway_bridge" ? 0.605 : tier === "bridge" ? 0.545 : 0.2;
}

// Mask bits in DIRS order: +x, -x, +y(+z), -y(-z)
export const ROAD_DIRS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const CURB: [number, number, number] = [170, 170, 165];
const YELLOW: [number, number, number] = [230, 190, 60];
const WHITE: [number, number, number] = [235, 235, 240];
const RAIL: [number, number, number] = [200, 200, 205];
const POST: [number, number, number] = [170, 170, 175];

function box(w: number, h: number, d: number, x: number, y: number, z: number, c: [number, number, number]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.deleteAttribute("uv");
  const n = g.getAttribute("position").count;
  const col = new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255).convertSRGBToLinear();
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colours[i * 3] = col.r;
    colours[i * 3 + 1] = col.g;
    colours[i * 3 + 2] = col.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  g.translate(x, y, z);
  return g.toNonIndexed();
}

const cache = new Map<string, THREE.BufferGeometry>();

export function roadGeometry(tier: RoadTier, mask: number): THREE.BufferGeometry {
  const key = `${tier}:${mask}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const parts: THREE.BufferGeometry[] = [];
  // the slab: the model minus its preview lines/rails
  const model = buildModel(tier, "tiles", "slab");
  if (model.opaque) {
    const slab = model.opaque.clone();
    slab.deleteAttribute("aMat");
    slab.deleteAttribute("aUv");
    parts.push(slab);
  }
  const connected = ROAD_DIRS.map((_, i) => (mask & (1 << i)) !== 0);
  const count = connected.filter(Boolean).length;
  ROAD_DIRS.forEach(([dx, dz], i) => {
    if (connected[i]) return;
    if (isBridge(tier)) {
      if (dx !== 0) parts.push(box(0.12, 0.5, CELL, dx * 1.9, 0.8, 0, RAIL));
      else parts.push(box(CELL, 0.5, 0.12, 0, 0.8, dz * 1.9, RAIL));
      parts.push(box(0.16, 0.6, 0.16, dx * 1.9 + dz * 1.7, 0.8, dz * 1.9 + dx * 1.7, POST));
      parts.push(box(0.16, 0.6, 0.16, dx * 1.9 - dz * 1.7, 0.8, dz * 1.9 - dx * 1.7, POST));
    } else if (dx !== 0) {
      parts.push(box(0.3, 0.16, CELL, dx * 1.85, 0.28, 0, CURB));
    } else {
      parts.push(box(CELL, 0.16, 0.3, 0, 0.28, dz * 1.85, CURB));
    }
  });
  // lane markings: straights, bends and dead ends only; junctions (3+) stay plain asphalt
  if ((tier === "avenue" || tier === "highway" || tier === "highway_bridge") && count <= 2) {
    const ly = surfaceHeight(tier) + 0.02; // on the surface, wherever that is
    ROAD_DIRS.forEach(([dx, dz], i) => {
      if (!connected[i]) return;
      const alongX = dx !== 0;
      if (tier === "avenue") {
        parts.push(alongX ? box(2, 0.04, 0.22, dx, ly, dz, YELLOW) : box(0.22, 0.04, 2, dx, ly, dz, YELLOW));
      } else {
        // highway and highway bridge: two white lane lines
        const sx = alongX ? 0 : 0.7;
        const sz = alongX ? 0.7 : 0;
        parts.push(alongX ? box(2, 0.04, 0.16, dx + sx, ly, dz + sz, WHITE) : box(0.16, 0.04, 2, dx + sx, ly, dz + sz, WHITE));
        parts.push(alongX ? box(2, 0.04, 0.16, dx - sx, ly, dz - sz, WHITE) : box(0.16, 0.04, 2, dx - sx, ly, dz - sz, WHITE));
      }
    });
  }
  const merged = mergeGeometries(parts, false) ?? new THREE.BufferGeometry();
  cache.set(key, merged);
  return merged;
}

// Road tint by load. The material colour multiplies the vertex colours, so plain asphalt is white
// (no tint); from 40% of capacity the road warms through amber to red at 100% and beyond. One shared
// material per step, so a full city still uses a dozen materials.
const STEPS = 20; // 5% steps
const tints: THREE.MeshLambertMaterial[] = [];
const AMBER = new THREE.Color(1.0, 0.66, 0.0);
export const ROAD_BUSY = 0.2; // share of capacity where a road starts to glow orange (fading in)
export const ROAD_ORANGE = 0.5; // ...full orange here
export const ROAD_RED = 0.85; // ...and fully red here
const RED = new THREE.Color(0.95, 0.12, 0.05);
for (let i = 0; i <= STEPS; i++) {
  const f = i / STEPS; // 0 = empty, 1 = at capacity
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  // Busy roads glow: orange fading in from 20% of capacity, full orange at half, turning red, solid
  // red from 85% (as in Roblox, a road nearly full is already red). A glow (emissive) rather than a
  // tint, because multiplying near-black asphalt by red still looks near-black.
  if (f >= ROAD_BUSY && f < ROAD_ORANGE) {
    const k = (f - ROAD_BUSY) / (ROAD_ORANGE - ROAD_BUSY);
    m.emissive.copy(AMBER);
    m.emissiveIntensity = 0.12 + 0.26 * k;
  } else if (f >= ROAD_ORANGE) {
    const k = Math.min(1, (f - ROAD_ORANGE) / (ROAD_RED - ROAD_ORANGE));
    m.emissive.copy(AMBER).lerp(RED, k);
    m.emissiveIntensity = 0.38 + 0.22 * k;
  }
  tints.push(m);
}
// Over capacity (or blocked by a crash): strong red, pulsing (see pulseJammedRoads).
const jammedMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color(1, 0.07, 0.03), emissiveIntensity: 0.7 });

export function roadTint(load: number, capacity: number, jammed: boolean): THREE.MeshLambertMaterial {
  if (jammed) return jammedMaterial; // over capacity or blocked: red and pulsing
  const f = capacity > 0 ? Math.min(1, load / capacity) : 0;
  return tints[Math.round(f * STEPS)];
}

// Called every frame: jammed roads throb so the eye goes to them.
export function pulseJammedRoads(time: number): void {
  jammedMaterial.emissiveIntensity = 0.62 + 0.22 * Math.sin(time * 4.5);
}

export const roadMaterial = tints[0];