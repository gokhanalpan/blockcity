import { describe, expect, it } from "vitest";
import { addTile, index } from "@/sim/district";
import { collect, recompute } from "@/sim/simulation";
import { defByKey } from "@/sim/tileDefs";
import { MID, place, richCity, tileAt, trunk } from "./helpers";

describe("roads and activity", () => {
  it("a building off the road network is inactive and says so", () => {
    const city = richCity();
    place(city, "house", 10, 10);
    const h = tileAt(city, 10, 10);
    expect(h.active).toBe(false);
    expect(h.needs).toEqual(["road"]);
    expect(h.mood).toBe(0);
    expect(h.growthDelta).toBe(-3);
  });

  it("the seeded entrance road is reachable and a road not touching it is not", () => {
    const city = richCity();
    expect(tileAt(city, MID, 0).reachable).toBe(true);
    place(city, "road", 10, 10);
    expect(tileAt(city, 10, 10).reachable).toBe(false);
    expect(tileAt(city, 10, 10).active).toBe(false);
    trunk(city, 4);
    expect(tileAt(city, MID, 3).dist).toBe(3);
    expect(tileAt(city, MID, 3).parent).toBe(index(48, MID, 2));
  });

  it("house + turbine on the road: powered, mood 6 (no jobs), income 3", () => {
    const city = richCity();
    trunk(city, 3);
    place(city, "house", MID - 1, 1);
    place(city, "wind_turbine", MID + 1, 1);
    const h = tileAt(city, MID - 1, 1);
    expect(h.active).toBe(true);
    expect(h.powered).toBe(true);
    expect(h.occ).toBe(1);
    // 5 base + 2 power - 1 unemployed = 6; five services missing
    expect(h.mood).toBe(6);
    expect(h.needs).toEqual(["police", "health", "school", "fire", "fun", "jobs"]);
    expect(h.growthDelta).toBe(1);
    const r = city.report;
    expect(r.powerGen).toBe(8);
    expect(r.powerUse).toBe(1);
    expect(r.population).toBe(1);
    expect(r.income).toBe(3); // 2 + floor(1 resident * 2 * (0.6 + 1.11/10))
    expect(r.happiness).toBeCloseTo(10 / 9, 5);
  });

  it("needsBigRoad: a skyscraper on a plain road is inactive with need 'avenue'", () => {
    const city = richCity();
    trunk(city, 5);
    place(city, "skyscraper_res", MID - 3, 1); // 3x3 at x 21..23, touches (24,1..3)
    expect(tileAt(city, MID - 3, 1).needs).toContain("avenue");
    expect(tileAt(city, MID - 3, 1).active).toBe(false);
    place(city, "avenue", MID, 1); // replaces the road in place
    expect(tileAt(city, MID - 3, 1).active).toBe(true);
  });
});

describe("power", () => {
  it("a generator next door pollutes the house: -1 mood, need 'clean air'", () => {
    const city = richCity();
    trunk(city, 3);
    place(city, "house", MID - 1, 1);
    place(city, "generator", MID + 1, 1); // pollution 1 within 3 cells
    const h = tileAt(city, MID - 1, 1);
    expect(h.mood).toBe(5);
    expect(h.needs).toContain("clean air");
    expect(h.growthDelta).toBe(0);
    expect(city.report.happiness).toBe(0);
    expect(city.report.income).toBe(3); // 2 + floor(2 * 0.6)
  });

  it("brownout cuts the newest consumers first", () => {
    const city = richCity();
    trunk(city, 8);
    place(city, "generator", MID + 1, 1); // 6
    place(city, "house", MID - 1, 1); // 1
    place(city, "shop", MID - 1, 2); // 2
    place(city, "office", MID + 1, 2); // 5 -> over budget
    expect(city.report.brownout).toBe(true);
    expect(tileAt(city, MID - 1, 1).powered).toBe(true);
    expect(tileAt(city, MID - 1, 2).powered).toBe(true);
    expect(tileAt(city, MID + 1, 2).powered).toBe(false);
    expect(tileAt(city, MID + 1, 2).needs).toContain("power");
    expect(city.report.powerUse).toBe(3);
    expect(city.report.jobs).toBe(3); // the unpowered office offers nothing
  });

  it("eco homes need no power and nuclear plants need no power to run", () => {
    const city = richCity();
    trunk(city, 4);
    place(city, "eco_homes", MID - 2, 1);
    const eco = tileAt(city, MID - 2, 1);
    expect(eco.powered).toBe(true);
    expect(eco.mood).toBe(6); // base + power(2) - jobs(1)
  });
});

describe("traffic", () => {
  it("70 trips on a 60-capacity trunk jams it and blocks every home behind it", () => {
    const city = richCity();
    trunk(city, 16);
    const d = city.district;
    for (let i = 0; i < 7; i++) addTile(d, defByKey("tower").id, MID - 2, 1 + i * 2, 0, 40); // 10 trips each
    city.refresh();
    const entrance = tileAt(city, MID, 0);
    expect(entrance.load).toBe(70);
    expect(entrance.jammed).toBe(true);
    expect(tileAt(city, MID, 1).load).toBe(70); // every tower's access is on or behind (24,1)
    expect(city.report.traffic).toMatchObject({ trips: 70, jammed: 2 });
    expect(city.report.coverage.traffic).toBe(0);
    for (let i = 0; i < 7; i++) expect(tileAt(city, MID - 2, 1 + i * 2).needs).toContain("traffic");
    expect(city.report.traffic.blockedResidents).toBe(280);
    // upgrading the jammed stretch to avenue (240) clears it
    place(city, "avenue", MID, 0);
    expect(city.report.traffic.jammed).toBe(1); // (24,1) still carries 70 on a 60 road
    place(city, "avenue", MID, 1);
    expect(tileAt(city, MID, 1).jammed).toBe(false);
    expect(city.report.traffic.jammed).toBe(0);
    expect(city.report.coverage.traffic).toBe(1);
  });

  it("workplaces behind a jam offer half their jobs", () => {
    const city = richCity();
    trunk(city, 14);
    const d = city.district;
    place(city, "solar_farm", MID + 1, 1);
    place(city, "office", MID + 1, 3); // 20 jobs, 5 trips
    for (let i = 0; i < 6; i++) addTile(d, defByKey("tower").id, MID - 2, 1 + i * 2, 0, 40); // 60 trips
    city.refresh();
    expect(tileAt(city, MID, 0).load).toBe(65);
    expect(city.report.jobs).toBe(10);
    expect(tileAt(city, MID + 1, 3).needs).toContain("traffic");
  });
});

describe("services, parks and pollution", () => {
  it("service capacity is handed out in placement order; a house counts if half its residents fit", () => {
    const city = richCity();
    trunk(city, 14);
    place(city, "solar_farm", MID + 1, 1); // 25 power
    place(city, "solar_farm", MID + 1, 3);
    place(city, "police", MID + 1, 5); // 150 capacity, radius 10
    const d = city.district;
    for (let i = 0; i < 5; i++) addTile(d, defByKey("tower").id, MID - 2, 1 + i * 2, 0, 40); // 200 residents
    city.refresh();
    const towers = [0, 1, 2, 3, 4].map((i) => tileAt(city, MID - 2, 1 + i * 2));
    expect(towers[0].needs).not.toContain("police");
    expect(towers[2].needs).not.toContain("police");
    expect(towers[3].needs).not.toContain("police"); // 30 of 40 fit: at least half
    expect(towers[4].needs).toContain("police");
    expect(city.report.services.police).toEqual({ buildings: 1, full: 1, served: 150, capacity: 150 });
    expect(city.report.coverage.police).toBeCloseTo(160 / 200, 6);
  });

  it("pollution lowers mood; greenery in reach cancels it", () => {
    const city = richCity();
    trunk(city, 8);
    place(city, "solar_farm", MID + 1, 5);
    place(city, "house", MID - 1, 1);
    place(city, "factory", MID + 1, 1); // pollution 2, radius 3: covers the house
    const h = () => tileAt(city, MID - 1, 1);
    expect(h().needs).toContain("clean air");
    expect(h().mood).toBe(5); // 5 + 2 power + 0 (jobs: 1 < 8) - 2 pollution
    place(city, "park", MID - 2, 1); // cleans 1 within 4, and an amenity: +1 park
    expect(h().mood).toBe(7); // -1 pollution, +1 park
    place(city, "big_park", MID - 3, 2); // cleans 2
    expect(h().needs).not.toContain("clean air");
    expect(h().mood).toBe(8);
  });

  it("a home that needs full services shrinks until all five cover it", () => {
    const city = richCity();
    trunk(city, 4);
    place(city, "solar_farm", MID + 1, 1);
    place(city, "apartment", MID - 2, 1);
    expect(tileAt(city, MID - 2, 1).growthDelta).toBe(-2);
  });

  it("waterfront homes get +1 mood and count toward the water share", () => {
    const city = richCity({ terrain: "river" });
    // the river runs near x = 33..35 on the front rows: bridge over it along row 0 and put a house on
    // the east bank, next to the water on row 1
    const d = city.district;
    let x = MID;
    for (x = MID; x < 47; x++) if (d.water[index(48, x - 1, 1)] && !d.water[index(48, x, 1)] && !d.water[index(48, x, 0)]) break;
    for (let xx = MID + 1; xx <= x; xx++) place(city, d.water[index(48, xx, 0)] ? "bridge" : "road", xx, 0);
    expect(tileAt(city, x, 0).reachable).toBe(true);
    place(city, "house", x, 1);
    expect(tileAt(city, x, 1).mood).toBe(5); // 5 - 1 jobs + 1 waterfront, no power
    expect(city.report.coverage.water).toBe(1);
  });
});

describe("big venues and dependencies", () => {
  it("a mall without a car park in reach shows 'parking' and offers no jobs", () => {
    const city = richCity();
    trunk(city, 8);
    place(city, "solar_farm", MID + 1, 1);
    place(city, "mall", MID + 1, 3);
    expect(tileAt(city, MID + 1, 3).needs).toEqual(["parking"]);
    expect(city.report.jobs).toBe(0);
    place(city, "car_park", MID - 2, 1);
    expect(tileAt(city, MID + 1, 3).needs).toEqual([]);
    expect(city.report.jobs).toBe(30);
  });

  it("a tech campus needs a working university within 12 cells", () => {
    const city = richCity();
    trunk(city, 30);
    place(city, "nuclear_plant", MID + 1, 1);
    place(city, "tech_campus", MID + 1, 3);
    expect(tileAt(city, MID + 1, 3).needs).toEqual(["university"]);
    place(city, "university", MID - 3, 20); // rows 20..22: 14 cells away from rows 3..5 -> too far
    expect(tileAt(city, MID + 1, 3).needs).toEqual(["university"]);
    place(city, "university", MID - 3, 10);
    expect(tileAt(city, MID + 1, 3).needs).toEqual([]);
    expect(city.report.jobs).toBe(6 + 30 + 30 + 90);
  });
});

describe("economy and growth", () => {
  it("landmarks add to income up to +50%; happiness scales the multiplier", () => {
    const city = richCity();
    trunk(city, 20);
    place(city, "nuclear_plant", MID + 1, 1);
    const d = city.district;
    addTile(d, defByKey("tower").id, MID - 2, 1, 0, 40);
    city.refresh();
    const base = city.report.income;
    place(city, "bank", MID + 1, 3); // +2%
    expect(city.report.bonus).toBeCloseTo(0.02);
    expect(city.report.income).toBeGreaterThanOrEqual(base);
  });

  it("collect moves residents in once the growth accumulator reaches the threshold", () => {
    const city = richCity();
    trunk(city, 3);
    place(city, "house", MID - 1, 1);
    place(city, "wind_turbine", MID + 1, 1);
    const d = city.district;
    const h = tileAt(city, MID - 1, 1);
    let r = recompute(d, city.entrance);
    expect(h.growthDelta).toBe(1);
    const cash0 = d.cash;
    for (let i = 0; i < 10; i++) {
      r = recompute(d, city.entrance);
      collect(d, r);
    }
    expect(h.occ).toBe(2);
    expect(r.population).toBe(2);
    expect(d.cash).toBe(cash0 + 3 * 10);
  });

  it("residents leave an unconnected house at -3 per tick", () => {
    const city = richCity();
    const d = city.district;
    const t = addTile(d, defByKey("townhouse").id, 10, 10, 0, 8);
    for (let i = 0; i < 4; i++) collect(d, recompute(d, city.entrance));
    expect(t.occ).toBe(7);
  });
});

describe("finding the jam", () => {
  it("follows a blocked home's route to the jammed road nearest it", async () => {
    const { jamOnRoute } = await import("@/ui/panels");
    const city = richCity();
    trunk(city, 16);
    const d = city.district;
    for (let i = 0; i < 7; i++) addTile(d, defByKey("tower").id, MID - 2, 1 + i * 2, 0, 40); // 70 trips down a 60 road
    city.refresh();
    const far = tileAt(city, MID - 2, 13);
    expect(far.needs).toContain("traffic");
    const jam = jamOnRoute(city, far)!;
    expect(d.tiles.get(jam)!.jammed).toBe(true);
    expect(jam).toBe(index(48, MID, 1)); // the first over-capacity stretch on its way out
    place(city, "avenue", MID, 0);
    place(city, "avenue", MID, 1);
    expect(tileAt(city, MID - 2, 13).needs).not.toContain("traffic");
    expect(jamOnRoute(city, tileAt(city, MID - 2, 13))).toBeUndefined();
  });
});