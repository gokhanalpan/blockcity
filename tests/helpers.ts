import { City } from "@/sim/city";
import { newDistrict } from "@/sim/district";
import { defByKey } from "@/sim/tileDefs";
import { GRID } from "@/config/tuning";

// mulberry32: a tiny deterministic PRNG for tests.
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MID = Math.floor(GRID.SIZE / 2); // 24: the entrance column

// A city with plenty of cash, all land owned (unless told otherwise) and a seeded RNG.
export function richCity(opts: { terrain?: string; allLand?: boolean; cash?: number; seed?: number } = {}): City {
  const d = newDistrict(GRID.SIZE, opts.terrain);
  d.cash = opts.cash ?? 1_000_000;
  if (opts.allLand !== false) for (let i = 0; i < 36; i++) d.chunks.add(i);
  return new City(d, seeded(opts.seed ?? 1));
}

export function place(city: City, key: string, x: number, y: number, rot = 0): void {
  const r = city.place(defByKey(key).id, x, y, rot);
  if (!r.ok) throw new Error(`place ${key} at ${x},${y}: ${r.reason}`);
}

// A straight road up the entrance column from y = 0 to y = len - 1.
export function trunk(city: City, len: number, key = "road"): void {
  for (let y = 1; y < len; y++) place(city, key, MID, y);
}

export function tileAt(city: City, x: number, y: number) {
  const t = city.tileAtCell(x, y);
  if (!t) throw new Error(`no tile at ${x},${y}`);
  return t;
}
