// Derives everything from the tile grid. Pure over the District, touches no DOM or Three.js.
// recompute() is safe to call on every placement (no cash, no growth); collect() runs on the tick only.
// Translated from the Roblox Simulation.lua; pass order and numbers are the same.

import { ECONOMY, GROWTH, MOOD, TRAFFIC } from "@/config/tuning";
import { defById, isRoadId, type ServiceName, type TileDef } from "./tileDefs";
import {
  accessCells, cells, footprint, neighbours, rebirthBonus, type District, type Tile,
} from "./district";

export const SERVICES: readonly ServiceName[] = ["police", "health", "school", "fire", "fun"];

export interface ServiceInfo {
  buildings: number;
  full: number;
  served: number;
  capacity: number;
}

export interface Report {
  population: number; // residents right now
  capacity: number; // residents if every house were full
  unpowered: number; // residents in houses without power
  jobs: number;
  employed: number;
  powerGen: number;
  powerUse: number;
  brownout: boolean;
  happiness: number; // 0..10: resident-weighted share of everything that could make a house happy
  income: number; // what the next collect() will add
  bonus: number; // income multiplier bonus from working landmarks (0.15 = +15%)
  coverage: Record<string, number>; // share of home capacity (0..1): police, health, school, fire, fun, park, power, water, traffic
  traffic: { trips: number; roads: number; jammed: number; blockedResidents: number };
  services: Record<ServiceName, ServiceInfo>;
  unguardedWork: number; // workplaces with no police station within reach (what crime waves target)
  rebirths: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------
export function box(t: Tile, def: TileDef, r: number): Box {
  const [w, h] = footprint(def, t.rot);
  return { x0: t.x - r, y0: t.y - r, x1: t.x + w - 1 + r, y1: t.y + h - 1 + r };
}

function overlaps(t: Tile, def: TileDef, b: Box): boolean {
  const [w, h] = footprint(def, t.rot);
  return t.x <= b.x1 && t.x + w - 1 >= b.x0 && t.y <= b.y1 && t.y + h - 1 >= b.y0;
}

function anyOverlap(t: Tile, def: TileDef, boxes: readonly Box[]): boolean {
  for (const b of boxes) if (overlaps(t, def, b)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------------------------
function isRoadTile(t: Tile): boolean {
  return isRoadId(t.id);
}

// BFS from the entrance over road tiles (any tier). Sets reachable / dist / parent and resets the
// per-tick traffic fields. Roads are 1x1, so cell index == anchor index. Returns the reachable road
// cells in BFS order (ascending dist).
function mapRoads(d: District, entrance: readonly number[]): number[] {
  for (const t of d.tiles.values()) {
    t.reachable = false;
    t.dist = Infinity;
    t.parent = undefined;
    t.access = undefined;
    t.load = 0;
    t.jammed = false;
    t.blocked = false;
  }
  const order: number[] = [];
  const queue: number[] = [];
  let head = 0;
  for (const c of entrance) {
    const t = d.tiles.get(c);
    if (t && isRoadTile(t) && !t.reachable) {
      t.reachable = true;
      t.dist = 0;
      queue.push(c);
    }
  }
  while (head < queue.length) {
    const c = queue[head++];
    order.push(c);
    const t = d.tiles.get(c)!;
    for (const n of neighbours(d.size, [c])) {
      const nt = d.tiles.get(n);
      if (nt && isRoadTile(nt) && !nt.reachable) {
        nt.reachable = true;
        nt.dist = t.dist + 1;
        nt.parent = c;
        queue.push(n);
      }
    }
  }
  return order;
}

// The reachable road next to a building with the fewest hops to the entrance, or undefined.
function accessRoad(d: District, t: Tile): number | undefined {
  const def = defById(t.id);
  let best: number | undefined;
  let bestDist = Infinity;
  for (const n of accessCells(d.size, def, t.x, t.y, t.rot)) {
    const nt = d.tiles.get(n);
    if (nt && isRoadTile(nt) && nt.reachable && nt.dist < bestDist) {
      best = n;
      bestDist = nt.dist;
    }
  }
  return best;
}

function isBlocked(d: District, t: Tile): boolean {
  if (t.access === undefined) return false;
  const road = d.tiles.get(t.access);
  return road !== undefined && road.blocked;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------------------------
// Sets active / powered / mood / needs / growthDelta / traffic on every tile and returns the report.
// Does not change cash or residents.
export function recompute(d: District, entrance: readonly number[]): Report {
  const roadOrder = mapRoads(d, entrance);
  const fx = d.fx;

  // Pass 1: road access. Generators come online here; consumers are queued for the power pass.
  const consumers: Tile[] = [];
  let powerGen = 0;
  for (const t of d.tiles.values()) {
    const def = defById(t.id);
    t.powered = !def.needsPower;
    t.needs = [];
    t.event = undefined;
    if (isRoadTile(t)) {
      t.active = t.reachable;
    } else {
      if (def.needsRoad) {
        t.access = accessRoad(d, t);
        t.active = t.access !== undefined;
        if (t.active && def.needsBigRoad) {
          const road = d.tiles.get(t.access!);
          if (!road || defById(road.id).roadCapacity < TRAFFIC.BIG_ROAD_CAPACITY) {
            t.active = false;
            t.needs.push("avenue");
          }
        }
      } else {
        t.active = true;
        t.access = accessRoad(d, t); // parks and the like may still sit by a road
      }
      if (t.active) {
        powerGen += def.powerGen;
        if (def.needsPower) consumers.push(t);
      }
    }
    if (!t.active && !t.needs.includes("avenue")) t.needs.push("road");
    // events: a building on fire, in a storm or in a blackout isn't working, whatever else is true
    const why = fx.disabled.get(t.anchor);
    if (why) {
      t.event = why;
      t.needs.push(why);
      if (t.active && !isRoadTile(t)) powerGen -= def.powerGen;
      t.active = false;
    } else if (fx.halfJobs.has(t.anchor)) {
      t.event = "crime";
      t.needs.push("crime");
    } else if (isRoadTile(t) && fx.roadBlocked.has(t.anchor)) {
      t.event = "crash";
      t.needs.push("crash");
    }
  }

  // Pass 2: power budget. Oldest placements keep power; newest lose it first.
  consumers.sort((a, b) => a.seq - b.seq);
  let powerUse = 0;
  let brownout = false;
  for (const t of consumers) {
    const use = defById(t.id).powerUse;
    if (powerUse + use <= powerGen) {
      powerUse += use;
      t.powered = true;
    } else {
      t.powered = false;
      brownout = true;
      t.needs.push("power");
    }
  }

  // Pass 3: traffic. Trips land on each building's access road, then flow down the parent chain.
  let trips = 0;
  for (const t of d.tiles.values()) {
    const def = defById(t.id);
    if (t.active && t.access !== undefined && !isRoadTile(t)) {
      const people = def.population > 0 ? t.occ : t.powered ? def.jobs : 0;
      const n = Math.ceil(people / TRAFFIC.PEOPLE_PER_TRIP);
      if (n > 0) {
        d.tiles.get(t.access)!.load += n;
        trips += n;
      }
    }
  }
  for (let i = roadOrder.length - 1; i >= 0; i--) {
    // leaves first, so each tile is complete before it feeds its parent
    const t = d.tiles.get(roadOrder[i])!;
    if (t.parent !== undefined) d.tiles.get(t.parent)!.load += t.load;
  }
  let jammedRoads = 0;
  for (const c of roadOrder) {
    // entrance first, so a parent's blocked flag is final before its children
    const t = d.tiles.get(c)!;
    t.jammed = t.load > defById(t.id).roadCapacity || fx.roadBlocked.has(t.anchor);
    const parentBlocked = t.parent !== undefined && d.tiles.get(t.parent)!.blocked;
    t.blocked = t.jammed || parentBlocked;
    if (t.jammed) jammedRoads += 1; // no "needs" entry: the road's tint and the inspect panel show it
  }

  // Pass 3b: parking. Car parks serve big venues within their reach; a venue without one doesn't operate.
  const parkingBoxes: Box[] = [];
  for (const t of d.tiles.values()) {
    const def = defById(t.id);
    if (def.parking && t.active && t.powered) parkingBoxes.push(box(t, def, def.radius));
  }
  // working buildings other buildings depend on (tech campus -> university), as reach boxes by key
  const nearBoxes = new Map<string, Box[]>();
  for (const t of d.tiles.values()) {
    const def = defById(t.id);
    if (def.needsNearKey && !nearBoxes.has(def.needsNearKey)) nearBoxes.set(def.needsNearKey, []);
  }
  for (const [key, list] of nearBoxes) {
    for (const t of d.tiles.values()) {
      const def = defById(t.id);
      if (def.key === key && t.active && t.powered) list.push(box(t, def, 0));
    }
  }
  const operating = (t: Tile, def: TileDef): boolean => {
    if (!(t.active && t.powered)) return false;
    if (def.needsParking && !anyOverlap(t, def, parkingBoxes)) {
      t.needs.push("parking");
      return false;
    }
    if (def.needsNearKey) {
      let found = false;
      const grown = box(t, def, def.needsNearRadius);
      for (const b of nearBoxes.get(def.needsNearKey) ?? []) {
        if (grown.x0 <= b.x1 && grown.x1 >= b.x0 && grown.y0 <= b.y1 && grown.y1 >= b.y0) {
          found = true;
          break;
        }
      }
      if (!found) {
        t.needs.push(def.needsNearKey);
        return false;
      }
    }
    return true;
  };

  // Pass 4: what working buildings radiate: service coverage, pollution, parks; and jobs.
  // A service entry carries its remaining capacity; houses are served nearest-first (placement order).
  interface Service { box: Box; remaining: number; tile: Tile }
  const coverage = {} as Record<ServiceName, Service[]>;
  for (const name of SERVICES) coverage[name] = [];
  const polluters: { box: Box; amount: number }[] = [];
  const cleaners: { box: Box; amount: number }[] = [];
  const amenities: Box[] = [];
  let jobs = 0;
  let residentsNow = 0;
  let bonus = 0;
  for (const t of d.tiles.values()) {
    const def = defById(t.id);
    if (def.population > 0 && !def.retired) residentsNow += t.occ;
    t.served = 0;
    if (operating(t, def)) {
      bonus += def.incomeBonus;
      if (def.jobs > 0) {
        if (fx.halfJobs.has(t.anchor)) {
          jobs += Math.ceil(def.jobs * 0.5);
        } else if (isBlocked(d, t)) {
          jobs += Math.ceil(def.jobs * TRAFFIC.JAM_JOBS_FACTOR);
          t.needs.push("traffic");
        } else {
          jobs += def.jobs;
        }
      }
      if (def.service) {
        let cap = def.capacity > 0 ? def.capacity : Infinity;
        if (def.service === "fun") cap *= fx.funMult;
        coverage[def.service].push({ box: box(t, def, def.radius), remaining: cap, tile: t });
      }
      if (def.amenity) amenities.push(box(t, def, def.radius > 0 ? def.radius : MOOD.AMENITY_RADIUS));
      if (def.pollution > 0) polluters.push({ box: box(t, def, MOOD.POLLUTION_RADIUS), amount: def.pollution });
      if (def.cleans > 0) cleaners.push({ box: box(t, def, def.radius > 0 ? def.radius : MOOD.AMENITY_RADIUS), amount: def.cleans });
    }
  }
  const unemployed = residentsNow > jobs;

  // Pass 5: every house gets a mood and a growth direction. Houses are visited in placement order so
  // service capacity is handed out deterministically.
  let population = 0;
  let capacity = 0;
  let unpowered = 0;
  let payingFull = 0;
  let payingHalf = 0;
  let blockedResidents = 0;
  let blockedCapacity = 0;
  let happySum = 0; // sum over residents of (score above the base), before clamping
  const HAPPY_RANGE = MOOD.POWER + SERVICES.length * MOOD.PER_SERVICE + MOOD.PARK + MOOD.WATERFRONT; // the most a house can gain
  const covered: Record<string, number> = { police: 0, health: 0, school: 0, fire: 0, fun: 0, park: 0, power: 0, water: 0 };
  const homes: Tile[] = [];
  for (const t of d.tiles.values()) if (defById(t.id).population > 0) homes.push(t);
  homes.sort((a, b) => a.seq - b.seq);
  // the first in-range service with room for at least half of this house's residents; takes what fits.
  // Returns how many residents it served (-1 = not covered).
  const serve = (name: ServiceName, t: Tile, def: TileDef): number => {
    if (t.occ === 0) {
      for (const svc of coverage[name]) if (overlaps(t, def, svc.box)) return 0; // in range, nothing to serve yet
      return -1;
    }
    for (const svc of coverage[name]) {
      const take = Math.min(svc.remaining, t.occ);
      if (take * 2 >= t.occ && overlaps(t, def, svc.box)) {
        svc.remaining -= take;
        svc.tile.served += take;
        return take;
      }
    }
    return -1;
  };
  for (const t of homes) {
    const def = defById(t.id);
    capacity += def.population;
    population += t.occ;
    if (!t.active) {
      t.mood = 0;
      t.growthDelta = GROWTH.NO_ROAD_SHRINK;
    } else {
      let mood = MOOD.BASE;
      if (t.powered) mood += MOOD.POWER;
      let coveredCount = 0;
      for (const name of SERVICES) {
        const got = serve(name, t, def);
        if (got >= 0) {
          mood += MOOD.PER_SERVICE;
          coveredCount += 1;
          covered[name] += def.population; // shares are by home capacity, so empty homes count
        } else {
          t.needs.push(name);
        }
      }
      let pollution = 0;
      for (const p of polluters) if (overlaps(t, def, p.box)) pollution += p.amount;
      if (pollution > 0) {
        // greenery in reach cancels pollution
        for (const c of cleaners) if (overlaps(t, def, c.box)) pollution -= c.amount;
      }
      if (pollution > 0) {
        mood -= Math.min(pollution, MOOD.MAX_POLLUTION_PENALTY);
        t.needs.push("clean air");
      }
      const hasPark = anyOverlap(t, def, amenities);
      if (hasPark) {
        mood += MOOD.PARK;
        covered.park += def.population;
      }
      // waterfront: a house touching water is a nicer place to live
      let waterfront = false;
      for (const n of neighbours(d.size, cells(d.size, def, t.x, t.y, t.rot)!)) {
        if (d.water[n]) {
          waterfront = true;
          mood += MOOD.WATERFRONT;
          covered.water += def.population;
          break;
        }
      }
      if (def.needsAmenity && !hasPark && !waterfront) t.needs.push("park");
      if (unemployed && !def.retired) {
        mood += MOOD.UNEMPLOYED;
        t.needs.push("jobs");
      }
      if (isBlocked(d, t)) {
        mood += MOOD.JAMMED;
        blockedResidents += t.occ;
        blockedCapacity += def.population;
        t.needs.push("traffic");
      }
      happySum += clamp(mood - MOOD.BASE, 0, HAPPY_RANGE) * t.occ;
      t.mood = clamp(mood, 0, 10);
      let missingRequired = false;
      if (def.requires) for (const name of def.requires) if (t.needs.includes(name)) missingRequired = true;
      if ((def.needsServices && coveredCount < SERVICES.length) || missingRequired || (def.needsAmenity && !hasPark && !waterfront)) {
        t.growthDelta = GROWTH.NO_SERVICES_SHRINK;
      } else {
        t.growthDelta = (t.mood - MOOD.BASE) * (t.mood > MOOD.BASE ? fx.growthMult : 1);
      }
      if (t.powered) {
        payingFull += t.occ * def.taxMult;
        covered.power += def.population;
      } else {
        unpowered += t.occ;
        payingHalf += t.occ * def.taxMult;
      }
    }
  }

  // Pass 6: economy.
  const employed = Math.min(population, jobs);
  const happiness = population > 0 ? (happySum / population / HAPPY_RANGE) * 10 : 5;
  bonus = Math.min(bonus, ECONOMY.MAX_LANDMARK_BONUS);
  const mult = (0.6 + happiness / 10) * (1 + bonus) * (1 + rebirthBonus(d)) * fx.incomeMult; // 4/10 -> x1, 10/10 -> x1.6
  const income =
    ECONOMY.BASE_INCOME +
    Math.floor((payingFull * ECONOMY.TAX_PER_CITIZEN + payingHalf * ECONOMY.TAX_PER_CITIZEN * ECONOMY.UNPOWERED_TAX + employed * ECONOMY.TAX_PER_WORKER) * mult);

  // workplaces outside police reach: crime waves pick from these
  const policeBoxes = coverage.police.map((s) => s.box);
  let unguardedWork = 0;
  for (const t of d.tiles.values()) {
    const def = defById(t.id);
    if (def.jobs > 0 && def.population === 0 && !def.service && t.active && !anyOverlap(t, def, policeBoxes)) unguardedWork += 1;
  }

  // per-service summary: how many buildings exist, how many are at capacity
  const services = {} as Record<ServiceName, ServiceInfo>;
  for (const name of SERVICES) {
    const info: ServiceInfo = { buildings: 0, full: 0, served: 0, capacity: 0 };
    for (const svc of coverage[name]) {
      const cap = defById(svc.tile.id).capacity;
      info.buildings += 1;
      info.served += svc.tile.served;
      info.capacity += cap;
      if (cap > 0 && svc.remaining <= 0) info.full += 1;
    }
    services[name] = info;
  }

  const shares: Record<string, number> = {};
  for (const [name, n] of Object.entries(covered)) shares[name] = capacity > 0 ? n / capacity : 0;
  shares.traffic = capacity > 0 ? 1 - blockedCapacity / capacity : 1;

  return {
    population, capacity, unpowered, jobs, employed, powerGen, powerUse, brownout, happiness, income, bonus,
    coverage: shares,
    traffic: { trips, roads: roadOrder.length, jammed: jammedRoads, blockedResidents },
    services, unguardedWork,
    rebirths: d.rebirths,
  };
}

// Applies the tick: cash, and residents moving in or out based on the last recompute.
// Updates report.population so what the UI sees matches the new resident counts.
export function collect(d: District, report: Report): void {
  if (report.income > 0) {
    d.cash += report.income;
    d.dirty = true;
  }
  let population = 0;
  for (const t of d.tiles.values()) {
    const def = defById(t.id);
    if (def.population > 0) {
      t.growth += t.growthDelta;
      if (t.growth >= GROWTH.THRESHOLD) {
        t.growth = 0;
        if (t.occ < def.population) {
          t.occ += 1;
          d.dirty = true;
        }
      } else if (t.growth <= -GROWTH.THRESHOLD) {
        t.growth = 0;
        if (t.occ > 0) {
          t.occ -= 1;
          d.dirty = true;
        }
      }
      population += t.occ;
    }
  }
  report.population = population;
}
