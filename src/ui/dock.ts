// The build dock along the bottom: category tabs, a strip of cards with rendered thumbnails, and the
// tool buttons (inspect, turn, demolish). Also the start screen with the three save slots.
import { CATEGORIES, TILE_LIST, defByKey, isRuins, type TileDef } from "@/sim/tileDefs";
import { TERRAIN_LIST, waterMask } from "@/sim/terrains";
import { GRID } from "@/config/tuning";
import { previewUrl } from "./previews";
import type { SlotSummary } from "@/save/storage";

export type Tool = { kind: "inspect" } | { kind: "build"; key: string } | { kind: "demolish" };

const money = (n: number) => `$${n.toLocaleString()}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (html) e.innerHTML = html;
  return e;
}

// The one number a card leads with: what the building gives the city.
function headline(def: TileDef): string {
  if (def.population) return `${def.population} resident${def.population === 1 ? "" : "s"}`;
  if (def.jobs) return `${def.jobs} job${def.jobs === 1 ? "" : "s"}`;
  if (def.powerGen) return `+${def.powerGen} power`;
  if (def.roadCapacity) return `${def.roadCapacity} trips`;
  if (def.parking) return `parking, ${def.radius} cells`;
  if (def.amenity || def.cleans) return `greenery, ${def.radius} cells`;
  return "";
}

function describe(def: TileDef): string {
  const bits: string[] = [];
  if (def.roadCapacity) bits.push(`${def.roadCapacity} trips`);
  if (def.population) bits.push(`${def.population} residents`);
  if (def.jobs) bits.push(`${def.jobs} jobs`);
  if (def.powerGen) bits.push(`+${def.powerGen} power`);
  if (def.powerUse) bits.push(`${def.powerUse} power`);
  if (def.service) bits.push(`${def.service} ×${def.capacity}`);
  if (def.amenity) bits.push("park");
  if (def.pollution) bits.push(`pollutes ${def.pollution}`);
  if (def.needsWater) bits.push("by the water");
  if (def.onWater) bits.push("on the water");
  if (def.needsParking) bits.push("needs parking");
  return bits.join(" · ");
}

const TAB_ICON: Record<string, string> = {
  Roads: "road", Homes: "house", Work: "factory", Power: "wind_turbine", Services: "police",
  Fun: "cinema", Parks: "park", Shore: "pier", Water: "offshore_wind",
};

const TOOL_ICON = {
  turn: '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 0 8 8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><path d="M14 2l6 2-2 6z" fill="#fff"/></svg>',
  inspect: '<svg viewBox="0 0 24 24"><circle cx="10" cy="10" r="6.5" fill="none" stroke="#fff" stroke-width="2.6"/><path d="M15 15l6 6" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>',
  build: '<svg viewBox="0 0 24 24"><path d="M3 21l9-9" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M11 6l4-4 7 7-4 4z"/></svg>',
  demolish: '<svg viewBox="0 0 24 24"><path d="M4 6h16M9 6V4h6v2M6 6l1 15h10l1-15" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="M10 10v8M14 10v8" stroke="#fff" stroke-width="2"/></svg>',
};

type DockState = "open" | "placing" | "closed";

// The build bar has three states, as in the Roblox game:
//   open     category tabs, tools and cards
//   placing  a slim strip while a card (or demolish) is active: "Road $10 · tap a cell…  Change  Done"
//   closed   only a Build button (X on the open bar)
export class Dock {
  readonly root = el("div", "dock");
  private grip = el("div", "dock-grip");
  private main = el("div", "main");
  private top = el("div", "dock-top");
  private tabs = el("div", "tabs");
  private tools = el("div", "tools");
  private cards = el("div", "cards");
  private slim = el("div", "slim");
  private openBtn = el("button", "openbtn", `${TOOL_ICON.build}<span>Build</span>`);
  private category = 0;
  private tool: Tool = { kind: "inspect" };
  private cash = 0;
  private state: DockState = "open";

  constructor(private readonly onTool: (t: Tool) => void, onTurn: () => void) {
    this.grip.title = "Drag to move";
    this.top.append(this.tabs, this.tools);
    this.main.append(this.top, this.cards);
    this.root.append(this.grip, this.main, this.slim, this.openBtn);
    CATEGORIES.forEach((c, i) => {
      const b = el("button", "tab", `<img alt="" src="${previewUrl(TAB_ICON[c.name] ?? c.keys[0])}"><span>${c.name}</span>`);
      b.addEventListener("click", () => {
        if (i !== this.category) this.showCategory(i);
      });
      this.tabs.appendChild(b);
    });
    const tool = (cls: string, icon: string, label: string, fn: () => void, kind?: string) => {
      const b = el("button", `tool ${cls}`, `${icon}<span>${label}</span>`);
      if (kind) b.dataset.tool = kind;
      b.addEventListener("click", fn);
      this.tools.appendChild(b);
    };
    tool("", TOOL_ICON.turn, "Turn", onTurn);
    tool("", TOOL_ICON.inspect, "Inspect", () => this.setTool({ kind: "inspect" }), "inspect");
    tool("", TOOL_ICON.demolish, "Demolish", () => this.setTool({ kind: "demolish" }), "demolish");
    tool("close", "<b>X</b>", "", () => this.close());
    this.openBtn.addEventListener("click", () => this.setState("open"));
    this.slim.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "change") this.setState("open");
      else if (act === "done") this.setTool({ kind: "inspect" });
      else if (act === "turn") onTurn();
    });
    this.showCategory(0);
  }

  private setState(s: DockState): void {
    this.state = s;
    this.root.classList.toggle("placing", s === "placing");
    this.root.classList.toggle("closed", s === "closed");
  }

  close(): void {
    this.setTool({ kind: "inspect" });
    this.setState("closed");
  }

  // B key: close the bar, or open it again.
  toggle(): void {
    if (this.state === "closed") this.setState("open");
    else this.close();
  }

  private renderSlim(): void {
    const t = this.tool;
    if (t.kind === "build") {
      const def = defByKey(t.key);
      this.slim.innerHTML = `<span class="ic"><img alt="" src="${previewUrl(t.key)}"></span><b>${def.name}</b><span class="cost">$${def.cost}</span><span class="tip">tap a cell to place, R rotates</span><button data-act="turn">Turn</button><button data-act="change">Change</button><button class="done" data-act="done">Done</button>`;
    } else if (t.kind === "demolish") {
      this.slim.innerHTML = `<span class="ic red">${TOOL_ICON.demolish}</span><b>Demolish</b><span class="tip">tap a building, then confirm &middot; roads and ruins go at once &middot; Undo for a few seconds</span><button data-act="change">Change</button><button class="done" data-act="done">Done</button>`;
    }
  }

  private showCategory(i: number): void {
    this.category = i;
    this.tabs.querySelectorAll(".tab").forEach((b, j) => b.classList.toggle("on", j === i));
    this.cards.innerHTML = "";
    for (const key of CATEGORIES[i].keys) {
      const def = defByKey(key);
      const card = el("button", "card");
      card.dataset.key = key;
      card.innerHTML = `<div class="name">${def.name}</div><div class="img"><img alt="" src="${previewUrl(key)}"></div><div class="cost">$${def.cost}</div><div class="stat">${headline(def)}</div>`;
      card.title = `${def.name}, ${def.w}×${def.h} cells. ${describe(def)}`;
      card.addEventListener("click", () => this.setTool({ kind: "build", key }));
      this.cards.appendChild(card);
    }
    this.refresh();
  }

  setTool(t: Tool): void {
    this.tool = t;
    if (t.kind !== "inspect") {
      this.renderSlim();
      this.setState("placing");
    } else if (this.state === "placing") {
      this.setState("open");
    }
    this.refresh();
    this.onTool(t);
  }

  // Keys 1-9 pick a card in the open category.
  pick(n: number): void {
    const key = CATEGORIES[this.category].keys[n - 1];
    if (key) this.setTool({ kind: "build", key });
  }

  setCash(cash: number): void {
    if (cash === this.cash) return;
    this.cash = cash;
    this.refresh();
  }

  private refresh(): void {
    this.slim.classList.toggle("poor", this.tool.kind === "build" && defByKey(this.tool.key).cost > this.cash);
    for (const b of this.tools.querySelectorAll<HTMLElement>(".tool")) b.classList.toggle("on", b.dataset.tool === this.tool.kind);
    for (const c of this.cards.querySelectorAll<HTMLElement>(".card")) {
      c.classList.toggle("on", this.tool.kind === "build" && this.tool.key === c.dataset.key);
      c.classList.toggle("poor", defByKey(c.dataset.key!).cost > this.cash);
    }
  }
}

// A 12x12 picture of a map's water for the slot and new-city screens.
function mapThumb(terrain: string, size = 96): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  const n = GRID.SIZE;
  const mask = waterMask(terrain, n);
  const px = size / n;
  ctx.fillStyle = "#79b86a";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#4aa3d8";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (mask[y * n + x]) ctx.fillRect(x * px, (n - 1 - y) * px, px + 0.5, px + 0.5);
  ctx.fillStyle = "#f0a040";
  ctx.fillRect((n / 2 - 1.5) * px, size - px, 3 * px, px);
  return c;
}

export interface SlotActions {
  open: (slot: number) => void;
  create: (slot: number, terrain: string, name: string) => void;
  remove: (slot: number) => void;
  exportSlot: (slot: number) => void;
  importInto: (slot: number, text: string) => void;
}

export class StartScreen {
  readonly root = el("div", "start");
  constructor(private readonly actions: SlotActions) {}

  show(slots: SlotSummary[], canClose: boolean): void {
    this.root.classList.add("open");
    this.root.innerHTML = `<div class="sheet"><div class="head"><h1>Block City</h1>${canClose ? '<button class="x" aria-label="Close">×</button>' : ""}</div><p class="lead">Three islands to build on. Your city saves itself as you play and keeps earning for up to eight hours while you're away.</p><div class="slots"></div></div>`;
    this.root.querySelector(".x")?.addEventListener("click", () => this.hide());
    const list = this.root.querySelector(".slots")!;
    for (const s of slots) {
      const card = el("div", "slot");
      if (s.meta) {
        card.appendChild(mapThumb(s.meta.terrain));
        const info = el("div", "info", `<b>${s.meta.name}</b><div>${s.meta.population} residents · level ${s.meta.level} · ${money(s.meta.cash)}</div><div class="dim">${s.savedAt ? new Date(s.savedAt).toLocaleString() : ""}</div>`);
        card.appendChild(info);
        const acts = el("div", "acts");
        const play = el("button", "primary", "Play");
        play.addEventListener("click", () => this.actions.open(s.slot));
        const exp = el("button", "", "Export");
        exp.addEventListener("click", () => this.actions.exportSlot(s.slot));
        const del = el("button", "", "Delete");
        del.addEventListener("click", () => {
          if (confirm(`Delete ${s.meta!.name}? This can't be undone.`)) this.actions.remove(s.slot);
        });
        acts.append(play, exp, del);
        card.appendChild(acts);
      } else {
        const info = el("div", "info", `<b>${s.corrupt ? "Unreadable save" : "Empty slot"}</b><div class="dim">${s.corrupt ? "Import a file or start over." : "Start a new city here."}</div>`);
        card.appendChild(info);
        const acts = el("div", "acts");
        const create = el("button", "primary", "New city");
        create.addEventListener("click", () => this.newCity(s.slot));
        acts.appendChild(create);
        card.appendChild(acts);
      }
      const imp = el("button", "", "Import");
      imp.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.addEventListener("change", async () => {
          const f = input.files?.[0];
          if (f) this.actions.importInto(s.slot, await f.text());
        });
        input.click();
      });
      card.querySelector(".acts")!.appendChild(imp);
      list.appendChild(card);
    }
  }

  private newCity(slot: number): void {
    const sheet = this.root.querySelector(".sheet")!;
    sheet.innerHTML = `<div class="head"><h1>New city</h1><button class="back">Back</button></div><label>Name <input class="name" maxlength="20" value="My City"></label><div class="maps"></div><button class="primary go">Start building</button>`;
    let terrain = TERRAIN_LIST[0].key;
    const maps = sheet.querySelector(".maps")!;
    for (const t of TERRAIN_LIST) {
      const m = el("button", t.key === terrain ? "map on" : "map");
      m.appendChild(mapThumb(t.key, 72));
      m.appendChild(el("div", "", `<b>${t.name}</b><span>${t.desc}</span>`));
      m.addEventListener("click", () => {
        terrain = t.key;
        maps.querySelectorAll(".map").forEach((x) => x.classList.toggle("on", x === m));
      });
      maps.appendChild(m);
    }
    sheet.querySelector(".back")!.addEventListener("click", () => this.actions.open(-1));
    sheet.querySelector(".go")!.addEventListener("click", () => {
      const name = (sheet.querySelector(".name") as HTMLInputElement).value.trim() || "My City";
      this.actions.create(slot, terrain, name);
    });
  }

  hide(): void {
    this.root.classList.remove("open");
  }
}

export const BUILDABLE = TILE_LIST.filter((d) => !isRuins(d));