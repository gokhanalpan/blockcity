// Things that happen to a city on their own. Each tick step() may start one event, advances the
// active ones, and writes their effects into d.fx for the next recompute(). Events are runtime only;
// the one lasting consequence, a building burning down, is a normal "ruins" tile in the save.
// Translated from the Roblox Events.lua. The random source is injectable so tests are deterministic.
//
// Kinds:
//   fire      a building burns; a working fire station within reach puts it out, otherwise it becomes ruins
//   blackout  a fuel-burning generator or plant goes offline for a while (wind/solar/offshore never fail)
//   crash     a busy road cell is blocked for a while (avenues and highways clear faster)
//   storm     floating buildings stop unless a working lighthouse is within reach
//   crime     workplaces outside police reach offer half their jobs until a station covers them
//   festival  (good) the stadium or ferris wheel doubles fun and lifts income
//   rush      (good) homes fill three times faster for a while

import { EVENTS } from "@/config/tuning";
import { defById, defByKey, isRoadId, isRuins } from "./tileDefs";
import { footprint, newEffects, type District, type Tile } from "./district";
import type { Report } from "./simulation";

export type EventKind = "fire" | "blackout" | "crash" | "storm" | "crime" | "festival" | "rush";

export interface GameEvent {
  id: number;
  kind: EventKind;
  anchor?: number; // the tile it's about (fire, blackout, crash, crime centre)
  cells?: number[]; // affected anchors (storm, crime)
  ticksLeft: number;
  label: string; // short text for the HUD
  fighting?: boolean; // fire: a working fire station in reach is putting it out
}

export interface News {
  text: string;
  good: boolean;
  anchor?: number; // the tile this is about, so the UI can jump to it
}

export interface EventsState {
  events: GameEvent[];
  cooldown: number;
  nextId: number;
}

export type Rng = () => number; // [0, 1)

export function newEventsState(): EventsState {
  return { events: [], cooldown: EVENTS.FIRST_COOLDOWN_TICKS, nextId: 1 };
}

export function clearEvents(st: EventsState, d: District): void {
  st.events = [];
  st.cooldown = EVENTS.FIRST_COOLDOWN_TICKS;
  d.fx = newEffects();
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
function within(t: Tile, other: Tile, radius: number): boolean {
  const def = defById(t.id);
  const odef = defById(other.id);
  const [ow, oh] = footprint(odef, other.rot);
  const [w, h] = footprint(def, t.rot);
  // other's box grown by radius must overlap t's footprint
  return t.x < other.x + ow + radius && t.x + w > other.x - radius && t.y < other.y + oh + radius && t.y + h > other.y - radius;
}

function anyWorking(d: District, key: string, near: Tile, radius: number): boolean {
  for (const t of d.tiles.values()) {
    if (defById(t.id).key === key && t.active && t.powered && !d.fx.disabled.has(t.anchor) && within(near, t, radius)) return true;
  }
  return false;
}

function pick(rng: Rng, list: Tile[], weight?: (t: Tile) => number): Tile | undefined {
  if (list.length === 0) return undefined;
  if (!weight) return list[Math.floor(rng() * list.length)];
  let total = 0;
  for (const t of list) total += weight(t);
  if (total <= 0) return undefined;
  let r = rng() * total;
  for (const t of list) {
    r -= weight(t);
    if (r <= 0) return t;
  }
  return list[list.length - 1];
}

function has(d: District, keys: readonly string[]): boolean {
  for (const t of d.tiles.values()) if (keys.includes(defById(t.id).key)) return true;
  return false;
}

function busy(st: EventsState, kind: EventKind, anchor?: number): boolean {
  for (const e of st.events) if (e.kind === kind && (anchor === undefined || e.anchor === anchor)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// starting events
// ---------------------------------------------------------------------------------------------
const FUEL = new Set(["generator", "power_plant", "nuclear_plant", "oil_platform"]);

type Starter = (d: District, st: EventsState, report: Report | undefined, rng: Rng) => GameEvent | undefined;

const starters: Record<EventKind, Starter> = {
  fire: (d, _st, _report, rng) => {
    const candidates: Tile[] = [];
    for (const t of d.tiles.values()) {
      const def = defById(t.id);
      if (
        t.active && !isRoadId(t.id) && !def.onWater && def.roadCapacity === 0 && !def.amenity && !isRuins(def) &&
        !d.fx.disabled.has(t.anchor) && (def.population > 0 || def.jobs > 0 || def.powerGen > 0)
      ) candidates.push(t);
    }
    const t = pick(rng, candidates, (c) => {
      const def = defById(c.id);
      return def.pollution >= 2 ? EVENTS.FIRE_WEIGHT.polluter : def.powerGen > 0 ? EVENTS.FIRE_WEIGHT.generator : EVENTS.FIRE_WEIGHT.other;
    });
    if (!t) return undefined;
    d.fx.disabled.set(t.anchor, "burning");
    return { id: 0, kind: "fire", anchor: t.anchor, ticksLeft: EVENTS.FIRE_TICKS, label: `Fire at the ${defById(t.id).name}` };
  },

  blackout: (d, _st, _report, rng) => {
    const candidates: Tile[] = [];
    for (const t of d.tiles.values()) {
      if (FUEL.has(defById(t.id).key) && t.active && !d.fx.disabled.has(t.anchor)) candidates.push(t);
    }
    const t = pick(rng, candidates);
    if (!t) return undefined;
    d.fx.disabled.set(t.anchor, "blackout");
    return { id: 0, kind: "blackout", anchor: t.anchor, ticksLeft: EVENTS.BLACKOUT_TICKS, label: `${defById(t.id).name} broke down` };
  },

  crash: (d, _st, _report, rng) => {
    const candidates: Tile[] = [];
    for (const t of d.tiles.values()) {
      if (isRoadId(t.id) && t.reachable && t.load > 0 && !d.fx.roadBlocked.has(t.anchor)) candidates.push(t);
    }
    const t = pick(rng, candidates, (c) => Math.max(c.load, 1));
    if (!t) return undefined;
    const cap = defById(t.id).roadCapacity;
    const ticks = cap >= 800 ? EVENTS.CRASH_TICKS.highway : cap >= 240 ? EVENTS.CRASH_TICKS.avenue : EVENTS.CRASH_TICKS.road;
    d.fx.roadBlocked.add(t.anchor);
    return { id: 0, kind: "crash", anchor: t.anchor, ticksLeft: ticks, label: `Crash on the ${defById(t.id).name}` };
  },

  storm: (d) => {
    const cells: number[] = [];
    const lighthouseRadius = defByKey("lighthouse").radius;
    for (const t of d.tiles.values()) {
      const def = defById(t.id);
      if (def.onWater && def.roadCapacity === 0 && !d.fx.disabled.has(t.anchor)) {
        if (!anyWorking(d, "lighthouse", t, lighthouseRadius)) {
          cells.push(t.anchor);
          d.fx.disabled.set(t.anchor, "storm");
        }
      }
    }
    if (cells.length === 0) {
      // every floating building had a lighthouse: the storm passes harmlessly
      let any = false;
      for (const t of d.tiles.values()) {
        const def = defById(t.id);
        if (def.onWater && def.roadCapacity === 0) {
          any = true;
          break;
        }
      }
      if (any) {
        d.counters.stormsSurvived = (d.counters.stormsSurvived ?? 0) + 1;
        d.dirty = true;
        return { id: 0, kind: "storm", cells: [], ticksLeft: EVENTS.STORM_PASSED_TICKS, label: "A storm passed; the lighthouses kept everything running" };
      }
      return undefined;
    }
    return { id: 0, kind: "storm", cells, ticksLeft: EVENTS.STORM_TICKS, label: `Storm: ${cells.length} floating buildings stopped` };
  },

  crime: (d, _st, _report, rng) => {
    const uncovered: Tile[] = [];
    const policeRadius = defByKey("police").radius;
    for (const t of d.tiles.values()) {
      const def = defById(t.id);
      if (def.jobs > 0 && t.active && def.population === 0 && !def.service && !anyWorking(d, "police", t, policeRadius)) uncovered.push(t);
    }
    const centre = pick(rng, uncovered);
    if (!centre) return undefined;
    const cells: number[] = [];
    for (const t of uncovered) {
      if (within(centre, t, EVENTS.CRIME_RADIUS)) {
        cells.push(t.anchor);
        d.fx.halfJobs.add(t.anchor);
      }
    }
    return { id: 0, kind: "crime", anchor: centre.anchor, cells, ticksLeft: EVENTS.CRIME_MAX_TICKS, label: `Crime wave: ${cells.length} workplaces hit` };
  },

  festival: (d) => {
    if (!has(d, ["stadium", "ferris_wheel"])) return undefined;
    d.fx.funMult = EVENTS.FESTIVAL_FUN_MULT;
    d.fx.incomeMult = EVENTS.FESTIVAL_INCOME_MULT;
    return { id: 0, kind: "festival", ticksLeft: EVENTS.FESTIVAL_TICKS, label: "Festival! Double fun, +50% income" };
  },

  rush: (d, _st, report) => {
    if (!report || report.capacity - report.population < EVENTS.RUSH_MIN_FREE_CAPACITY) return undefined;
    d.fx.growthMult = EVENTS.RUSH_GROWTH_MULT;
    return { id: 0, kind: "rush", ticksLeft: EVENTS.RUSH_TICKS, label: "Housing rush: families are moving in" };
  },
};

const GOOD: ReadonlySet<EventKind> = new Set(["festival", "rush"]);

// ---------------------------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------------------------
export interface StepResult {
  news: News[];
  burnt: number[]; // anchors of buildings that burnt down (the caller replaces them with ruins)
}

// Advances events by one tick. `report` is the last simulation report.
export function stepEvents(st: EventsState, d: District, report: Report | undefined, rng: Rng = Math.random): StepResult {
  const news: News[] = [];
  const burnt: number[] = [];
  const fireRadius = defByKey("fire_station").radius;
  const policeRadius = defByKey("police").radius;

  // advance active events
  for (let i = st.events.length - 1; i >= 0; i--) {
    const e = st.events[i];
    e.ticksLeft -= 1;
    let done = false;
    switch (e.kind) {
      case "fire": {
        const t = e.anchor !== undefined ? d.tiles.get(e.anchor) : undefined;
        if (!t) {
          done = true;
        } else if (anyWorking(d, "fire_station", t, fireRadius)) {
          // being fought: finishes after FIRE_FIGHT_TICKS no matter when the station arrived
          e.fighting = true;
          e.ticksLeft = Math.min(e.ticksLeft, EVENTS.FIRE_FIGHT_TICKS);
          if (e.ticksLeft <= 0) {
            d.fx.disabled.delete(t.anchor);
            d.counters.firesFought = (d.counters.firesFought ?? 0) + 1;
            d.dirty = true;
            news.push({ text: `The fire station put out the fire at the ${defById(t.id).name}`, good: true, anchor: t.anchor });
            done = true;
          }
        } else if (e.ticksLeft <= 0) {
          d.fx.disabled.delete(t.anchor);
          burnt.push(t.anchor);
          news.push({ text: `The ${defById(t.id).name} burnt down. Clear the ruins for free`, good: false, anchor: t.anchor });
          done = true;
        }
        break;
      }
      case "blackout": {
        if (e.ticksLeft <= 0 || e.anchor === undefined || !d.tiles.has(e.anchor)) {
          if (e.anchor !== undefined) d.fx.disabled.delete(e.anchor);
          news.push({ text: "Power is back", good: true, anchor: e.anchor });
          done = true;
        }
        break;
      }
      case "crash": {
        if (e.ticksLeft <= 0 || e.anchor === undefined || !d.tiles.has(e.anchor)) {
          if (e.anchor !== undefined) d.fx.roadBlocked.delete(e.anchor);
          news.push({ text: "The road is clear again", good: true, anchor: e.anchor });
          done = true;
        }
        break;
      }
      case "storm": {
        if (e.ticksLeft <= 0) {
          for (const a of e.cells ?? []) if (d.fx.disabled.get(a) === "storm") d.fx.disabled.delete(a);
          news.push({ text: "The storm has passed", good: true });
          done = true;
        }
        break;
      }
      case "crime": {
        // each affected workplace is freed once a police station covers it
        const remaining: number[] = [];
        for (const a of e.cells ?? []) {
          const t = d.tiles.get(a);
          if (t && e.ticksLeft > 0 && !anyWorking(d, "police", t, policeRadius)) remaining.push(a);
          else d.fx.halfJobs.delete(a);
        }
        e.cells = remaining;
        if (remaining.length === 0) {
          news.push({ text: "The police ended the crime wave", good: true, anchor: e.anchor });
          done = true;
        }
        break;
      }
      case "festival": {
        if (e.ticksLeft <= 0) {
          d.fx.funMult = 1;
          d.fx.incomeMult = 1;
          news.push({ text: "The festival is over", good: true });
          done = true;
        }
        break;
      }
      case "rush": {
        if (e.ticksLeft <= 0) {
          d.fx.growthMult = 1;
          done = true;
        }
        break;
      }
    }
    if (done) st.events.splice(i, 1);
  }

  // maybe start one
  st.cooldown -= 1;
  if (st.cooldown <= 0 && st.events.length < EVENTS.MAX_ACTIVE && report) {
    const pop = report.population;
    // roughly one event every 1-2 minutes once the city has a few hundred residents
    const chance = Math.min(EVENTS.CHANCE_BASE + pop / EVENTS.CHANCE_POP_DIV, EVENTS.CHANCE_MAX);
    if (pop >= EVENTS.MIN_POP && rng() < chance) {
      const order = (Object.keys(EVENTS.WEIGHTS) as EventKind[]).map((kind) => ({ kind, w: EVENTS.WEIGHTS[kind] as number }));
      let total = 0;
      for (const o of order) total += o.w;
      // try kinds in weighted-random order until one applies
      while (order.length > 0) {
        let r = rng() * total;
        let idx = order.length - 1;
        for (let i = 0; i < order.length; i++) {
          r -= order[i].w;
          if (r <= 0) {
            idx = i;
            break;
          }
        }
        const [choice] = order.splice(idx, 1);
        total -= choice.w;
        if (!busy(st, choice.kind)) {
          const e = starters[choice.kind](d, st, report, rng);
          if (e) {
            e.id = st.nextId++;
            st.events.push(e);
            news.push({ text: e.label, good: GOOD.has(choice.kind), anchor: e.anchor ?? e.cells?.[0] });
            st.cooldown = EVENTS.COOLDOWN_TICKS;
            break;
          }
        }
      }
    }
  }

  return { news, burnt };
}

// Force-start an event of a kind (debug / tests). Returns the event or undefined if it can't apply.
export function startEvent(st: EventsState, d: District, kind: EventKind, report: Report | undefined, rng: Rng = Math.random): GameEvent | undefined {
  if (busy(st, kind)) return undefined;
  const e = starters[kind](d, st, report, rng);
  if (!e) return undefined;
  e.id = st.nextId++;
  st.events.push(e);
  return e;
}

export interface EventSummary {
  kind: EventKind;
  anchor?: number;
  ticksLeft: number;
  label: string;
  fighting: boolean;
}

// A compact list for the HUD.
export function summarizeEvents(st: EventsState): EventSummary[] {
  return st.events.map((e) => ({ kind: e.kind, anchor: e.anchor, ticksLeft: e.ticksLeft, label: e.label, fighting: e.fighting === true }));
}