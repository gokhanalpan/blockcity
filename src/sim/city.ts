// The game controller: everything the Roblox PlacementService did, minus the network. Owns the
// District plus the runtime state (events, citizen feed, last report), validates and applies the
// player's actions, and runs the tick. Pure TypeScript: the renderer and UI subscribe to `onChange`.

import { ECONOMY, REBIRTH, SAVE } from "@/config/tuning";
import { ROAD_ID, defById, defByKey, isRoadId, isRuins, TILE_BY_ID, TILE_BY_KEY, type TileDef } from "./tileDefs";
import {
  accessCells, addTile, cells, chunkCount, chunkInBounds, chunkIndex, chunksPerSide, coords, deserialize,
  entranceCells, footprint, inBounds, index, isBuyable, landPrice, neighbours, newDistrict, ownsCell, removeTile,
  serialize, tileAt, type CityBlob, type District, type Tile,
} from "./district";
import { collect, recompute, type Report } from "./simulation";
import { clearEvents, newEventsState, stepEvents, summarizeEvents, type EventSummary, type EventsState, type News, type Rng } from "./events";
import { stepGoals, summarizeGoals, type GoalsSummary } from "./goals";
import { newFeedState, stepFeed, type FeedLine, type FeedState } from "./citizenFeed";

export type PlaceError =
  | "bad_args" | "unknown_tile" | "locked" | "out_of_bounds" | "occupied" | "locked_land" | "water"
  | "needs_water" | "no_cash" | "front_off_map" | "needs_mooring" | "needs_water_nearby" | "needs_shore";
export type RemoveError = "bad_args" | "out_of_bounds" | "empty";
export type RestoreError = "occupied" | "locked_land" | "no_cash" | "out_of_bounds";

// Everything needed to put a demolished tile back exactly as it was (for Undo).
export interface Removed {
  id: number;
  x: number;
  y: number;
  rot: number;
  occ: number; // residents
  seq: number; // placement order: keeps its place in the power queue
  refund: number; // what demolishing paid out (Undo takes it back)
  ruins: boolean; // clearing ruins counts toward a goal; Undo uncounts it
}
export type LandError = "bad_args" | "out_of_bounds" | "already_owned" | "not_adjacent" | "no_cash";

export type Result<E extends string> = { ok: true } | { ok: false; reason: E };

export interface Validation {
  reason?: PlaceError;
  cells?: number[];
  replaceAnchor?: number; // set when a road tier is being placed over an existing road (an in-place upgrade)
}

// What changed, so the renderer can update only what it must.
export type ChangeKind = "place" | "remove" | "land" | "tick" | "load" | "rename" | "refresh";

export interface Change {
  kind: ChangeKind;
  cells?: number[]; // cells touched by a place/remove (the renderer re-decorates roads around them)
  anchors?: number[]; // tiles added/removed
}

export interface TickOutput {
  report: Report;
  news: News[];
}

export class City {
  district: District;
  readonly entrance: number[];
  events: EventsState = newEventsState();
  feed: FeedState = newFeedState();
  report: Report;
  news: News[] = [];
  ticks = 0; // ticks run this session
  rng: Rng;
  private listeners = new Set<(c: Change) => void>();

  constructor(district?: District, rng: Rng = Math.random) {
    this.rng = rng;
    this.district = district ?? newDistrict();
    this.entrance = entranceCells(this.district.size);
    this.seedEntrance();
    this.report = recompute(this.district, this.entrance);
  }

  static fromBlob(blob: unknown, rng?: Rng): City {
    return new City(deserialize(blob), rng);
  }

  // Fresh district: a free road on the entrance cell, so the player just extends what they see.
  private seedEntrance(): void {
    if (this.district.tiles.size === 0) {
      const [ex, ey] = coords(this.district.size, this.entrance[0]);
      addTile(this.district, ROAD_ID, ex, ey, 0);
      this.district.dirty = false;
    }
  }

  onChange(fn: (c: Change) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: Change): void {
    for (const fn of this.listeners) fn(c);
  }

  // Recompute derived state without collecting income (after any placement).
  refresh(kind: ChangeKind = "refresh", change: Partial<Change> = {}): void {
    this.report = recompute(this.district, this.entrance);
    this.emit({ kind, ...change });
  }

  // -------------------------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------------------------
  validatePlace(id: number, x: number, y: number, rot: number): Validation {
    if (![id, x, y, rot].every(Number.isInteger)) return { reason: "bad_args" };
    if (rot < 0 || rot > 3) return { reason: "bad_args" };
    const def = TILE_BY_ID.get(id);
    if (!def) return { reason: "unknown_tile" };
    const d = this.district;
    if (d.rebirths < def.unlockRebirth) return { reason: "locked" };
    const c = cells(d.size, def, x, y, rot);
    if (!c) return { reason: "out_of_bounds" };
    let replaceAnchor: number | undefined;
    for (const cell of c) {
      const existing = d.occupied.get(cell);
      if (existing !== undefined) {
        const old = d.tiles.get(existing);
        if (isRoadId(id) && old && isRoadId(old.id) && old.id !== id) replaceAnchor = existing; // upgrading/downgrading a road in place
        else return { reason: "occupied" };
      }
      if (!ownsCell(d, cell)) return { reason: "locked_land" };
      if (d.water[cell] && !def.onWater) return { reason: "water" };
      if (def.onWater && !d.water[cell]) return { reason: "needs_water" };
    }
    if (d.cash < def.cost) return { reason: "no_cash" };
    // Anything can be placed without a road: it simply doesn't work (and looks faded) until a road
    // connected to the entrance reaches it and it has power. The one exception is an entrance that
    // faces the edge of the plot, which could never be connected.
    if (!isRoadId(id) && def.needsRoad && accessCells(d.size, def, x, y, rot).length === 0) return { reason: "front_off_map" };
    if (def.moored) {
      let moored = false;
      for (const n of neighbours(d.size, c)) {
        const t = tileAt(d, n);
        if (!d.water[n] || (t && isRoadId(t.id))) {
          moored = true; // land, or a bridge, alongside
          break;
        }
      }
      if (!moored) return { reason: "needs_mooring" };
    }
    if (def.waterRadius > 0) {
      let near = false;
      const [w, h] = footprint(def, rot);
      outer: for (let cy = y - def.waterRadius; cy <= y + h - 1 + def.waterRadius; cy++) {
        for (let cx = x - def.waterRadius; cx <= x + w - 1 + def.waterRadius; cx++) {
          if (inBounds(d.size, cx, cy) && d.water[index(d.size, cx, cy)]) {
            near = true;
            break outer;
          }
        }
      }
      if (!near) return { reason: "needs_water_nearby" };
    }
    if (def.needsWater) {
      let shore = false;
      for (const n of neighbours(d.size, c)) {
        if (d.water[n]) {
          shore = true;
          break;
        }
      }
      if (!shore) return { reason: "needs_shore" };
    }
    return { cells: c, replaceAnchor };
  }

  // -------------------------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------------------------
  place(id: number, x: number, y: number, rot: number): Result<PlaceError> {
    const v = this.validatePlace(id, x, y, rot);
    if (v.reason) return { ok: false, reason: v.reason };
    const d = this.district;
    const def = defById(id);
    const anchors: number[] = [];
    if (v.replaceAnchor !== undefined) {
      const old = removeTile(d, v.replaceAnchor);
      if (old) {
        const oldDef = defById(old.id);
        d.cash += Math.floor(oldDef.cost * oldDef.refundRate);
        anchors.push(v.replaceAnchor);
      }
    }
    d.cash -= def.cost;
    const tile = addTile(d, id, x, y, rot);
    anchors.push(tile.anchor);
    this.refresh("place", { cells: v.cells, anchors }); // the new tile shows active/inactive at once; no income here
    return { ok: true };
  }

  remove(x: number, y: number): { ok: true; removed: Removed } | { ok: false; reason: RemoveError } {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, reason: "bad_args" };
    const d = this.district;
    if (!inBounds(d.size, x, y)) return { ok: false, reason: "out_of_bounds" };
    const anchor = d.occupied.get(index(d.size, x, y));
    if (anchor === undefined) return { ok: false, reason: "empty" };
    const tile = removeTile(d, anchor);
    if (!tile) return { ok: false, reason: "empty" };
    const def = defById(tile.id);
    const refund = Math.floor(def.cost * def.refundRate);
    d.cash += refund;
    if (isRuins(def)) d.counters.ruinsCleared = (d.counters.ruinsCleared ?? 0) + 1;
    d.fx.disabled.delete(anchor);
    d.fx.roadBlocked.delete(anchor);
    d.fx.halfJobs.delete(anchor);
    const c = cells(d.size, def, tile.x, tile.y, tile.rot);
    this.refresh("remove", { cells: c, anchors: [anchor] });
    return { ok: true, removed: { id: tile.id, x: tile.x, y: tile.y, rot: tile.rot, occ: tile.occ, seq: tile.seq, refund, ruins: isRuins(def) } };
  }

  // Undo a demolition: the tile comes back where it was, with its residents and its place in the power
  // queue, and the refund is taken back. Fails if the ground has been built on since, or the refund
  // has been spent.
  restore(r: Removed): Result<RestoreError> {
    const d = this.district;
    const def = defById(r.id);
    const c = cells(d.size, def, r.x, r.y, r.rot);
    if (!c) return { ok: false, reason: "out_of_bounds" };
    for (const cell of c) {
      if (d.occupied.has(cell)) return { ok: false, reason: "occupied" };
      if (!ownsCell(d, cell)) return { ok: false, reason: "locked_land" };
    }
    if (d.cash < r.refund) return { ok: false, reason: "no_cash" };
    d.cash -= r.refund;
    const tile = addTile(d, r.id, r.x, r.y, r.rot, r.occ);
    tile.seq = r.seq;
    if (r.ruins) d.counters.ruinsCleared = Math.max(0, (d.counters.ruinsCleared ?? 0) - 1);
    this.refresh("place", { cells: c, anchors: [tile.anchor] });
    return { ok: true };
  }

  landPriceNow(): number {
    return landPrice(chunkCount(this.district));
  }

  buyLand(cx: number, cy: number): Result<LandError> {
    if (!Number.isInteger(cx) || !Number.isInteger(cy)) return { ok: false, reason: "bad_args" };
    const d = this.district;
    if (!chunkInBounds(d.size, cx, cy)) return { ok: false, reason: "out_of_bounds" };
    const ci = chunkIndex(d.size, cx, cy);
    if (d.chunks.has(ci)) return { ok: false, reason: "already_owned" };
    if (!isBuyable(d, ci)) return { ok: false, reason: "not_adjacent" };
    const price = this.landPriceNow();
    if (d.cash < price) return { ok: false, reason: "no_cash" };
    d.cash -= price;
    d.chunks.add(ci);
    d.dirty = true;
    this.refresh("land");
    return { ok: true };
  }

  rename(name: string): boolean {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > SAVE.MAX_NAME) return false;
    this.district.name = trimmed;
    this.district.dirty = true;
    this.emit({ kind: "rename" });
    return true;
  }

  // Rebirth: a fresh city on the same map with the same name, one more rebirth, more starting cash.
  // Kept for parity with the Roblox game; v1 has no UI for it.
  rebirth(): boolean {
    const d = this.district;
    if (this.report.population < REBIRTH.MIN_POP) return false;
    const fresh = newDistrict(d.size, d.terrain);
    fresh.name = d.name;
    fresh.rebirths = d.rebirths + 1;
    fresh.counters = { ...d.counters };
    fresh.cash = ECONOMY.STARTING_CASH + REBIRTH.START_CASH * fresh.rebirths;
    this.district = fresh;
    this.seedEntrance();
    clearEvents(this.events, fresh);
    this.feed = newFeedState();
    fresh.dirty = true;
    this.refresh("load");
    return true;
  }

  // A burnt building becomes ruins of the same size (or disappears if no ruins size fits).
  private burnDown(anchor: number): number[] {
    const d = this.district;
    const tile = removeTile(d, anchor);
    if (!tile) return [];
    const def = defById(tile.id);
    const [w, h] = footprint(def, tile.rot);
    const ruins = w === h && w <= 3 ? TILE_BY_KEY.get(`ruins_${w}`) : undefined;
    if (ruins) addTile(d, ruins.id, tile.x, tile.y, 0);
    return cells(d.size, def, tile.x, tile.y, tile.rot) ?? [];
  }

  // -------------------------------------------------------------------------------------------
  // The tick: events move, then the city is recomputed with their effects before income is collected.
  // -------------------------------------------------------------------------------------------
  tick(): TickOutput {
    const d = this.district;
    let report = recompute(d, this.entrance);
    const { news, burnt } = stepEvents(this.events, d, report, this.rng);
    const touched: number[] = [];
    const anchors: number[] = [];
    for (const anchor of burnt) {
      touched.push(...this.burnDown(anchor));
      anchors.push(anchor);
    }
    report = recompute(d, this.entrance);
    collect(d, report);
    news.push(...stepGoals(d, report));
    this.report = report;
    this.news = news;
    this.ticks += 1;
    stepFeed(this.feed, d, this.rng);
    this.emit({ kind: "tick", cells: touched.length ? touched : undefined, anchors: anchors.length ? anchors : undefined });
    return { report, news };
  }

  // Offline earnings: income at the saved rate for the ticks missed, no growth and no events.
  // Returns the cash paid.
  payOffline(seconds: number): number {
    const capped = Math.min(Math.max(seconds, 0), SAVE.OFFLINE_CAP_SECONDS);
    if (capped < SAVE.OFFLINE_MIN_SECONDS) return 0;
    const ticks = Math.floor(capped / ECONOMY.TICK_SECONDS);
    const report = recompute(this.district, this.entrance);
    const paid = report.income * ticks;
    if (paid > 0) {
      this.district.cash += paid;
      this.district.dirty = true;
      this.refresh("refresh");
    }
    return paid;
  }

  // -------------------------------------------------------------------------------------------
  // Queries for the UI
  // -------------------------------------------------------------------------------------------
  eventSummary(): EventSummary[] {
    return summarizeEvents(this.events);
  }

  goalSummary(): GoalsSummary {
    return summarizeGoals(this.district, this.report);
  }

  feedLines(): FeedLine[] {
    return this.feed.lines;
  }

  tileAtCell(x: number, y: number): Tile | undefined {
    if (!inBounds(this.district.size, x, y)) return undefined;
    return tileAt(this.district, index(this.district.size, x, y));
  }

  defOf(t: Tile): TileDef {
    return defById(t.id);
  }

  chunkTotal(): number {
    return chunksPerSide(this.district.size) ** 2;
  }

  toBlob(): CityBlob {
    return serialize(this.district);
  }
}

export { defByKey };