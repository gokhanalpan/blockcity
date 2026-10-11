// Residents and shopkeepers commenting on the city. Every few ticks one line is composed from the
// state: a complaint matching a building's needs, or a compliment from a happy home. The last few
// lines are kept for the UI; nothing is saved. Translated from the Roblox CitizenFeed.lua.

import { FEED } from "@/config/tuning";
import { defById, isRoadId, isRuins } from "./tileDefs";
import { neighbours, tileCells, type District, type Tile } from "./district";
import type { Rng } from "./events";

export interface FeedLine {
  who: string;
  text: string;
  anchor: number;
  good: boolean;
  t: number; // ms timestamp
}

export interface FeedState {
  lines: FeedLine[];
  since: number;
}

export function newFeedState(): FeedState {
  return { lines: [], since: 0 };
}

const NAMES = [
  "Ayşe", "Mehmet", "Elif", "Can", "Zeynep", "Emre", "Defne", "Kerem", "Selin", "Burak",
  "Maya", "Leo", "Nora", "Sam", "Ava", "Max", "Mia", "Omar", "Lena", "Noah", "Ela", "Deniz",
];

// complaints by need key; {b} is the building name
const COMPLAINTS: Record<string, string[]> = {
  road: ["Still no road out here at the {b}. How do I get to work?", "The {b} isn't connected to anything. Are we forgotten?"],
  power: ["The lights are out again at the {b}.", "No power at the {b}. My fridge is a cupboard now."],
  police: ["We don't feel safe around the {b}. Where are the police?", "Someone took my bike outside the {b}. Again."],
  health: ["The nearest clinic is miles from the {b}.", "My kid is sick and there's no doctor near the {b}."],
  school: ["The children at the {b} have no school to go to.", "A school near the {b} would change everything."],
  fire: ["If the {b} ever catches fire, who comes?", "No fire station near the {b}. That worries me."],
  fun: ["Nothing to do around the {b}. Boring!", "Weekends at the {b} are just... staring at walls."],
  "clean air": ["I can taste the smoke at the {b}. Move that factory!", "The air at the {b} is grey. Not ideal."],
  jobs: ["Everyone at the {b} is looking for work.", "Lovely place, the {b}. Shame there are no jobs."],
  traffic: ["Took me forever to get home to the {b}. The roads are jammed.", "The traffic near the {b} is a nightmare."],
  parking: ["Customers can't park anywhere near the {b}.", "The {b} needs a car park, or we'll go out of business."],
  avenue: ["The road by the {b} is far too small for a building this size.", "We need an avenue outside the {b}, not a lane."],
  park: ["A little green near the {b} would be nice.", "Not a single tree by the {b}."],
  university: ["The {b} can't find graduates. Where's the university?"],
  burning: ["FIRE at the {b}! Somebody call the fire brigade!"],
  blackout: ["The {b} just died. Everything's dark."],
  crime: ["A gang's been hanging around the {b} all week."],
  crash: ["There's been a crash by the {b}. Nothing's moving."],
  storm: ["The storm's battering the {b}. We've stopped work."],
};

const COMPLIMENTS = [
  "Love living at the {b}. Great neighbourhood!",
  "Everything we need is close to the {b}. Perfect.",
  "The kids are happy, the lights are on. Good job, mayor.",
  "Moved to the {b} last month. Best decision.",
];
const PARK_LINES = ["The park near the {b} is lovely in the evening.", "Picnic by the {b} today. This city's getting good."];
const WATER_LINES = ["Nothing beats the view from the {b}.", "Woke up to the water outside the {b}. Bliss."];
const WORK_LINES = ["Business is booming at the {b}!", "Hired two more people at the {b} this week."];

function pickRandom<T>(rng: Rng, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)];
}

function fill(template: string, building: string): string {
  return template.replaceAll("{b}", building);
}

function compose(d: District, rng: Rng, now: number): FeedLine | undefined {
  // gather candidates: buildings with a need to complain about, happy homes to compliment
  const complainers: Tile[] = [];
  const happy: Tile[] = [];
  for (const t of d.tiles.values()) {
    const def = defById(t.id);
    if (isRoadId(t.id) || isRuins(def)) continue;
    const hasVoice = def.population > 0 || def.jobs > 0;
    if (!hasVoice) continue;
    const speakable = t.needs.some((n) => COMPLAINTS[n] !== undefined);
    if (speakable) complainers.push(t);
    else if (def.population > 0 && t.occ > 0 && t.mood >= FEED.HAPPY_MIN_MOOD) happy.push(t);
    else if (def.jobs > 0 && t.active && t.powered && t.needs.length === 0) happy.push(t);
  }
  const complain = complainers.length > 0 && (happy.length === 0 || rng() < FEED.COMPLAIN_CHANCE);
  const t = complain ? pickRandom(rng, complainers) : happy.length > 0 ? pickRandom(rng, happy) : undefined;
  if (!t) return undefined;
  const def = defById(t.id);
  let text: string;
  if (complain) {
    const keys = t.needs.filter((n) => COMPLAINTS[n] !== undefined);
    text = fill(pickRandom(rng, COMPLAINTS[pickRandom(rng, keys)]), def.name);
  } else if (def.population === 0) {
    text = fill(pickRandom(rng, WORK_LINES), def.name);
  } else {
    // waterfront and park compliments when they apply
    let waterfront = false;
    for (const n of neighbours(d.size, tileCells(d.size, t))) {
      if (d.water[n]) {
        waterfront = true;
        break;
      }
    }
    let pool: readonly string[] = COMPLIMENTS;
    if (waterfront && rng() < FEED.WATER_LINE_CHANCE) pool = WATER_LINES;
    else if (t.mood >= FEED.PARK_LINE_MIN_MOOD && rng() < FEED.PARK_LINE_CHANCE) pool = PARK_LINES;
    text = fill(pickRandom(rng, pool), def.name);
  }
  return { who: pickRandom(rng, NAMES), text, anchor: t.anchor, good: !complain, t: now };
}

// Called every tick after the simulation; returns the current lines (newest last).
export function stepFeed(st: FeedState, d: District, rng: Rng = Math.random, now: number = Date.now()): FeedLine[] {
  st.since += 1;
  if (st.since >= FEED.EVERY_TICKS) {
    st.since = 0;
    const line = compose(d, rng, now);
    if (line) {
      st.lines.push(line);
      while (st.lines.length > FEED.KEEP) st.lines.shift();
    }
  }
  // drop lines about buildings that no longer exist
  st.lines = st.lines.filter((l) => d.tiles.has(l.anchor));
  return st.lines;
}
