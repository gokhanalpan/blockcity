// The maps a new city can be started on. A terrain is a pure function (x, y, size) -> is water.
// Water cells cannot be built on except by bridges and floating buildings. The terrain key is saved
// with the city, never the cells. Translated from the Roblox Terrains.lua; the shapes are identical.

export interface Terrain {
  key: string;
  name: string;
  desc: string;
}

export const TERRAIN_LIST: readonly Terrain[] = [
  { key: "plains", name: "Plains", desc: "Open land, nothing in the way." },
  { key: "river", name: "River", desc: "A river crosses the map. Bridges needed." },
  { key: "lake", name: "Lakeside", desc: "A lake in the middle: waterfront homes." },
  { key: "coast", name: "Coast", desc: "The sea along the east edge." },
  { key: "delta", name: "Delta", desc: "A river that splits around a lake." },
  { key: "island", name: "Island", desc: "Water all around. Land is scarce." },
  { key: "twin_rivers", name: "Twin Rivers", desc: "Two winding rivers, lots of riverbank." },
  { key: "bay", name: "Bay", desc: "The sea bites deep into the back of the plot." },
  { key: "estuary", name: "Estuary", desc: "A river that widens into the sea." },
  { key: "canals", name: "Canals", desc: "A grid of canals. Bridges everywhere." },
  { key: "archipelago", name: "Archipelago", desc: "Four islands in the sea; the entrance island is the biggest." },
];

export const DEFAULT_TERRAIN = "plains";

export const TERRAIN_BY_KEY: Readonly<Record<string, Terrain>> = Object.fromEntries(TERRAIN_LIST.map((t) => [t.key, t]));

// Luau's math.round rounds halves away from zero; JS Math.round rounds them toward +inf.
function luaRound(v: number): number {
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

function ellipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

type Shape = (x: number, y: number, size: number) => boolean;

// All shapes keep the entrance cells (middle of the front edge, y = 0) on land.
const shapes: Record<string, Shape> = {
  plains: () => false,
  river: (x, y, size) => {
    const cx = Math.floor(size * 0.7 + 5 * Math.sin(y * 0.22));
    return x >= cx && x <= cx + 2; // three cells wide
  },
  lake: (x, y, size) => ellipse(x, y, size * 0.62, size * 0.54, 9, 6),
  coast: (x, y, size) => x >= size - 8 + luaRound(2 * Math.sin(y * 0.3)),
  delta: (x, y, size) => {
    const mid = size / 2;
    if (ellipse(x, y, mid, size * 0.54, 8, 5)) return true;
    if (y >= size * 0.62) {
      // the river comes in from the back edge
      const cx = Math.floor(mid + 3 * Math.sin(y * 0.3));
      return x >= cx - 1 && x <= cx + 1;
    }
    if (y >= 3 && y < size * 0.46) {
      // two branches run toward the front corners
      const t = (size * 0.46 - y) * 0.45;
      const l = Math.floor(mid - 7 - t);
      const r = Math.floor(mid + 7 + t);
      return (x >= l && x <= l + 2) || (x >= r && x <= r + 2);
    }
    return false;
  },
  island: (x, y, size) => {
    const mid = size / 2;
    if (y <= 3 && Math.abs(x - mid) <= 3) return false; // causeway to the entrance
    return !ellipse(x, y, mid, mid, size * 0.44, size * 0.46);
  },
  twin_rivers: (x, y, size) => {
    const a = Math.floor(size * 0.25 + 4 * Math.sin(y * 0.2));
    const b = Math.floor(size * 0.7 + 4 * Math.sin(y * 0.25 + 1));
    return (x >= a && x <= a + 2) || (x >= b && x <= b + 2);
  },
  // an ellipse centred beyond the back edge, so the sea reaches in from the back
  bay: (x, y, size) => ellipse(x, y, size / 2 + 2 * Math.sin(y * 0.3), size * 1.08, size * 0.34, size * 0.42),
  estuary: (x, y, size) => {
    if (y < 4) return false;
    const centre = size * 0.62 + 3 * Math.sin(y * 0.15);
    const half = 1 + ((y - 4) / (size - 4)) * 7; // narrow by the entrance, wide at the back
    return Math.abs(x - centre) <= half;
  },
  canals: (x, y) => {
    if (y < 4) return false;
    const vx = x % 12;
    const vy = y % 12;
    return vx === 6 || vx === 7 || vy === 10 || vy === 11;
  },
  archipelago: (x, y, size) => {
    const mid = size / 2;
    if (ellipse(x, y, mid, size * 0.16, size * 0.3, size * 0.2)) return false; // the entrance island
    if (ellipse(x, y, size * 0.2, size * 0.62, size * 0.19, size * 0.19)) return false;
    if (ellipse(x, y, size * 0.8, size * 0.58, size * 0.19, size * 0.17)) return false;
    if (ellipse(x, y, mid, size * 0.88, size * 0.25, size * 0.1)) return false;
    return true;
  },
};

export function isWater(key: string, x: number, y: number, size: number): boolean {
  const f = shapes[key] ?? shapes.plains;
  return f(x, y, size);
}

const cache = new Map<string, Uint8Array>();

// Water mask for a terrain: 1 at index (y * size + x) if water. Cached per key and size, never mutated.
export function waterMask(key: string, size: number): Uint8Array {
  const id = `${key}:${size}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const mask = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isWater(key, x, y, size)) mask[y * size + x] = 1;
    }
  }
  cache.set(id, mask);
  return mask;
}