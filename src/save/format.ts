// The save file. An envelope around the city blob (src/sim/district.ts, byte-compatible with the
// Roblox v2 blob) with the metadata later layers need without touching the city itself:
//
//   id        stable per city: the key a cloud store or a market would use
//   revision  bumps on every write: lets a cloud sync pick the newer copy and detect conflicts
//   origin    who wrote it last ("local" now; a cloud layer would set its own id)
//   savedAt   wall clock at save time, for offline earnings
//   meta      summary for the slot screen, so listing saves never deserializes a city
//
// Bump ENVELOPE_VERSION when this shape changes and migrate in `parseSave`; bump
// CITY_BLOB_VERSION (district.ts) when the city blob changes and migrate in `deserialize`.

import { ECONOMY, GRID } from "@/config/tuning";
import type { CityBlob } from "@/sim/district";
import type { City } from "@/sim/city";
import { chunkCount } from "@/sim/district";

export const SAVE_FORMAT = "block-city";
export const ENVELOPE_VERSION = 1;

export interface SaveMeta {
  name: string;
  terrain: string;
  population: number;
  cash: number;
  level: number;
  chunks: number;
  size: number;
}

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  version: number;
  id: string;
  revision: number;
  origin: string;
  savedAt: number; // ms since epoch
  playSeconds: number; // lifetime time played
  meta: SaveMeta;
  city: CityBlob;
}

export function levelFor(population: number): number {
  return Math.floor(Math.sqrt(population / 25)) + 1;
}

export function newSaveId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface SaveIdentity {
  id: string;
  revision: number;
  playSeconds: number;
}

export function buildSave(city: City, identity: SaveIdentity, now: number = Date.now()): SaveFile {
  const d = city.district;
  return {
    format: SAVE_FORMAT,
    version: ENVELOPE_VERSION,
    id: identity.id,
    revision: identity.revision,
    origin: "local",
    savedAt: now,
    playSeconds: identity.playSeconds,
    meta: {
      name: d.name,
      terrain: d.terrain,
      population: city.report.population,
      cash: Math.floor(d.cash),
      level: levelFor(city.report.population),
      chunks: chunkCount(d),
      size: d.size,
    },
    city: city.toBlob(),
  };
}

// Accepts a parsed JSON value; returns a SaveFile or throws with a reason the UI can show.
// Also accepts a bare Roblox-style city blob (no envelope) so old saves can be imported.
export function parseSave(raw: unknown): SaveFile {
  if (!raw || typeof raw !== "object") throw new Error("not a save file");
  const o = raw as Record<string, unknown>;
  if (o.format === SAVE_FORMAT) {
    const version = typeof o.version === "number" ? o.version : 0;
    if (version > ENVELOPE_VERSION) throw new Error(`save is from a newer version (${version})`);
    const city = o.city;
    if (!city || typeof city !== "object") throw new Error("save has no city");
    const meta = (o.meta && typeof o.meta === "object" ? o.meta : {}) as Partial<SaveMeta>;
    return {
      format: SAVE_FORMAT,
      version: ENVELOPE_VERSION,
      id: typeof o.id === "string" && o.id.length > 0 ? o.id : newSaveId(),
      revision: typeof o.revision === "number" ? o.revision : 0,
      origin: typeof o.origin === "string" ? o.origin : "local",
      savedAt: typeof o.savedAt === "number" ? o.savedAt : 0,
      playSeconds: typeof o.playSeconds === "number" ? o.playSeconds : 0,
      meta: {
        name: typeof meta.name === "string" ? meta.name : "City",
        terrain: typeof meta.terrain === "string" ? meta.terrain : "plains",
        population: typeof meta.population === "number" ? meta.population : 0,
        cash: typeof meta.cash === "number" ? meta.cash : ECONOMY.STARTING_CASH,
        level: typeof meta.level === "number" ? meta.level : 1,
        chunks: typeof meta.chunks === "number" ? meta.chunks : 2,
        size: typeof meta.size === "number" ? meta.size : GRID.SIZE,
      },
      city: city as CityBlob,
    };
  }
  // A bare city blob (Roblox export): wrap it.
  if (Array.isArray(o.t) && typeof o.v === "number") {
    const blob = o as unknown as CityBlob;
    return {
      format: SAVE_FORMAT,
      version: ENVELOPE_VERSION,
      id: newSaveId(),
      revision: 0,
      origin: "import",
      savedAt: 0,
      playSeconds: 0,
      meta: {
        name: typeof blob.n === "string" ? blob.n : "City",
        terrain: typeof blob.tr === "string" ? blob.tr : "plains",
        population: 0,
        cash: typeof blob.cash === "number" ? blob.cash : ECONOMY.STARTING_CASH,
        level: 1,
        chunks: Array.isArray(blob.c) ? blob.c.length : 2,
        size: typeof blob.size === "number" ? blob.size : GRID.SIZE,
      },
      city: blob,
    };
  }
  throw new Error("not a Block City save");
}
