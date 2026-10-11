import { describe, expect, it } from "vitest";
import { Traffic } from "@/render/traffic";
import type { City } from "@/sim/city";
import { addTile } from "@/sim/district";
import { defByKey } from "@/sim/tileDefs";
import { MID, place, richCity } from "./helpers";

interface CarView { obj: object; pos: { x: number; z: number } }

// Drives the cars for `seconds` and reports how close they came, how fast they flowed and how many
// had to be taken off the road for being stuck.
function drive(city: City, seconds: number) {
  const traffic = new Traffic(city);
  const cars = (traffic as unknown as { cars: CarView[] }).cars;
  let close = 0;
  let samples = 0;
  let maxCars = 0;
  let travelled = 0;
  let carSeconds = 0;
  let last = new Map<object, { x: number; z: number }>();
  const dt = 1 / 30;
  for (let i = 0; i < seconds * 30; i++) {
    traffic.update(dt);
    if (i < 30 * 20) continue; // warm up: the spawner fills the roads
    const now = new Map<object, { x: number; z: number }>();
    for (const c of cars) {
      now.set(c.obj, { x: c.pos.x, z: c.pos.z });
      const p = last.get(c.obj);
      if (p) {
        travelled += Math.hypot(c.pos.x - p.x, c.pos.z - p.z);
        carSeconds += dt;
      }
    }
    last = now;
    if (i % 15 === 0) {
      maxCars = Math.max(maxCars, cars.length);
      for (let a = 0; a < cars.length; a++)
        for (let b = a + 1; b < cars.length; b++) {
          samples++;
          if (Math.hypot(cars[a].pos.x - cars[b].pos.x, cars[a].pos.z - cars[b].pos.z) < 1.3) close++;
        }
    }
  }
  return { maxCars, close, samples, speed: travelled / carSeconds, removed: traffic.removed };
}

function towers(city: City, rows: number[], skip: (x: number) => boolean): void {
  const d = city.district;
  for (let x = MID - 11; x <= MID + 10; x += 2) for (const y of rows) if (!skip(x)) addTile(d, defByKey("tower").id, x, y, 0, 40);
  city.refresh();
}

describe("traffic", () => {
  it("keeps its distance and keeps moving on a grid with junctions", () => {
    const city = richCity({ seed: 3 });
    for (let y = 1; y <= 24; y++) place(city, "road", MID, y);
    for (const y of [6, 12, 18, 24]) for (let x = MID - 12; x <= MID + 12; x++) if (x !== MID) place(city, "road", x, y);
    for (const x of [MID - 12, MID - 6, MID + 6, MID + 12]) for (let y = 6; y <= 24; y++) if (!city.tileAtCell(x, y)) place(city, "road", x, y);
    place(city, "nuclear_plant", MID + 1, 1);
    towers(city, [7, 13, 19], (x) => [MID - 7, MID - 6, MID - 1, MID, MID + 5, MID + 6].includes(x));
    const r = drive(city, 120);
    console.log("grid", r);
    expect(r.maxCars).toBeGreaterThan(30);
    expect(r.close).toBe(0);
    expect(r.speed).toBeGreaterThan(1.2); // units/s; free flow is ~3.2
  });

  it("does not gridlock where roads run side by side (every cell a junction)", () => {
    const city = richCity({ seed: 5 });
    // two-wide roads: a double trunk and two double cross streets
    for (let y = 1; y <= 20; y++) {
      place(city, "road", MID, y);
      place(city, "road", MID + 1, y);
    }
    for (const y of [8, 9, 16, 17]) for (let x = MID - 10; x <= MID + 11; x++) if (!city.tileAtCell(x, y)) place(city, "road", x, y);
    place(city, "nuclear_plant", MID + 2, 1);
    towers(city, [10, 12, 18], (x) => x === MID - 1 || x === MID || x === MID + 1);
    const r = drive(city, 120);
    console.log("double", r);
    expect(r.maxCars).toBeGreaterThan(10);
    expect(r.close).toBe(0);
    expect(r.speed).toBeGreaterThan(0.8);
    expect(r.removed).toBeLessThan(r.maxCars); // stuck removals are rare, not the way traffic flows
  });
});