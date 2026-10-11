import { describe, expect, it } from "vitest";
import { GRID } from "@/config/tuning";
import { TERRAIN_LIST, isWater, waterMask } from "@/sim/terrains";
import {
  accessCells, addTile, cells, chunkCoords, chunkIndex, chunkOfCell, coords, defaultChunks, deserialize, entranceCells,
  footprint, frontCells, index, isBuyable, landPrice, neighbours, newDistrict, serialize,
} from "@/sim/district";
import { TILE_LIST, defByKey } from "@/sim/tileDefs";

describe("catalog", () => {
  it("has unique ids and keys and a model for every key", async () => {
    const ids = new Set(TILE_LIST.map((d) => d.id));
    expect(ids.size).toBe(TILE_LIST.length);
    const models = (await import("@/assets/models.json")).default as { tiles: Record<string, unknown> };
    for (const d of TILE_LIST) expect(models.tiles[d.key], `model for ${d.key}`).toBeDefined();
  });

  it("keeps the Roblox numbers", () => {
    expect(defByKey("road").roadCapacity).toBe(60);
    expect(defByKey("avenue").roadCapacity).toBe(240);
    expect(defByKey("highway").roadCapacity).toBe(800);
    expect(defByKey("tower")).toMatchObject({ id: 17, cost: 2500, population: 40, powerUse: 6, needsServices: true });
    expect(defByKey("airport")).toMatchObject({ w: 10, h: 5, roadSide: "front", needsParking: true, incomeBonus: 0.15 });
    expect(defByKey("eco_homes").needsPower).toBe(false);
    expect(defByKey("ruins_2").refundRate).toBe(0);
  });
});

describe("terrains", () => {
  it("keeps the entrance cells on land on every map", () => {
    for (const t of TERRAIN_LIST) {
      for (const c of entranceCells(GRID.SIZE)) {
        const [x, y] = coords(GRID.SIZE, c);
        expect(isWater(t.key, x, y, GRID.SIZE), `${t.key} entrance ${x},${y}`).toBe(false);
      }
    }
  });

  it("plains has no water, river has a three-wide band, island is mostly water", () => {
    expect(waterMask("plains", 48).some((v) => v === 1)).toBe(false);
    const river = waterMask("river", 48);
    let row0 = 0;
    for (let x = 0; x < 48; x++) row0 += river[x];
    expect(row0).toBe(3);
    const island = waterMask("island", 48);
    const water = island.reduce((a, b) => a + b, 0);
    expect(water).toBeGreaterThan(48 * 48 * 0.3);
    expect(waterMask("river", 48)).toBe(river); // cached
  });
});

describe("grid math", () => {
  it("index/coords roundtrip", () => {
    expect(coords(48, index(48, 5, 7))).toEqual([5, 7]);
  });

  it("footprint turns with rotation", () => {
    const port = defByKey("cargo_port"); // 3x2
    expect(footprint(port, 0)).toEqual([3, 2]);
    expect(footprint(port, 1)).toEqual([2, 3]);
    expect(cells(48, port, 46, 0, 0)).toBeUndefined();
    expect(cells(48, port, 45, 0, 0)).toHaveLength(6);
  });

  it("neighbours excludes the set and the outside", () => {
    const n = neighbours(48, [index(48, 0, 0), index(48, 1, 0)]);
    expect(n.sort((a, b) => a - b)).toEqual([index(48, 2, 0), index(48, 0, 1), index(48, 1, 1)].sort((a, b) => a - b));
  });

  it("front cells follow the rotation: -Z, -X, +Z, +X", () => {
    const def = defByKey("cargo_port"); // 3 wide, 2 deep
    expect(frontCells(48, def, 10, 10, 0)).toEqual([index(48, 10, 9), index(48, 11, 9), index(48, 12, 9)]);
    expect(frontCells(48, def, 10, 10, 1)).toEqual([index(48, 9, 10), index(48, 9, 11), index(48, 9, 12)]);
    expect(frontCells(48, def, 10, 10, 2)).toEqual([index(48, 10, 12), index(48, 11, 12), index(48, 12, 12)]);
    expect(frontCells(48, def, 10, 10, 3)).toEqual([index(48, 12, 10), index(48, 12, 11), index(48, 12, 12)]);
    // airport: front only; a front on the map edge has no access cells
    expect(accessCells(48, defByKey("airport"), 0, 0, 0)).toHaveLength(0);
    expect(accessCells(48, defByKey("house"), 0, 0, 0)).toHaveLength(2);
  });

  it("chunks: default land is the two front-centre chunks; prices grow quadratically", () => {
    expect([...defaultChunks(48)].sort()).toEqual([2, 3]);
    expect(chunkCoords(48, chunkIndex(48, 4, 5))).toEqual([4, 5]);
    expect(chunkOfCell(48, 24, 0)).toBe(3);
    expect(landPrice(2)).toBe(200);
    expect(landPrice(3)).toBe(800);
    expect(landPrice(10)).toBe(16200);
    const d = newDistrict();
    expect(isBuyable(d, 4)).toBe(true); // right of chunk 3
    expect(isBuyable(d, 9)).toBe(true); // behind chunk 3
    expect(isBuyable(d, 0)).toBe(false);
    expect(isBuyable(d, 3)).toBe(false); // owned
  });
});

describe("serialize / deserialize", () => {
  it("roundtrips tiles, occupants, chunks, goals and counters in placement order", () => {
    const d = newDistrict(48, "lake");
    d.name = "Test Town";
    d.cash = 1234;
    addTile(d, defByKey("road").id, 24, 0, 0);
    addTile(d, defByKey("house").id, 23, 1, 2, 3);
    addTile(d, defByKey("park").id, 25, 1, 1);
    d.chunks.add(9);
    d.goalsDone.add("pop_10");
    d.counters.firesFought = 2;
    const blob = serialize(d);
    expect(blob.v).toBe(2);
    expect(blob.t).toEqual([index(48, 24, 0), 1, 0, 0, index(48, 23, 1), 2, 2, 3, index(48, 25, 1), 6, 1, 0]);
    expect(blob.c).toEqual([2, 3, 9]);
    const back = deserialize(JSON.parse(JSON.stringify(blob)));
    expect(back.name).toBe("Test Town");
    expect(back.terrain).toBe("lake");
    expect(back.cash).toBe(1234);
    expect(back.tiles.size).toBe(3);
    expect(back.tiles.get(index(48, 23, 1))).toMatchObject({ id: 2, rot: 2, occ: 3, seq: 2 });
    expect([...back.chunks].sort()).toEqual([2, 3, 9]);
    expect(back.goalsDone.has("pop_10")).toBe(true);
    expect(back.counters.firesFought).toBe(2);
    expect(back.dirty).toBe(false);
  });

  it("drops unknown ids, overlaps, water mismatches and bad chunks instead of failing", () => {
    const blob = {
      v: 2, size: 48, cash: 10, rebirths: 0,
      t: [
        index(48, 24, 0), 1, 0, 0, // road
        index(48, 24, 0), 2, 0, 0, // house overlapping the road: dropped
        index(48, 10, 10), 9999, 0, 0, // unknown id: dropped
        index(48, 10, 10), 42, 0, 0, // houseboat on land: dropped
        index(48, 47, 47), 4, 0, 0, // factory 2x2 out of bounds: dropped
      ],
      c: [2, 3, 999, -1, 2.5],
    };
    const d = deserialize(blob);
    expect(d.tiles.size).toBe(1);
    expect([...d.chunks].sort()).toEqual([2, 3]);
  });

  it("re-anchors saves made on a smaller grid so the entrance lines up, and adds land under tiles", () => {
    const blob = { v: 1, size: 32, cash: 50, rebirths: 0, t: [index(32, 16, 0), 1, 0, index(32, 2, 20), 2, 0], c: [] };
    const d = deserialize(blob);
    expect(d.tiles.has(index(48, 24, 0))).toBe(true);
    expect(d.tiles.has(index(48, 10, 20))).toBe(true);
    expect(d.tiles.get(index(48, 10, 20))!.occ).toBe(1); // v1 had no occupants: starts with one
    expect(d.chunks.has(chunkOfCell(48, 10, 20))).toBe(true);
  });

  it("deserialize of garbage gives a fresh district", () => {
    const d = deserialize(null);
    expect(d.tiles.size).toBe(0);
    expect(d.cash).toBe(400);
  });
});
