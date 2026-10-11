import { describe, expect, it } from "vitest";
import { EVENTS } from "@/config/tuning";
import { addTile, index } from "@/sim/district";
import { startEvent, stepEvents } from "@/sim/events";
import { GOAL_LIST, goalBoard, stepGoals, summarizeGoals } from "@/sim/goals";
import { stepFeed } from "@/sim/citizenFeed";
import { defByKey } from "@/sim/tileDefs";
import { MID, place, richCity, seeded, tileAt, trunk } from "./helpers";

const quiet = () => 0.99; // an RNG that never starts a random event

describe("events", () => {
  it("an unattended fire burns a building down into ruins of the same size", () => {
    const city = richCity();
    city.rng = quiet;
    trunk(city, 6);
    place(city, "wind_turbine", MID + 1, 1);
    place(city, "factory", MID - 2, 1); // 2x2, weight 4 (pollution 2)
    const anchor = index(48, MID - 2, 1);
    const e = startEvent(city.events, city.district, "fire", city.report, seeded(3));
    expect(e?.kind).toBe("fire");
    expect(e?.anchor).toBe(anchor);
    city.refresh();
    expect(tileAt(city, MID - 2, 1).needs).toContain("burning");
    expect(tileAt(city, MID - 2, 1).active).toBe(false);
    city.tick();
    expect(city.eventSummary()[0].fighting).toBe(false); // no station in reach
    for (let i = 1; i < EVENTS.FIRE_TICKS; i++) city.tick(); // (the tick above was the first)
    const t = tileAt(city, MID - 2, 1);
    expect(defByKey("ruins_2").id).toBe(t.id);
    expect(city.events.events).toHaveLength(0);
    expect(city.news.some((n) => n.text.includes("burnt down"))).toBe(true);
    // clearing ruins is free and counts for the goal
    const cash = city.district.cash;
    expect(city.remove(MID - 2, 1).ok).toBe(true);
    expect(city.district.cash).toBe(cash);
    expect(city.district.counters.ruinsCleared).toBe(1);
  });

  it("a working fire station in reach puts the fire out in 4 ticks after it arrives", () => {
    const city = richCity();
    city.rng = quiet;
    trunk(city, 8);
    place(city, "solar_farm", MID + 1, 1);
    place(city, "fire_station", MID + 1, 3);
    place(city, "house", MID - 1, 1);
    // candidates in placement order: solar farm (weight 2), fire station (1), house (1): 0.9 * 4 lands on the house
    const e = startEvent(city.events, city.district, "fire", city.report, () => 0.9);
    expect(e?.anchor).toBe(index(48, MID - 1, 1));
    expect(city.eventSummary()[0].fighting).toBe(false);
    city.tick(); // the first tick clamps the countdown to FIRE_FIGHT_TICKS
    expect(city.events.events[0].ticksLeft).toBe(EVENTS.FIRE_FIGHT_TICKS);
    expect(city.eventSummary()[0].fighting).toBe(true); // the renderer shows the water spray from this
    for (let i = 0; i < EVENTS.FIRE_FIGHT_TICKS; i++) city.tick();
    expect(tileAt(city, MID - 1, 1).id).toBe(defByKey("house").id);
    expect(city.district.counters.firesFought).toBe(1);
    expect(city.events.events).toHaveLength(0);
  });

  it("a crash blocks a busy road and clears after the tier's ticks", () => {
    const city = richCity();
    city.rng = quiet;
    trunk(city, 4);
    place(city, "house", MID - 1, 1);
    place(city, "wind_turbine", MID + 1, 1);
    const e = startEvent(city.events, city.district, "crash", city.report, seeded(1));
    expect(e?.kind).toBe("crash");
    expect(e?.ticksLeft).toBe(EVENTS.CRASH_TICKS.road);
    city.refresh();
    expect(tileAt(city, MID - 1, 1).needs).toContain("traffic");
    for (let i = 0; i < EVENTS.CRASH_TICKS.road; i++) city.tick();
    expect(city.district.fx.roadBlocked.size).toBe(0);
    expect(tileAt(city, MID - 1, 1).needs).not.toContain("traffic");
  });

  it("a crime wave halves jobs until police cover the workplaces", () => {
    const city = richCity();
    city.rng = quiet;
    trunk(city, 8);
    place(city, "solar_farm", MID + 1, 1);
    place(city, "office", MID + 1, 3); // 20 jobs
    const e = startEvent(city.events, city.district, "crime", city.report, seeded(1));
    expect(e?.cells).toEqual([index(48, MID + 1, 3)]);
    city.refresh();
    expect(city.report.jobs).toBe(10);
    place(city, "police", MID - 2, 1);
    city.tick();
    expect(city.events.events).toHaveLength(0);
    expect(city.report.jobs).toBe(20 + 2);
  });

  it("festival needs a stadium or wheel; rush needs 20 empty beds", () => {
    const city = richCity();
    expect(startEvent(city.events, city.district, "festival", city.report)).toBeUndefined();
    expect(startEvent(city.events, city.district, "rush", city.report)).toBeUndefined();
    trunk(city, 8);
    addTile(city.district, defByKey("tower").id, MID - 2, 1, 0, 0);
    city.refresh();
    const rush = startEvent(city.events, city.district, "rush", city.report);
    expect(rush?.kind).toBe("rush");
    expect(city.district.fx.growthMult).toBe(EVENTS.RUSH_GROWTH_MULT);
  });

  it("random events start only with 10+ residents, respect the cooldown and the active cap", () => {
    const city = richCity();
    trunk(city, 20);
    place(city, "nuclear_plant", MID + 1, 1);
    for (let i = 0; i < 4; i++) addTile(city.district, defByKey("tower").id, MID - 2, 1 + i * 2, 0, 40);
    for (let i = 0; i < 4; i++) addTile(city.district, defByKey("factory").id, MID + 1, 3 + i * 2, 0);
    city.refresh();
    const always = () => 0; // every roll succeeds, the first weighted kind is picked
    for (let i = 0; i < EVENTS.FIRST_COOLDOWN_TICKS - 1; i++) stepEvents(city.events, city.district, city.report, always);
    expect(city.events.events).toHaveLength(0);
    stepEvents(city.events, city.district, city.report, always);
    expect(city.events.events).toHaveLength(1);
    expect(city.events.cooldown).toBe(EVENTS.COOLDOWN_TICKS);
    for (let i = 0; i < 200; i++) stepEvents(city.events, city.district, city.report, always);
    expect(city.events.events.length).toBeLessThanOrEqual(EVENTS.MAX_ACTIVE);
  });
});

describe("goals", () => {
  it("the board is the first three unfinished goals and pays each once", () => {
    const city = richCity();
    expect(goalBoard(city.district).map((g) => g.key)).toEqual(["pop_10", "shop", "powered"]);
    trunk(city, 4);
    addTile(city.district, defByKey("tower").id, MID - 2, 1, 0, 12);
    city.refresh();
    const cash = city.district.cash;
    const news = stepGoals(city.district, city.report);
    expect(news).toHaveLength(1);
    expect(city.district.cash).toBe(cash + 500);
    expect(stepGoals(city.district, city.report)).toHaveLength(0);
    expect(goalBoard(city.district).map((g) => g.key)).toEqual(["shop", "powered", "park"]);
    const s = summarizeGoals(city.district, city.report);
    expect(s.done).toBe(1);
    expect(s.total).toBe(GOAL_LIST.length);
    expect(s.live[0]).toMatchObject({ key: "shop", progress: 0, target: 1 });
  });

  it("coverage goals wait for the minimum population", () => {
    const g = GOAL_LIST.find((x) => x.key === "police_80")!;
    const city = richCity();
    expect(g.check(city.district, city.report)).toEqual([0, 1]);
  });
});

describe("citizen feed", () => {
  it("complains about needs every few ticks and drops lines about demolished buildings", () => {
    const city = richCity();
    place(city, "house", 10, 10); // no road
    const rng = seeded(7);
    let lines = city.feedLines();
    for (let i = 0; i < 4; i++) lines = stepFeed(city.feed, city.district, rng, 1000);
    expect(lines).toHaveLength(1);
    expect(lines[0].good).toBe(false);
    expect(lines[0].text).toContain("House");
    city.remove(10, 10);
    expect(stepFeed(city.feed, city.district, rng, 1000)).toHaveLength(0);
  });
});