// Pure data + grid math, translated from the Roblox DistrictData.lua. No DOM, no Three.js: runs in
// the game, in tests and (later) in a worker. Cell indices are y * size + x; a tile is keyed by the
// index of its anchor cell (the top-left of its footprint at rot 0).

import { ECONOMY, GRID, REBIRTH, SAVE } from "@/config/tuning";
import { TILE_BY_ID, defById, isRoadId, type TileDef } from "./tileDefs";
import { DEFAULT_TERRAIN, TERRAIN_BY_KEY, waterMask } from "./terrains";

export type Need =
  | "road" | "avenue" | "power" | "police" | "health" | "school" | "fire" | "fun"
  | "clean air" | "park" | "jobs" | "traffic" | "parking" | "university"
  | "burning" | "blackout" | "crash" | "storm" | "crime" | (string & {});

export type EventKind = "burning" | "blackout" | "crash" | "storm" | "crime";

export interface Tile {
  id: number; // TileDef id
  anchor: number; // index of the anchor cell (the key in District.tiles)
  x: number; // anchor cell (top-left of footprint), 0-based
  y: number;
  rot: number; // 0..3 quarter turns
  seq: number; // placement order; brownouts cut the newest consumers first
  occ: number; // residents living here (residential only; 0 for everything else)
  // runtime only, never saved:
  active: boolean; // has road access (or doesn't need it)
  powered: boolean; // got its share of the power budget this tick
  reachable: boolean; // roads only: connected to the entrance
  mood: number; // residential: 0..10 from the last recompute
  needs: Need[]; // what this tile is missing, for the icon over it
  growth: number; // residential: accumulator that turns mood into residents over ticks
  growthDelta: number; // residential: what the next collect() adds to growth
  // traffic (runtime):
  dist: number; // roads: hops to the entrance (Infinity if unreachable)
  parent: number | undefined; // roads: next road cell toward the entrance
  access: number | undefined; // buildings: the road cell they use
  load: number; // roads: trips passing through per tick
  jammed: boolean; // roads: load over capacity
  blocked: boolean; // roads: jammed, or downstream of a jam
  served: number; // services: residents this building is serving this tick
  event: EventKind | undefined; // active event on this tile, runtime only
}

// Runtime effects applied by Events (never saved).
export interface Effects {
  disabled: Map<number, "burning" | "blackout" | "storm">; // anchor -> why it isn't working
  roadBlocked: Set<number>;
  halfJobs: Set<number>; // workplaces hit by a crime wave
  funMult: number;
  growthMult: number;
  incomeMult: number;
}

export interface District {
  name: string;
  terrain: string; // terrain key; decides the water cells
  water: Uint8Array; // cell index -> 1 if water (derived from terrain, never saved)
  fx: Effects; // runtime event effects (never saved)
  goalsDone: Set<string>; // completed goal keys (saved)
  counters: Record<string, number>; // lifetime counters for goals: firesFought, stormsSurvived, ruinsCleared (saved)
  size: number;
  cash: number;
  rebirths: number;
  nextSeq: number;
  tiles: Map<number, Tile>; // anchor cell index -> tile
  occupied: Map<number, number>; // any covered cell index -> anchor cell index
  chunks: Set<number>; // owned land, by chunk index
  dirty: boolean; // has unsaved changes
}

// The city part of a save. Kept byte-compatible with the Roblox v2 blob so cloud/market layers can be
// added around it without touching it (see src/save/format.ts for the envelope).
export interface CityBlob {
  v: number;
  n?: string; // city name
  tr?: string; // terrain key
  size: number;
  cash: number;
  rebirths: number;
  g?: string[]; // completed goal keys
  cnt?: Record<string, number>; // counters
  t: number[]; // anchorIndex, tileId, rot, occupants, ... in placement order (v1 had no occupants)
  c: number[]; // owned chunk indices
}

export const CITY_BLOB_VERSION = 2;

const DIRS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function index(size: number, x: number, y: number): number {
  return y * size + x;
}

export function coords(size: number, i: number): [number, number] {
  return [i % size, Math.floor(i / size)];
}

export function inBounds(size: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < size && y < size;
}

export function footprint(def: TileDef, rot: number): [number, number] {
  return rot % 2 === 1 ? [def.h, def.w] : [def.w, def.h];
}

// Cells covered by `def` anchored at (x, y). undefined if any cell falls outside the grid.
export function cells(size: number, def: TileDef, x: number, y: number, rot: number): number[] | undefined {
  const [w, h] = footprint(def, rot);
  if (!inBounds(size, x, y) || !inBounds(size, x + w - 1, y + h - 1)) return undefined;
  const out: number[] = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) out.push(index(size, x + dx, y + dy));
  }
  return out;
}

export function tileCells(size: number, t: Tile): number[] {
  const c = cells(size, defById(t.id), t.x, t.y, t.rot);
  if (!c) throw new Error("tile out of bounds");
  return c;
}

// 4-neighbours of a set of cells that are outside the set and inside the grid. No duplicates.
export function neighbours(size: number, cellList: readonly number[]): number[] {
  const inside = new Set(cellList);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const c of cellList) {
    const [x, y] = coords(size, c);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (inBounds(size, nx, ny)) {
        const n = index(size, nx, ny);
        if (!inside.has(n) && !seen.has(n)) {
          seen.add(n);
          out.push(n);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Land chunks. The grid is chunksPerSide x chunksPerSide chunks of CHUNK x CHUNK cells.
// ---------------------------------------------------------------------------------------------
export function chunksPerSide(size: number): number {
  return Math.floor(size / GRID.CHUNK);
}

export function chunkIndex(size: number, cx: number, cy: number): number {
  return cy * chunksPerSide(size) + cx;
}

export function chunkCoords(size: number, ci: number): [number, number] {
  const n = chunksPerSide(size);
  return [ci % n, Math.floor(ci / n)];
}

export function chunkOfCell(size: number, x: number, y: number): number {
  return chunkIndex(size, Math.floor(x / GRID.CHUNK), Math.floor(y / GRID.CHUNK));
}

export function chunkInBounds(size: number, cx: number, cy: number): boolean {
  const n = chunksPerSide(size);
  return cx >= 0 && cy >= 0 && cx < n && cy < n;
}

// The two front-centre chunks either side of the entrance column.
export function defaultChunks(size: number): Set<number> {
  const cx = Math.floor(Math.floor(size / 2) / GRID.CHUNK);
  const out = new Set<number>();
  out.add(chunkIndex(size, cx, 0));
  if (cx - 1 >= 0) out.add(chunkIndex(size, cx - 1, 0));
  return out;
}

export function ownsCell(d: District, cellIndex: number): boolean {
  const [x, y] = coords(d.size, cellIndex);
  return d.chunks.has(chunkOfCell(d.size, x, y));
}

export function chunkCount(d: District): number {
  return d.chunks.size;
}

// Price of the next chunk given how many are owned now. The main money sink.
export function landPrice(owned: number): number {
  return ECONOMY.LAND_PRICE_BASE * (owned - 1) ** 2;
}

// Unowned, inside the grid, and sharing an edge with an owned chunk.
export function isBuyable(d: District, ci: number): boolean {
  if (d.chunks.has(ci)) return false;
  const [cx, cy] = chunkCoords(d.size, ci);
  if (!chunkInBounds(d.size, cx, cy)) return false;
  for (const [dx, dy] of DIRS) {
    const nx = cx + dx;
    const ny = cy + dy;
    if (chunkInBounds(d.size, nx, ny) && d.chunks.has(chunkIndex(d.size, nx, ny))) return true;
  }
  return false;
}

// The entrance: the middle three cells of the front edge (y = 0), middle first.
export function entranceCells(size: number): number[] {
  const mid = Math.floor(size / 2);
  return [index(size, mid, 0), index(size, mid - 1, 0), index(size, mid + 1, 0)];
}

// Cells just outside the footprint along its front edge: the side the model faces (-Z at rot 0,
// turning with the quarter-turn rotation the same way the renderer turns the model).
export function frontCells(size: number, def: TileDef, x: number, y: number, rot: number): number[] {
  const [w, h] = footprint(def, rot);
  const out: number[] = [];
  const push = (cx: number, cy: number) => {
    if (inBounds(size, cx, cy)) out.push(index(size, cx, cy));
  };
  if (rot === 0) for (let i = 0; i < w; i++) push(x + i, y - 1);
  else if (rot === 1) for (let j = 0; j < h; j++) push(x - 1, y + j);
  else if (rot === 2) for (let i = 0; i < w; i++) push(x + i, y + h);
  else for (let j = 0; j < h; j++) push(x + w, y + j);
  return out;
}

// Where a building may take its road from: every neighbour, or only the front edge for roadSide "front".
export function accessCells(size: number, def: TileDef, x: number, y: number, rot: number): number[] {
  if (def.roadSide === "front") return frontCells(size, def, x, y, rot);
  const c = cells(size, def, x, y, rot);
  if (!c) throw new Error("accessCells out of bounds");
  return neighbours(size, c);
}

export function newEffects(): Effects {
  return { disabled: new Map(), roadBlocked: new Set(), halfJobs: new Set(), funMult: 1, growthMult: 1, incomeMult: 1 };
}

export function newDistrict(size: number = GRID.SIZE, terrain?: string): District {
  const tr = terrain && TERRAIN_BY_KEY[terrain] ? terrain : DEFAULT_TERRAIN;
  return {
    name: SAVE.DEFAULT_NAME,
    terrain: tr,
    water: waterMask(tr, size),
    fx: newEffects(),
    goalsDone: new Set(),
    counters: {},
    size,
    cash: ECONOMY.STARTING_CASH,
    rebirths: 0,
    nextSeq: 1,
    tiles: new Map(),
    occupied: new Map(),
    chunks: defaultChunks(size),
    dirty: false,
  };
}

// The tile covering a cell, whether or not that cell is its anchor.
export function tileAt(d: District, cellIndex: number): Tile | undefined {
  const anchor = d.occupied.get(cellIndex);
  return anchor === undefined ? undefined : d.tiles.get(anchor);
}

// Caller must have validated bounds and overlap already. Residential starts with one resident.
export function addTile(d: District, id: number, x: number, y: number, rot: number, occ?: number): Tile {
  const def = defById(id);
  const c = cells(d.size, def, x, y, rot);
  if (!c) throw new Error("addTile out of bounds");
  const anchor = index(d.size, x, y);
  const startOcc = def.population > 0 ? Math.min(Math.max(occ ?? 1, 0), def.population) : 0;
  const tile: Tile = {
    anchor, id, x, y, rot, seq: d.nextSeq, occ: startOcc,
    active: false, powered: false, reachable: false,
    mood: 5, needs: [], growth: 0, growthDelta: 0,
    dist: Infinity, parent: undefined, access: undefined, load: 0, jammed: false, blocked: false,
    served: 0, event: undefined,
  };
  d.nextSeq += 1;
  d.tiles.set(anchor, tile);
  for (const cell of c) d.occupied.set(cell, anchor);
  d.dirty = true;
  return tile;
}

export function removeTile(d: District, anchor: number): Tile | undefined {
  const tile = d.tiles.get(anchor);
  if (!tile) return undefined;
  for (const cell of tileCells(d.size, tile)) d.occupied.delete(cell);
  d.tiles.delete(anchor);
  d.dirty = true;
  return tile;
}

export function tilesBySeq(d: District): Tile[] {
  return [...d.tiles.values()].sort((a, b) => a.seq - b.seq);
}

export function rebirthBonus(d: District): number {
  return Math.min(d.rebirths * REBIRTH.INCOME_BONUS, REBIRTH.MAX_BONUS);
}

// ---------------------------------------------------------------------------------------------
// Serialization (the city blob; the save envelope wraps it, see src/save/format.ts)
// ---------------------------------------------------------------------------------------------
export function serialize(d: District): CityBlob {
  const flat: number[] = [];
  for (const t of tilesBySeq(d)) flat.push(index(d.size, t.x, t.y), t.id, t.rot, t.occ);
  return {
    v: CITY_BLOB_VERSION,
    n: d.name,
    tr: d.terrain,
    size: d.size,
    cash: d.cash,
    rebirths: d.rebirths,
    t: flat,
    c: [...d.chunks].sort((a, b) => a - b),
    g: [...d.goalsDone].sort(),
    cnt: { ...d.counters },
  };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// Tolerant on purpose: unknown ids, bad coords and overlaps are dropped rather than failing the load.
// When CITY_BLOB_VERSION changes, branch on blob.v here and migrate.
export function deserialize(raw: unknown): District {
  const blob = (raw && typeof raw === "object" ? raw : {}) as Partial<CityBlob>;
  const oldSize = num(blob.size) ?? GRID.SIZE;
  const d = newDistrict(GRID.SIZE, typeof blob.tr === "string" ? blob.tr : undefined);
  d.cash = num(blob.cash) ?? ECONOMY.STARTING_CASH;
  d.rebirths = num(blob.rebirths) ?? 0;
  if (Array.isArray(blob.g)) for (const key of blob.g) if (typeof key === "string") d.goalsDone.add(key);
  if (blob.cnt && typeof blob.cnt === "object") {
    for (const [name, n] of Object.entries(blob.cnt)) if (typeof n === "number") d.counters[name] = n;
  }
  if (typeof blob.n === "string" && blob.n.length > 0 && blob.n.length <= SAVE.MAX_NAME) d.name = blob.n;
  // Saves made on a different grid size are re-anchored so the entrance cell still lines up.
  const shiftX = Math.floor(d.size / 2) - Math.floor(oldSize / 2);
  const flat = Array.isArray(blob.t) ? blob.t : [];
  const stride = (num(blob.v) ?? 1) >= 2 ? 4 : 3; // v1 saves had no occupants
  for (let i = 0; i + stride - 1 < flat.length; i += stride) {
    const anchor = num(flat[i]);
    const id = num(flat[i + 1]);
    const rot = num(flat[i + 2]);
    const occ = stride === 4 ? num(flat[i + 3]) : undefined;
    if (anchor === undefined || id === undefined || rot === undefined) continue;
    const def = TILE_BY_ID.get(id);
    if (!def || rot < 0 || rot > 3) continue;
    const [ox, oy] = coords(oldSize, anchor);
    const x = ox + shiftX;
    const y = oy;
    const c = cells(d.size, def, x, y, rot);
    if (!c) continue;
    let clear = true;
    for (const cell of c) {
      if (d.occupied.has(cell) || (d.water[cell] === 1) !== def.onWater) {
        clear = false; // overlap, or land/water mismatch for this tile type
        break;
      }
    }
    if (clear) addTile(d, id, x, y, rot, occ);
  }
  // Land: saved chunks (validated), plus whatever chunks existing tiles sit on, so older saves stay legal.
  const total = chunksPerSide(d.size) ** 2;
  const chunks = new Set<number>();
  if (Array.isArray(blob.c)) {
    for (const ci of blob.c) if (typeof ci === "number" && Number.isInteger(ci) && ci >= 0 && ci < total) chunks.add(ci);
  }
  for (const t of d.tiles.values()) {
    for (const cell of tileCells(d.size, t)) {
      const [x, y] = coords(d.size, cell);
      chunks.add(chunkOfCell(d.size, x, y));
    }
  }
  d.chunks = chunks.size === 0 ? defaultChunks(d.size) : chunks;
  d.dirty = false;
  return d;
}

export { isRoadId };
