import { describe, expect, it } from "vitest";
import { coverageCells, coverageOf } from "@/render/coverage";
import { defByKey } from "@/sim/tileDefs";
import { MID, place, richCity, tileAt, trunk } from "./helpers";

describe("coverage areas", () => {
  it("knows what each kind of building reaches", () => {
    expect(coverageOf(defByKey("police"))).toEqual({ kind: "police", radius: 10 });
    expect(coverageOf(defByKey("hospital"))).toEqual({ kind: "health", radius: 14 });
    expect(coverageOf(defByKey("playground"))).toEqual({ kind: "fun", radius: 6 });
    expect(coverageOf(defByKey("car_park"))).toEqual({ kind: "parking", radius: 8 });
    expect(coverageOf(defByKey("tree_line"))).toEqual({ kind: "park", radius: 2 });
    expect(coverageOf(defByKey("factory"))).toEqual({ kind: "smoke", radius: 3 });
    expect(coverageOf(defByKey("house"))).toBeNull();
    expect(coverageOf(defByKey("road"))).toBeNull();
  });

  it("clips to the island", () => {
    expect(coverageCells(1, 2, 2, 2, 10, 48)).toEqual({ x0: 0, y0: 0, x1: 12, y1: 13 });
    expect(coverageCells(44, 44, 2, 2, 10, 48)).toEqual({ x0: 34, y0: 34, x1: 47, y1: 47 });
  });

  it("shades exactly the homes the simulation covers: just inside yes, one cell further no", () => {
    const city = richCity();
    trunk(city, 14);
    for (let x = MID + 1; x <= MID + 14; x++) place(city, "road", x, 8); // a street east, past the edge
    place(city, "nuclear_plant", MID - 2, 1);
    place(city, "police", MID - 2, 7); // 2x2 at x 22..23, y 7..8
    const area = coverageCells(MID - 2, 7, 2, 2, 10, 48); // x 12..33
    expect(area.x1).toBe(MID + 9);
    place(city, "house", area.x1, 9); // last column inside
    place(city, "house", area.x1 + 1, 9); // first column outside
    expect(tileAt(city, area.x1, 9).needs).not.toContain("police");
    expect(tileAt(city, area.x1 + 1, 9).needs).toContain("police");
  });
});