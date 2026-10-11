import { describe, expect, it } from "vitest";
import { ECONOMY, SAVE } from "@/config/tuning";
import { City } from "@/sim/city";
import { addTile, index, newDistrict } from "@/sim/district";
import { defByKey } from "@/sim/tileDefs";
import { buildSave, parseSave } from "@/save/format";
import { MemoryBackend, SaveStore, Session, importSaveText } from "@/save/storage";
import { MID, place, richCity, tileAt, trunk } from "./helpers";

const id = (key: string) => defByKey(key).id;

describe("placement rules", () => {
  it("refuses bad args, unknown tiles, out of bounds, overlaps and unowned land", () => {
    const city = new City(newDistrict());
    expect(city.place(id("road"), 1.5, 0, 0)).toEqual({ ok: false, reason: "bad_args" });
    expect(city.place(999, 1, 0, 0)).toEqual({ ok: false, reason: "unknown_tile" });
    expect(city.place(id("road"), 48, 0, 0)).toEqual({ ok: false, reason: "out_of_bounds" });
    expect(city.place(id("house"), MID, 0, 0)).toEqual({ ok: false, reason: "occupied" });
    expect(city.place(id("road"), 0, 0, 0)).toEqual({ ok: false, reason: "locked_land" }); // chunk 0 isn't owned
    expect(city.place(id("road"), MID, 1, 0)).toEqual({ ok: true });
  });

  it("charges the cost, refuses when broke, and refunds half on demolish", () => {
    const city = new City(newDistrict());
    expect(city.district.cash).toBe(ECONOMY.STARTING_CASH);
    expect(city.place(id("house"), MID - 1, 1, 0).ok).toBe(true);
    expect(city.district.cash).toBe(300);
    expect(city.place(id("tower"), MID - 3, 1, 0)).toEqual({ ok: false, reason: "no_cash" });
    expect(city.remove(MID - 1, 1).ok).toBe(true);
    expect(city.district.cash).toBe(350);
    expect(city.remove(MID - 1, 1)).toEqual({ ok: false, reason: "empty" });
  });

  it("placing a road tier over a road replaces it and refunds the old one", () => {
    const city = richCity();
    trunk(city, 3);
    const cash = city.district.cash;
    expect(city.place(id("avenue"), MID, 1, 0).ok).toBe(true);
    expect(city.district.cash).toBe(cash - 60 + 5);
    expect(tileAt(city, MID, 1).id).toBe(id("avenue"));
    expect(city.district.tiles.size).toBe(3);
    expect(city.place(id("avenue"), MID, 1, 0)).toEqual({ ok: false, reason: "occupied" }); // same tier
  });

  it("water rules: nothing on water but bridges and floaters; shore and mooring checks", () => {
    const city = richCity({ terrain: "lake" });
    const d = city.district;
    let wx = 0;
    let wy = 0;
    outer: for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) if (d.water[index(48, x, y)]) { wx = x; wy = y; break outer; }
    expect(city.place(id("house"), wx, wy, 0)).toEqual({ ok: false, reason: "water" });
    expect(city.place(id("houseboat"), 5, 5, 0)).toEqual({ ok: false, reason: "needs_water" });
    expect(city.place(id("pier"), 5, 5, 0)).toEqual({ ok: false, reason: "needs_shore" });
    expect(city.place(id("hotel"), 2, 2, 0)).toEqual({ ok: false, reason: "needs_water_nearby" });
    expect(city.place(id("bridge"), wx, wy, 0).ok).toBe(true); // first water cell of the row: land is to its west
    // the lake's middle: a houseboat has only water around it
    const cx = Math.round(48 * 0.62);
    const cy = Math.round(48 * 0.54);
    expect(d.water[index(48, cx, cy)]).toBe(1);
    expect(city.place(id("houseboat"), cx, cy, 0)).toEqual({ ok: false, reason: "needs_mooring" });
    expect(city.place(id("fish_farm"), cx, cy, 0).ok).toBe(true); // needs nothing
  });

  it("an airport whose front faces the map edge can never be reached", () => {
    const city = richCity();
    expect(city.place(id("airport"), 10, 0, 0)).toEqual({ ok: false, reason: "front_off_map" });
    expect(city.place(id("airport"), 10, 1, 0).ok).toBe(true);
  });

  it("a demolished road disconnects what was behind it", () => {
    const city = richCity();
    trunk(city, 5);
    place(city, "house", MID - 1, 4);
    expect(tileAt(city, MID - 1, 4).active).toBe(true);
    city.remove(MID, 2);
    expect(tileAt(city, MID - 1, 4).active).toBe(false);
    expect(tileAt(city, MID, 4).reachable).toBe(false);
  });
});

describe("highway bridge", () => {
  // the river map: a bridge on row 0 across the water east of the entrance
  function riverCrossing() {
    const city = richCity({ terrain: "river" });
    const d = city.district;
    const water: number[] = [];
    for (let x = MID + 1; x < 48; x++) if (d.water[index(48, x, 0)]) water.push(x);
    const east = water[water.length - 1] + 1;
    for (let x = MID + 1; x <= east; x++) place(city, d.water[index(48, x, 0)] ? "bridge" : "road", x, 0);
    return { city, water, east };
  }

  it("carries 800 trips, goes only on water, and upgrades a bridge in place for the difference", () => {
    const { city, water } = riverCrossing();
    expect(defByKey("highway_bridge")).toMatchObject({ roadCapacity: 800, onWater: true, needsRoad: false });
    expect(city.place(id("highway_bridge"), 3, 3, 0)).toEqual({ ok: false, reason: "needs_water" });
    expect(city.place(id("highway"), water[0], 0, 0)).toEqual({ ok: false, reason: "water" }); // why it's needed
    const x = water[1];
    const cash = city.district.cash;
    expect(city.place(id("highway_bridge"), x, 0, 0)).toEqual({ ok: true });
    expect(tileAt(city, x, 0).id).toBe(id("highway_bridge"));
    expect(city.district.cash).toBe(cash - 1000 + 100); // the old bridge's refund comes back
    expect(tileAt(city, x, 0).reachable).toBe(true);
  });

  it("clears a jam on a bridge that a plain bridge can't carry", () => {
    const { city, water, east } = riverCrossing();
    const d = city.district;
    // a busy district east of the river, clear of it (the river never reaches x >= 41):
    // a street at x = 43 joining row 0, towers on one side and condos on the other, ~320 trips
    for (let x = east + 1; x <= 43; x++) place(city, "road", x, 0);
    for (let y = 1; y <= 40; y++) place(city, "road", 43, y);
    for (let y = 1; y <= 39; y += 2) {
      addTile(d, defByKey("tower").id, 44, y, 0, 40);
      addTile(d, defByKey("condo").id, 41, y, 0, 24);
    }
    city.refresh();
    const crossing = tileAt(city, water[0], 0);
    expect(crossing.load).toBeGreaterThan(240);
    expect(crossing.jammed).toBe(true);
    for (const x of water) place(city, "highway_bridge", x, 0);
    expect(tileAt(city, water[0], 0).load).toBeLessThan(800);
    expect(tileAt(city, water[0], 0).jammed).toBe(false);
  });
});

describe("undo demolish", () => {
  it("puts the building back with its residents and power priority, and takes the refund back", () => {
    const city = richCity();
    trunk(city, 4);
    place(city, "wind_turbine", MID + 1, 1);
    place(city, "townhouse", MID - 1, 2);
    const before = tileAt(city, MID - 1, 2);
    before.occ = 5;
    const seq = before.seq;
    const cash = city.district.cash;
    const r = city.remove(MID - 1, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(city.district.cash).toBe(cash + 120);
    expect(city.tileAtCell(MID - 1, 2)).toBeUndefined();
    expect(city.restore(r.removed)).toEqual({ ok: true });
    const back = tileAt(city, MID - 1, 2);
    expect(back).toMatchObject({ id: defByKey("townhouse").id, occ: 5, seq, rot: 0 });
    expect(city.district.cash).toBe(cash);
  });

  it("refuses when the ground has been built on or the refund spent; uncounts cleared ruins", () => {
    const city = richCity();
    trunk(city, 4);
    place(city, "house", MID - 1, 2);
    const r = city.remove(MID - 1, 2);
    if (!r.ok) throw new Error("remove failed");
    place(city, "garden", MID - 1, 2);
    expect(city.restore(r.removed)).toEqual({ ok: false, reason: "occupied" });
    city.remove(MID - 1, 2);
    city.district.cash = 10;
    expect(city.restore(r.removed)).toEqual({ ok: false, reason: "no_cash" }); // the $50 refund is gone
    city.district.cash = 1000;
    addRuins(city);
    const ruins = city.remove(MID - 3, 1);
    if (!ruins.ok) throw new Error("ruins remove failed");
    expect(city.district.counters.ruinsCleared).toBe(1);
    expect(city.restore(ruins.removed)).toEqual({ ok: true });
    expect(city.district.counters.ruinsCleared).toBe(0);
  });
});

function addRuins(city: City): void {
  city.place(defByKey("ruins_1").id, MID - 3, 1, 0);
}

describe("land", () => {
  it("sells edge-adjacent chunks at the quadratic price", () => {
    const city = new City(newDistrict());
    city.district.cash = 5000;
    expect(city.landPriceNow()).toBe(200);
    expect(city.buyLand(0, 0)).toEqual({ ok: false, reason: "not_adjacent" });
    expect(city.buyLand(2, 0)).toEqual({ ok: false, reason: "already_owned" });
    expect(city.buyLand(6, 0)).toEqual({ ok: false, reason: "out_of_bounds" });
    expect(city.buyLand(4, 0)).toEqual({ ok: true });
    expect(city.district.cash).toBe(4800);
    expect(city.landPriceNow()).toBe(800);
    expect(city.buyLand(3, 1)).toEqual({ ok: true });
    expect(city.district.cash).toBe(4000);
    city.district.cash = 0;
    expect(city.buyLand(2, 1)).toEqual({ ok: false, reason: "no_cash" });
  });
});

describe("tick", () => {
  it("collects income, grows homes, pays goals and notifies listeners", () => {
    const city = richCity({ cash: 1000 });
    city.rng = () => 0.99;
    trunk(city, 4);
    place(city, "house", MID - 1, 1);
    place(city, "wind_turbine", MID + 1, 1);
    const changes: string[] = [];
    city.onChange((c) => changes.push(c.kind));
    const cash = city.district.cash;
    const out = city.tick();
    expect(out.report.income).toBe(3);
    expect(out.news.map((n) => n.text)).toEqual(["Goal done: Power the city: a generator, turbine or solar farm  +$600"]);
    expect(city.district.cash).toBe(cash + 3 + 600);
    expect(changes).toEqual(["tick"]);
    for (let i = 0; i < 9; i++) city.tick();
    expect(tileAt(city, MID - 1, 1).occ).toBe(2);
    expect(city.ticks).toBe(10);
  });
});

describe("saves", () => {
  it("builds an envelope around the city blob and parses it back", () => {
    const city = richCity();
    trunk(city, 3);
    place(city, "house", MID - 1, 1);
    city.rename("Port Test");
    const file = buildSave(city, { id: "abc", revision: 4, playSeconds: 90 }, 1_700_000_000_000);
    expect(file).toMatchObject({ format: "block-city", version: 1, id: "abc", revision: 4, savedAt: 1_700_000_000_000 });
    expect(file.meta).toMatchObject({ name: "Port Test", terrain: "plains", population: 1, level: 1, chunks: 36 });
    expect(file.city.v).toBe(2);
    const back = parseSave(JSON.parse(JSON.stringify(file)));
    expect(back).toEqual(file);
    const city2 = City.fromBlob(back.city);
    expect(city2.district.name).toBe("Port Test");
    expect(city2.district.tiles.size).toBe(4);
    expect(() => parseSave({ hello: 1 })).toThrow();
    expect(() => parseSave({ format: "block-city", version: 99, city: {} })).toThrow(/newer/);
  });

  it("imports a bare Roblox city blob", () => {
    const file = parseSave({ v: 2, n: "Old", tr: "river", size: 48, cash: 77, rebirths: 0, t: [index(48, 24, 0), 1, 0, 0], c: [2, 3] });
    expect(file.meta.name).toBe("Old");
    expect(file.origin).toBe("import");
    expect(file.id).toBeTruthy();
  });

  it("slots: create, list, reopen with offline pay capped at 8 hours, delete", () => {
    const store = new SaveStore(new MemoryBackend());
    expect(store.slots().map((s) => s.meta)).toEqual([null, null, null]);
    const session = Session.create(store, 2, "river", "Riverside");
    const city = session.city;
    city.district.cash = 100_000;
    for (let i = 0; i < 36; i++) city.district.chunks.add(i);
    trunk(city, 3);
    place(city, "house", MID - 1, 1);
    place(city, "wind_turbine", MID + 1, 1);
    const t0 = 1_700_000_000_000;
    const saved = session.saveNow(t0);
    expect(saved.revision).toBe(2);
    expect(store.slots()[1].meta?.name).toBe("Riverside");
    expect(store.slots()[1].meta?.terrain).toBe("river");

    // back after a reload: nothing paid
    const quick = Session.open(store, 2, t0 + 5_000)!;
    expect(quick.offlinePaid).toBe(0);

    // back after 100 hours: paid for 8 hours of ticks at income 3
    const later = Session.open(store, 2, t0 + 100 * 3600 * 1000)!;
    const ticks = SAVE.OFFLINE_CAP_SECONDS / ECONOMY.TICK_SECONDS;
    expect(later.offlinePaid).toBe(3 * ticks);
    expect(later.city.district.cash).toBe(saved.city.cash + 3 * ticks);
    expect(later.identity.id).toBe(saved.id);
    expect(later.identity.revision).toBe(2);

    // export / import into another slot
    const text = later.exportText();
    const imported = importSaveText(store, 3, text);
    expect(imported.meta.name).toBe("Riverside");
    expect(store.slots()[2].meta?.name).toBe("Riverside");
    store.delete(2);
    expect(store.slots()[1].meta).toBeNull();
    expect(Session.open(store, 2)).toBeNull();
  });
});