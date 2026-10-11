// Catalog lookups. The data itself is in src/config/catalog.ts.
import { TILE_LIST, type TileDef } from "@/config/catalog";

export type { TileDef, ServiceName } from "@/config/catalog";
export { TILE_LIST, CATEGORIES } from "@/config/catalog";

export const TILE_BY_ID: ReadonlyMap<number, TileDef> = new Map();
export const TILE_BY_KEY: ReadonlyMap<string, TileDef> = new Map();
{
  const byId = TILE_BY_ID as Map<number, TileDef>;
  const byKey = TILE_BY_KEY as Map<string, TileDef>;
  for (const d of TILE_LIST) {
    if (byId.has(d.id)) throw new Error(`duplicate tile id ${d.id}`);
    if (byKey.has(d.key)) throw new Error(`duplicate tile key ${d.key}`);
    byId.set(d.id, d);
    byKey.set(d.key, d);
  }
}

export function defById(id: number): TileDef {
  const d = TILE_BY_ID.get(id);
  if (!d) throw new Error(`unknown tile id ${id}`);
  return d;
}

export function defByKey(key: string): TileDef {
  const d = TILE_BY_KEY.get(key);
  if (!d) throw new Error(`unknown tile key ${key}`);
  return d;
}

export const ROAD_ID = defByKey("road").id; // the basic road, used to seed the entrance

export function isRoadId(id: number | undefined): boolean {
  if (id === undefined) return false;
  const d = TILE_BY_ID.get(id);
  return d !== undefined && d.roadCapacity > 0;
}

export function isRuins(def: TileDef): boolean {
  return def.key.startsWith("ruins");
}
