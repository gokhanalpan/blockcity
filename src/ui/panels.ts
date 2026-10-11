// The HUD panels. Each one owns a DOM element and re-renders from the City when asked. They never
// touch the simulation; actions go back through callbacks.
import { City } from "@/sim/city";
import { CATEGORIES, defById, defByKey, isRoadId, isRuins, type TileDef } from "@/sim/tileDefs";
import { ECONOMY, REBIRTH, SAVE } from "@/config/tuning";
import { previewUrl } from "./previews";
import { COVERAGE_COLOURS, COVERAGE_LABELS, coverageOf } from "@/render/coverage";
import { SERVICES } from "@/sim/simulation";
import type { Tile } from "@/sim/district";
import { chunkCount, rebirthBonus } from "@/sim/district";
import { levelFor } from "@/save/format";
import type { News } from "@/sim/events";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (html) e.innerHTML = html;
  return e;
}

const money = (n: number) => `$${Math.floor(n).toLocaleString()}`;

// $62.5M style, as on the Roblox HUD.
export function shortMoney(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a < 10_000) return `${sign}$${Math.floor(a)}`;
  if (a < 1e6) return `${sign}$${(a / 1e3).toFixed(a < 1e5 ? 1 : 0)}K`;
  if (a < 1e9) return `${sign}$${(a / 1e6).toFixed(a < 1e8 ? 1 : 0)}M`;
  return `${sign}$${(a / 1e9).toFixed(1)}B`;
}

// Replace a panel's HTML only when it changed, so hover states and scroll survive the tick.
function render(e: HTMLElement, html: string): void {
  if ((e as HTMLElement & { _h?: string })._h === html) return;
  e.innerHTML = html;
  (e as HTMLElement & { _h?: string })._h = html;
}

// Clicks on anything with data-anchor inside `root` jump to that tile.
function delegateJump(root: HTMLElement, onJump: (anchor: number) => void): void {
  root.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-anchor]");
    if (t && root.contains(t)) onJump(Number(t.dataset.anchor));
  });
}

// Plain words for what a building is missing.
const NEED_TEXT: Record<string, string> = {
  road: "a road connected to the entrance",
  avenue: "an avenue or highway at its door",
  power: "power (build a generator or turbine)",
  police: "a police station in reach",
  health: "a clinic in reach",
  school: "a school in reach",
  fire: "a fire station in reach",
  fun: "something fun in reach",
  "clean air": "cleaner air (move polluters away or plant greenery)",
  park: "a park or the waterfront nearby",
  jobs: "more jobs in the city",
  traffic: "a clearer road: its route to the entrance is jammed (the red road)",
  parking: "a car park in reach",
  university: "a university within 12 cells",
  burning: "the fire put out",
  blackout: "repairs after the breakdown",
  crash: "the crash cleared",
  storm: "the storm to pass",
  crime: "police to end the crime wave",
};

export class TopCards {
  readonly root = el("div", "topcards");
  private cash = el("div", "tc cash", "<b></b><span></span>");
  private pop = el("div", "tc pop", `<img alt="" src="${previewUrl("house")}"><b></b>`);
  private level = el("div", "tc level", '<div class="t"></div><div class="bar"><i></i></div>');
  constructor() {
    this.root.append(this.cash, this.pop, this.level);
  }
  update(city: City): void {
    const r = city.report;
    this.cash.querySelector("b")!.textContent = shortMoney(city.district.cash);
    this.cash.querySelector("span")!.textContent = `${r.income >= 0 ? "+" : ""}${shortMoney(r.income)} / tick`;
    this.pop.querySelector("b")!.textContent = r.population.toLocaleString();
    const L = levelFor(r.population);
    const lo = 25 * (L - 1) ** 2;
    const hi = 25 * L ** 2;
    this.level.querySelector(".t")!.textContent = `Level ${L}`;
    (this.level.querySelector(".bar i") as HTMLElement).style.width = `${Math.round((100 * (r.population - lo)) / (hi - lo))}%`;
  }
}

// Active events as pills under the top cards ("Crash on the Highway (12s left)"); click to go there.
export class EventBar {
  readonly root = el("div", "events");
  constructor(onJump: (anchor: number) => void) {
    delegateJump(this.root, onJump);
  }
  update(city: City): void {
    render(
      this.root,
      city
        .eventSummary()
        .map((ev) => {
          const good = ev.kind === "festival" || ev.kind === "rush";
          const where = ev.anchor !== undefined ? ` data-anchor="${ev.anchor}"` : "";
          return `<div class="ev ${good ? "good" : "bad"}"${where}>${ev.label} (${ev.ticksLeft * ECONOMY.TICK_SECONDS}s left)</div>`;
        })
        .join(""),
    );
  }
}

export class GoalsBoard {
  readonly root = el("div", "panel goals");
  update(city: City): void {
    const s = city.goalSummary();
    const rows = s.live.map((g) => {
      const pct = Math.round((100 * g.progress) / g.target);
      return `<div class="goal"><div class="r1"><div class="text">${g.text}</div><b>$${g.reward}</b></div><div class="r2"><div class="bar"><i style="width:${pct}%"></i></div>${g.target > 1 ? `<span>${g.progress} / ${g.target}</span>` : ""}</div></div>`;
    });
    render(this.root, `<div class="ph green">Goals&nbsp; ${s.done} / ${s.total} done</div>${rows.join("")}`);
  }
}

// Short words for the Needs list.
const NEED_SHORT: Record<string, string> = {
  road: "no road", avenue: "needs avenue", power: "no power", police: "police", health: "clinic", school: "school",
  fire: "fire station", fun: "fun", "clean air": "smoke", park: "park", jobs: "jobs", traffic: "traffic",
  parking: "parking", university: "university", burning: "on fire", blackout: "broken down", crash: "crash",
  storm: "storm", crime: "crime",
};

const GROUPS: { name: string; keys: readonly string[] }[] = (() => {
  const by = (n: string) => CATEGORIES.find((c) => c.name === n)?.keys ?? [];
  return [
    { name: "Homes", keys: by("Homes") },
    { name: "Work", keys: by("Work") },
    { name: "Power", keys: by("Power") },
    { name: "Services", keys: by("Services") },
    { name: "Fun", keys: by("Fun") },
    { name: "Parking", keys: ["car_park", "parking_garage"] },
    { name: "Parks", keys: by("Parks") },
    { name: "Shore", keys: by("Shore") },
    { name: "Water", keys: by("Water") },
  ];
})();

// Every building in the city by group; open a group to list its types (click cycles through them),
// or open Needs to see what's missing something (click jumps there).
export class BuildingsPanel {
  readonly root = el("div", "panel buildings");
  private open: string | null = null;
  private hidden = false;
  private cycle = new Map<string, number>();
  private city: City | null = null;
  private byKey = new Map<string, Tile[]>();

  constructor(private readonly onJump: (anchor: number) => void) {
    this.root.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act],[data-grp],[data-key],[data-anchor]");
      if (!t) return;
      if (t.dataset.act === "hide") this.hidden = !this.hidden;
      else if (t.dataset.grp) this.open = this.open === t.dataset.grp ? null : t.dataset.grp;
      else if (t.dataset.key) {
        const list = this.byKey.get(t.dataset.key) ?? [];
        if (list.length) {
          const i = (this.cycle.get(t.dataset.key) ?? -1) + 1;
          this.cycle.set(t.dataset.key, i % list.length);
          this.onJump(list[i % list.length].anchor);
        }
        return;
      } else if (t.dataset.anchor) {
        this.onJump(Number(t.dataset.anchor));
        return;
      }
      if (this.city) this.update(this.city);
    });
  }

  update(city: City): void {
    this.city = city;
    this.byKey.clear();
    const all: Tile[] = [];
    for (const t of city.district.tiles.values()) {
      const def = defById(t.id);
      if (isRoadId(t.id) || isRuins(def)) continue;
      all.push(t);
      const list = this.byKey.get(def.key);
      if (list) list.push(t);
      else this.byKey.set(def.key, [t]);
    }
    for (const list of this.byKey.values()) list.sort((a, b) => a.seq - b.seq);
    const needs = all.filter((t) => t.needs.length > 0).sort((a, b) => a.seq - b.seq);
    const parts = [`<div class="ph blue">Buildings&nbsp; (${all.length})<button class="hide" data-act="hide">${this.hidden ? "show" : "hide"}</button></div>`];
    if (!this.hidden) {
      for (const g of GROUPS) {
        const count = g.keys.reduce((n, k) => n + (this.byKey.get(k)?.length ?? 0), 0);
        const isOpen = this.open === g.name;
        parts.push(`<button class="grp" data-grp="${g.name}">${isOpen ? "v" : ">"} ${g.name.toUpperCase()} (${count})</button>`);
        if (isOpen) {
          const rows = g.keys.filter((k) => this.byKey.has(k)).map((k) => `<button class="sub" data-key="${k}">${defByKey(k).name}<span>×${this.byKey.get(k)!.length}</span></button>`);
          parts.push(rows.length ? rows.join("") : '<div class="empty">None yet</div>');
        }
      }
      const isOpen = this.open === "Needs";
      parts.push(`<button class="grp needs" data-grp="Needs">${isOpen ? "v" : ">"} NEEDS (${needs.length})</button>`);
      if (isOpen) {
        const rows = needs.slice(0, 40).map((t) => `<button class="sub" data-anchor="${t.anchor}">${defById(t.id).name}<span>${NEED_SHORT[t.needs[0]] ?? t.needs[0]}</span></button>`);
        parts.push(rows.length ? rows.join("") : '<div class="empty">Everything is happy</div>');
      }
    }
    render(this.root, parts.join(""));
  }
}

const ICON = {
  stats: '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="4" height="10" rx="1"/><rect x="10" y="4" width="4" height="17" rx="1"/><rect x="17" y="8" width="4" height="13" rx="1"/></svg>',
  saves: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2" opacity=".6"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
  help: '<svg viewBox="0 0 24 24"><text x="12" y="19" text-anchor="middle" font-size="20" font-weight="900" fill="#fff" font-family="inherit">?</text></svg>',
};

// The square buttons down the right edge.
export class SideButtons {
  readonly root = el("div", "side");
  constructor(actions: { stats: () => void; saves: () => void; sound: () => boolean; help: () => void }) {
    const mk = (cls: string, icon: string, label: string, fn: () => void) => {
      const b = el("button", `sb ${cls}`, `${icon}<span>${label}</span>`);
      b.addEventListener("click", fn);
      this.root.appendChild(b);
      return b;
    };
    mk("red", ICON.stats, "Stats", actions.stats);
    mk("green", ICON.saves, "Cities", actions.saves);
    const snd = mk("blue", ICON.sound, "Sound", () => {
      const on = actions.sound();
      snd.classList.toggle("off", !on);
      snd.querySelector("span")!.textContent = on ? "Sound" : "Muted";
    });
    mk("navy", ICON.help, "Help", actions.help);
  }
}

export class HelpPanel {
  readonly root = el(
    "div",
    "panel helpbox",
    `<div class="ph navy">How to play<button class="hide" data-act="close">close</button></div>
    <p>Pick a building in the bar at the bottom, then tap a cell to place it. Buildings only work with a road connected to the entrance (the orange marks on the front edge) and power.</p>
    <p>Homes fill up while they're happy: power, jobs, services in reach, parks, no smoke. Roads turn red when they carry more than they can.</p>
    <p>Tap the dark land to buy it. Tap any building to see what it needs.</p>
    <table>
      <tr><td>Pan</td><td>drag, or W A S D / arrows</td></tr>
      <tr><td>Zoom</td><td>mouse wheel or pinch</td></tr>
      <tr><td>Turn view</td><td>Q / E, or right-drag</td></tr>
      <tr><td>Turn building</td><td>R</td></tr>
      <tr><td>Pick a card</td><td>1 to 9</td></tr>
      <tr><td>Demolish / inspect</td><td>0 / Esc</td></tr>
      <tr><td>Build bar</td><td>B opens and closes it</td></tr>
      <tr><td>Panels</td><td>drag them by their coloured header</td></tr>
    </table>
    <button class="reset" data-act="reset">Put the panels back</button>`,
  );
  constructor(onReset: () => void) {
    this.root.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).dataset.act;
      if (act === "close") this.toggle();
      else if (act === "reset") onReset();
    });
  }
  toggle(): void {
    this.root.classList.toggle("open");
  }
}

// A road's traffic, as in the Roblox panel: "Traffic: 98% of capacity (240 trips/tick)", a bar that
// goes amber then red with the road's colour on the map, and what to do when it's jammed.
const UPGRADE: Record<string, string> = {
  road: "upgrade it to an avenue (240 trips) or a highway (800)",
  avenue: "upgrade it to a highway (800 trips)",
  bridge: "upgrade it to a Highway Bridge (800 trips), or build a second crossing",
  highway_bridge: "build a second crossing to share the load",
  highway: "build a second route to share the load",
};

function roadTraffic(t: Tile, def: TileDef): string[] {
  const pct = def.roadCapacity > 0 ? Math.round((100 * t.load) / def.roadCapacity) : 0;
  const band = t.jammed || pct >= 85 ? "low" : pct >= 20 ? "mid" : ""; // same bands as the road's colour
  const out = [
    `<div class="row traffic ${band}">Traffic: <b>${pct}%</b> of capacity (${def.roadCapacity} trips/tick)</div>`,
    `<div class="bar ${band}"><i style="width:${Math.min(100, pct)}%"></i></div>`,
  ];
  if (t.event === "crash") out.push(`<div class="row bad">Blocked by a crash: traffic is backing up until it's cleared</div>`);
  else if (t.jammed) out.push(`<div class="row bad">Jammed: ${t.load} trips on a road for ${def.roadCapacity}, so traffic backs up behind it. To fix it, ${UPGRADE[def.key] ?? "add another route"}.</div>`);
  else if (!t.reachable) out.push(`<div class="row bad">Not connected to the entrance</div>`);
  else if (pct >= 85) out.push(`<div class="row">Nearly full: ${UPGRADE[def.key] ?? "add another route"} before it jams</div>`);
  return out;
}

// The jammed road on a building's way to the entrance: follow its access road towards the entrance
// until a road is over capacity. That's the stretch to upgrade.
export function jamOnRoute(city: City, t: Tile): number | undefined {
  let cur = t.access;
  for (let guard = 0; cur !== undefined && guard < 10000; guard++) {
    const road = city.district.tiles.get(cur);
    if (!road) return undefined;
    if (road.jammed) return road.anchor;
    cur = road.parent;
  }
  return undefined;
}

export class InspectPanel {
  readonly root = el("div", "inspect");
  private anchor: number | null = null;
  constructor(
    private readonly onDemolish: (t: Tile) => void,
    private readonly onClose: () => void,
    private readonly onJump: (anchor: number) => void = () => {},
  ) {}
  show(anchor: number | null): void {
    this.anchor = anchor;
    this.root.classList.toggle("open", anchor !== null);
  }
  update(city: City): void {
    const t = this.anchor === null ? undefined : city.district.tiles.get(this.anchor);
    if (!t) {
      this.root.innerHTML = "";
      this.root.classList.remove("open");
      return;
    }
    const def = defById(t.id);
    const parts: string[] = [`<div class="ph blue">${def.name}<button class="xr" aria-label="Close">X</button></div>`];
    parts.push(`<div class="pic"><img alt="" src="${previewUrl(def.key)}"></div><div class="info">`);
    parts.push(`<div class="chips">${this.chips(t, def).map((c) => `<span class="chip ${c[1]}">${c[0]}</span>`).join("")}</div>`);
    if (def.population > 0) {
      parts.push(`<div class="row">Residents ${t.occ} of ${def.population}</div><div class="bar"><i style="width:${(100 * t.occ) / def.population}%"></i></div>`);
      parts.push(`<div class="row">Mood ${t.mood}/10 · ${t.growthDelta > 0 ? "people are moving in" : t.growthDelta < 0 ? "people are leaving" : "steady"}</div>`);
    }
    if (def.jobs > 0) parts.push(`<div class="row">${def.jobs} jobs${t.needs.includes("traffic") || t.needs.includes("crime") ? " (half offered)" : ""}</div>`);
    const cover = coverageOf(def);
    if (cover) {
      const hex = `#${COVERAGE_COLOURS[cover.kind].toString(16).padStart(6, "0")}`;
      parts.push(`<div class="row area"><span class="swatch" style="background:${hex}"></span>Shaded on the map: ${COVERAGE_LABELS[cover.kind]}, ${cover.radius} cells around it</div>`);
    }
    if (def.service) parts.push(`<div class="row">${def.service === "fun" ? "Fun" : def.service === "health" ? "Health" : def.service[0].toUpperCase() + def.service.slice(1)} for ${t.served}${def.capacity ? ` of ${def.capacity}` : ""} residents within ${def.radius} cells</div>`);
    if (def.amenity) parts.push(`<div class="row">Cheers up homes within ${def.radius} cells</div>`);
    if (def.cleans) parts.push(`<div class="row">Cleans ${def.cleans} pollution within ${def.radius} cells</div>`);
    if (def.powerGen) parts.push(`<div class="row">Makes ${def.powerGen} power</div>`);
    if (def.incomeBonus) parts.push(`<div class="row">+${Math.round(def.incomeBonus * 100)}% city income while working</div>`);
    if (def.parking) parts.push(`<div class="row">Parking for big venues within ${def.radius} cells</div>`);
    if (isRoadId(t.id)) parts.push(...roadTraffic(t, def));
    const needs = t.needs.filter((n) => NEED_TEXT[n]);
    const jam = t.needs.includes("traffic") ? jamOnRoute(city, t) : undefined;
    if (needs.length) {
      const items = needs.map((n) => `<li>${NEED_TEXT[n]}${n === "traffic" && jam !== undefined ? ` <button class="showjam" data-jam="${jam}">Show the jam</button>` : ""}</li>`);
      parts.push(`<div class="needs"><div>Needs</div><ul>${items.join("")}</ul></div>`);
    }
    else if (!isRoadId(t.id)) parts.push(`<div class="row good">Everything it needs is here.</div>`);
    parts.push("</div>");
    const refund = Math.floor(def.cost * def.refundRate);
    parts.push(`<button class="danger">${def.key.startsWith("ruins") ? "Clear the ruins (free)" : `Demolish&nbsp; +${money(refund)}`}</button>`);
    this.root.innerHTML = parts.join("");
    this.root.querySelector(".xr")!.addEventListener("click", () => this.onClose());
    this.root.querySelector(".showjam")?.addEventListener("click", (e) => this.onJump(Number((e.currentTarget as HTMLElement).dataset.jam)));
    this.root.querySelector(".danger")!.addEventListener("click", () => this.onDemolish(t));
  }
  private chips(t: Tile, def: TileDef): [string, string][] {
    const out: [string, string][] = [];
    if (t.event) out.push([t.event === "burning" ? "On fire" : t.event === "blackout" ? "Broken down" : t.event === "crash" ? "Crash" : t.event === "storm" ? "Storm" : "Crime wave", "bad"]);
    if (isRoadId(t.id)) out.push(t.reachable ? ["Connected", "good"] : ["Not connected", "bad"]);
    else if (def.needsRoad) out.push(t.active ? ["Road ok", "good"] : ["No road", "bad"]);
    if (def.needsPower) out.push(t.powered ? ["Powered", "good"] : ["No power", "bad"]);
    if (def.needsParking) out.push(t.needs.includes("parking") ? ["No parking", "bad"] : ["Parking ok", "good"]);
    return out;
  }
}

// The city overview, laid out like the Roblox stats window: the city name (type and press Enter to
// rename), two columns of rows with an icon, the value, a bar and a line of detail, and rebirth.
export class StatsPanel {
  readonly root = el("div", "stats");
  private head = el("div", "sh");
  private name = document.createElement("input");
  private body = el("div", "sbody");
  open = false;
  private city: City | null = null;

  constructor(actions: { close: () => void; rename: (name: string) => void; rebirth: () => void }) {
    this.name.className = "sname";
    this.name.maxLength = SAVE.MAX_NAME;
    this.name.spellcheck = false;
    const x = el("button", "xr", "X");
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", () => actions.close());
    this.head.append(this.name, el("span", "shint", "Enter to<br>rename"), x);
    this.root.append(this.head, this.body);
    this.name.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        actions.rename(this.name.value);
        this.name.blur();
      } else if (e.key === "Escape") this.name.blur();
    });
    this.name.addEventListener("blur", () => {
      if (this.city) this.name.value = this.city.district.name;
    });
    this.body.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-act=rebirth]")) actions.rebirth();
    });
  }

  toggle(): void {
    this.open = !this.open;
    this.root.classList.toggle("open", this.open);
  }

  update(city: City): void {
    this.city = city;
    if (document.activeElement !== this.name) this.name.value = city.district.name;
    if (!this.open) return;
    const r = city.report;
    const d = city.district;
    const img = (key: string) => `<img alt="" src="${previewUrl(key)}">`;
    const glyph = (g: string) => `<span>${g}</span>`;
    const pct = (f: number) => `${Math.round(f * 100)}%`;
    const band = (f: number) => (f >= 0.8 ? "" : f >= 0.4 ? "mid" : "low");
    const row = (icon: string, title: string, value: string, sub: string, frac?: number, colourValue = false) => {
      const b = frac === undefined ? "" : band(frac);
      const bar = frac === undefined ? "" : `<div class="bar ${b}"><i style="width:${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%"></i></div>`;
      return `<div class="srow"><div class="sic">${icon}</div><div class="smain"><div class="st"><b>${title}</b><span class="${colourValue ? b : ""}">${value}</span></div>${bar}<div class="ss" title="${sub}">${sub}</div></div></div>`;
    };
    const service = (name: "health" | "school" | "police" | "fire" | "fun", key: string, title: string, what: string) => {
      const f = r.coverage[name] ?? 0;
      const i = r.services[name];
      return row(img(key), title, pct(f), `${what}${i.buildings ? `  -  ${i.full} of ${i.buildings} full` : ""}`, f, true);
    };
    const mood = r.happiness >= 7 ? "residents are happy" : r.happiness >= 4 ? "residents are content" : "residents are unhappy";
    const jobsFrac = r.population > 0 ? r.jobs / r.population : r.jobs > 0 ? 1 : 0;
    const left = [
      row(img("house"), "Population", r.population.toLocaleString(), `room for ${r.capacity.toLocaleString()}`),
      row(glyph(":)"), "Happiness", `${r.happiness.toFixed(1)} / 10`, mood, r.happiness / 10),
      row(img("factory"), "Jobs", r.jobs.toLocaleString(), `for ${r.population.toLocaleString()} residents${r.jobs < r.population ? `, ${r.population - r.jobs} without work` : ""}`, jobsFrac),
      row(img("generator"), "Power", pct(r.coverage.power ?? 0), `homes powered  -  ${r.powerUse} / ${r.powerGen} used${r.brownout ? ", brownout" : ""}`, r.coverage.power ?? 0, true),
      row(glyph("$"), "Income", `${r.income >= 0 ? "+" : ""}${shortMoney(r.income)} / tick`, `${shortMoney(d.cash)} in the bank${r.bonus ? `, landmarks +${Math.round(r.bonus * 100)}%` : ""}`),
      row(glyph("#"), "Land", `${chunkCount(d)} / ${city.chunkTotal()}`, "chunks owned"),
      row(img("road"), "Traffic", pct(r.coverage.traffic ?? 1), `homes with a clear route  -  ${r.traffic.trips} trips/tick, ${r.traffic.jammed} of ${r.traffic.roads} roads jammed`, r.coverage.traffic ?? 1, true),
    ];
    const right = [
      service("health", "clinic", "Health", "homes served by a clinic"),
      service("school", "school", "Education", "homes served by a school"),
      service("police", "police", "Safety", "homes served by police"),
      service("fire", "fire_station", "Fire cover", "homes served by a fire station"),
      service("fun", "cinema", "Entertainment", "homes with something fun nearby"),
      row(img("park"), "Parks", pct(r.coverage.park ?? 0), "homes with a park nearby", r.coverage.park ?? 0, true),
      row(glyph("~"), "Waterfront", pct(r.coverage.water ?? 0), "homes by the water", r.coverage.water ?? 0, true),
    ];
    const ready = r.population >= REBIRTH.MIN_POP;
    const nextCash = ECONOMY.STARTING_CASH + REBIRTH.START_CASH * (d.rebirths + 1);
    const rebirth = `<div class="rebirth"><div>Rebirths: ${d.rebirths} (income +${Math.round(rebirthBonus(d) * 100)}%). Rebirth wipes the city but adds +${Math.round(REBIRTH.INCOME_BONUS * 100)}% income for good (up to +${Math.round(REBIRTH.MAX_BONUS * 100)}%) and $${nextCash} to start.${ready ? "" : ` Needs ${REBIRTH.MIN_POP} residents.`}</div><button data-act="rebirth"${ready ? "" : " disabled"}>Rebirth</button></div>`;
    render(this.body, `<div class="scol">${left.join("")}</div><div class="scol">${right.join("")}</div>${rebirth}`);
  }
}

export class Toasts {
  readonly root = el("div", "toasts");
  constructor(private readonly onJump: (anchor: number) => void) {}
  push(n: News): void {
    const jump = n.anchor !== undefined;
    const line = el("div", `toast ${n.good ? "good" : "bad"}${jump ? " jump" : ""}`, jump ? `${n.text} <span>Show</span>` : n.text);
    if (jump) line.addEventListener("click", () => this.onJump(n.anchor!));
    this.root.appendChild(line);
    while (this.root.children.length > 4) this.root.firstChild?.remove();
    const life = jump ? 9000 : 6000; // alerts you can act on stay a little longer
    setTimeout(() => line.classList.add("fade"), life - 800);
    setTimeout(() => line.remove(), life);
  }

  // A toast with a button (Undo). The button works until the toast is gone; it can be pressed once.
  action(text: string, label: string, run: () => void, life = 8000): void {
    const line = el("div", "toast good jump", `${text} <span>${label}</span>`);
    line.addEventListener(
      "click",
      () => {
        line.remove();
        run();
      },
      { once: true },
    );
    this.root.appendChild(line);
    while (this.root.children.length > 4) this.root.firstChild?.remove();
    setTimeout(() => line.classList.add("fade"), life - 800);
    setTimeout(() => line.remove(), life);
  }
}

export class Feed {
  readonly root = el("div", "panel citizens");
  private hidden = false;
  private city: City | null = null;
  constructor(onJump: (anchor: number) => void) {
    delegateJump(this.root, onJump);
    this.root.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).dataset.act === "hide") {
        this.hidden = !this.hidden;
        if (this.city) this.update(this.city);
      }
    });
  }
  update(city: City): void {
    this.city = city;
    const lines = this.hidden
      ? []
      : city
          .feedLines()
          .slice(-6)
          .map((l) => `<div class="line" data-anchor="${l.anchor}"><b class="${l.good ? "g" : "b"}">${l.who}</b> ${l.text}</div>`);
    render(this.root, `<div class="ph purple">Citizens<button class="hide" data-act="hide">${this.hidden ? "show" : "hide"}</button></div>${lines.join("") || (this.hidden ? "" : '<div class="empty">Your citizens will have things to say soon.</div>')}`);
  }
}