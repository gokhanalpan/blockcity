import { describe, expect, it } from "vitest";
import { AirTraffic } from "@/render/aviation";
import { defByKey } from "@/sim/tileDefs";
import { MID, place, richCity } from "./helpers";

// A working airport: road along its front edge (row 0), power, and a car park in reach.
function cityWithAirport(powered = true) {
  const city = richCity();
  for (let x = MID - 14; x < MID; x++) place(city, "road", x, 0);
  if (powered) place(city, "nuclear_plant", MID - 2, 1); // on the row-0 road too
  place(city, "car_park", MID - 14, 1);
  place(city, "airport", MID - 12, 1); // 10 x 5, front (-z) on row 0
  const t = city.tileAtCell(MID - 12, 1)!;
  return { city, airport: t };
}

describe("air traffic", () => {
  it("a working airport flies two planes round the whole cycle: runway, circuit, landing, taxi", () => {
    const { city, airport } = cityWithAirport();
    expect(defByKey("airport").id).toBe(airport.id);
    expect(airport.active && airport.powered).toBe(true);
    const air = new AirTraffic(city);
    air.sync();
    expect(air.planes()).toHaveLength(2);
    const legsSeen = new Set<number>();
    let maxAlt = 0;
    let minAlt = Infinity;
    for (let t = 0; t < 240; t += 1 / 20) {
      air.update(1 / 20);
      for (const p of air.planes()) {
        legsSeen.add(p.leg);
        maxAlt = Math.max(maxAlt, p.altitude);
        minAlt = Math.min(minAlt, p.altitude);
        expect(Number.isFinite(p.position.x) && Number.isFinite(p.position.z)).toBe(true);
      }
    }
    expect([...legsSeen].sort()).toEqual([0, 1, 2, 3]); // take-off, flight, roll-out, taxi
    expect(maxAlt).toBeGreaterThan(35); // up over the city
    expect(minAlt).toBeLessThan(0.5); // and down on the runway
  });

  it("no planes when the airport isn't working; they go when it stops", () => {
    const air = new AirTraffic(cityWithAirport(false).city);
    air.sync();
    expect(air.planes()).toHaveLength(0);
    const { city, airport } = cityWithAirport();
    const a2 = new AirTraffic(city);
    a2.sync();
    expect(a2.planes()).toHaveLength(2);
    city.remove(airport.x, airport.y);
    a2.sync();
    expect(a2.planes()).toHaveLength(0);
  });
});