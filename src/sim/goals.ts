// Three live goals per city, drawn in order from a fixed list, each with a cash reward. Progress is
// measured from the district and the last report every tick; completed keys are saved with the city
// (district.goalsDone) so a goal is only ever paid once. Translated from the Roblox Goals.lua.

import { GOALS } from "@/config/tuning";
import { defById } from "./tileDefs";
import { chunkCount, type District } from "./district";
import type { Report } from "./simulation";
import type { News } from "./events";

export interface Goal {
  key: string;
  text: string;
  reward: number;
  // returns [progress, target]; complete when progress >= target
  check: (d: District, r: Report | undefined) => [number, number];
}

function count(d: District, key: string): number {
  let n = 0;
  for (const t of d.tiles.values()) if (defById(t.id).key === key) n += 1;
  return n;
}

const pop = (r: Report | undefined): number => r?.population ?? 0;
const share = (r: Report | undefined, name: string): number => r?.coverage?.[name] ?? 0;
const counter = (d: District, name: string): number => d.counters[name] ?? 0;

function goal(key: string, text: string, reward: number, check: Goal["check"]): Goal {
  return { key, text, reward, check };
}

function built(key: string, label: string, reward: number, n?: number): Goal {
  const target = n ?? 1;
  return goal(
    target > 1 ? `${key}_${target}` : key,
    target > 1 ? `Build ${target} ${label}` : `Build a ${label}`,
    reward,
    (d) => [count(d, key), target],
  );
}

function residents(n: number, reward: number): Goal {
  return goal(`pop_${n}`, `Reach ${n} residents`, reward, (_d, r) => [pop(r), n]);
}

function coverage(name: string, label: string, percent: number, reward: number, minPop: number): Goal {
  return goal(`${name}_${percent}`, `${label} at ${percent}% with ${minPop}+ residents`, reward, (_d, r) => {
    if (pop(r) < minPop) return [0, 1];
    return [Math.floor(share(r, name) * 100), percent];
  });
}

// In order: the first three unfinished ones are the live board.
export const GOAL_LIST: readonly Goal[] = [
  residents(10, 500),
  built("shop", "shop", 400),
  goal("powered", "Power the city: a generator, turbine or solar farm", 600, (_d, r) => [r && r.powerGen > 0 ? 1 : 0, 1]),
  built("park", "park", 400),
  residents(50, 1000),
  built("police", "police station", 800),
  built("clinic", "clinic", 800),
  built("school", "school", 800),
  built("fire_station", "fire station", 800),
  goal("land_4", "Own 4 chunks of land", 1500, (d) => [chunkCount(d), 4]),
  built("avenue", "avenue", 800),
  residents(150, 3000),
  goal("jobs_all", "Jobs for everyone (100+ residents)", 3000, (_d, r) => {
    if (pop(r) < 100) return [0, 1];
    return [Math.min(r!.jobs, pop(r)), pop(r)];
  }),
  coverage("police", "Safety", 80, 2500, 100),
  coverage("health", "Health", 80, 2500, 100),
  coverage("school", "Education", 80, 2500, 100),
  built("playground", "playground", 600),
  built("townhouse", "townhouses", 1500, 3),
  goal("happy_7", "Happiness 7+ with 150+ residents", 4000, (_d, r) => {
    if (pop(r) < 150) return [0, 1];
    return [Math.floor((r?.happiness ?? 0) * 10), 70];
  }),
  goal("land_10", "Own 10 chunks of land", 4000, (d) => [chunkCount(d), 10]),
  residents(300, 6000),
  built("apartment", "apartments", 3000, 3),
  built("cinema", "cinema", 1500),
  coverage("fire", "Fire cover", 80, 3000, 200),
  built("pier", "pier", 800),
  built("wind_turbine", "wind turbines", 2000, 4),
  built("highway", "highway", 1500),
  built("car_park", "car park", 1000),
  built("stadium", "stadium", 10000),
  goal("fire_fought", "Put out a fire with a fire station", 5000, (d) => [counter(d, "firesFought"), 1]),
  residents(500, 12000),
  built("tower", "towers", 8000, 3),
  built("marina", "marina", 4000),
  built("beach_club", "beach club", 3000),
  goal("water_25", "25% of homes by the water", 6000, (_d, r) => [Math.floor(share(r, "water") * 100), 25]),
  built("ferris_wheel", "ferris wheel", 5000),
  built("zoo", "zoo", 8000),
  built("mall", "mall", 6000),
  goal("land_20", "Own 20 chunks of land", 10000, (d) => [chunkCount(d), 20]),
  built("hospital", "hospital", 12000),
  built("airport", "airport", 25000),
  residents(800, 20000),
  built("houseboat", "houseboats", 3000, 4),
  built("lighthouse", "lighthouse", 2000),
  goal("storm_safe", "Weather a storm with no floating building stopped", 8000, (d) => [counter(d, "stormsSurvived"), 1]),
  built("nuclear_plant", "nuclear plant", 15000),
  built("university", "university", 15000),
  built("tech_campus", "tech campus", 25000),
  coverage("fun", "Entertainment", 90, 8000, 500),
  goal("happy_8", "Happiness 8+ with 500+ residents", 15000, (_d, r) => {
    if (pop(r) < 500) return [0, 1];
    return [Math.floor((r?.happiness ?? 0) * 10), 80];
  }),
  built("water_park", "water park", 6000),
  built("oil_platform", "oil platform", 10000),
  built("tower", "towers", 25000, 10),
  residents(1200, 40000),
  goal("land_all", "Own the whole island (36 chunks)", 30000, (d) => [chunkCount(d), 36]),
  residents(1500, 60000),
  goal("ruins_cleared", "Clear 3 ruins", 5000, (d) => [counter(d, "ruinsCleared"), 3]),
  residents(2000, 100000),
];

{
  const seen = new Set<string>();
  for (const g of GOAL_LIST) {
    if (seen.has(g.key)) throw new Error(`duplicate goal key ${g.key}`);
    seen.add(g.key);
  }
}

// The live board: the first ACTIVE goals not yet completed.
export function goalBoard(d: District): Goal[] {
  const out: Goal[] = [];
  for (const g of GOAL_LIST) {
    if (!d.goalsDone.has(g.key)) {
      out.push(g);
      if (out.length >= GOALS.ACTIVE) break;
    }
  }
  return out;
}

// Checks the live goals; pays rewards; returns news lines.
export function stepGoals(d: District, report: Report): News[] {
  const news: News[] = [];
  for (const g of goalBoard(d)) {
    const [progress, target] = g.check(d, report);
    if (progress >= target) {
      d.goalsDone.add(g.key);
      d.cash += g.reward;
      d.dirty = true;
      news.push({ text: `Goal done: ${g.text}  +$${g.reward}`, good: true });
    }
  }
  return news;
}

export interface GoalProgress {
  key: string;
  text: string;
  reward: number;
  progress: number;
  target: number;
}

export interface GoalsSummary {
  live: GoalProgress[];
  done: number;
  total: number;
}

// For the UI: the live goals with progress.
export function summarizeGoals(d: District, report: Report | undefined): GoalsSummary {
  const live = goalBoard(d).map((g) => {
    const [progress, target] = g.check(d, report);
    return { key: g.key, text: g.text, reward: g.reward, progress: Math.min(progress, target), target };
  });
  return { live, done: d.goalsDone.size, total: GOAL_LIST.length };
}
