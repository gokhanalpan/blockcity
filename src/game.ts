// Boots the game: start screen -> session -> world + HUD. Everything the player does goes through
// the City; the world and panels redraw from its change events.

import * as THREE from "three";
import { ECONOMY, EVENTS, GRID } from "@/config/tuning";
import { City } from "@/sim/city";
import { chunkCoords, chunkOfCell, footprint, type Tile } from "@/sim/district";
import { defByKey, defById } from "@/sim/tileDefs";
import { SaveStore, Session, importSaveText } from "@/save/storage";
import { createScene, fitShadow } from "@/render/scene";
import { CityCamera } from "@/render/camera";
import { Input } from "@/render/input";
import { Labels } from "@/render/labels";
import { WorldView } from "@/render/world";
import { Traffic } from "@/render/traffic";
import { CELL } from "@/render/coords";
import { Dock, StartScreen, type Tool } from "@/ui/dock";
import { BuildingsPanel, EventBar, Feed, GoalsBoard, HelpPanel, InspectPanel, SideButtons, StatsPanel, Toasts, TopCards } from "@/ui/panels";
import { Sounds } from "@/ui/sounds";
import { Draggables } from "@/ui/drag";

const REASON_TEXT: Record<string, string> = {
  no_cash: "Not enough cash",
  occupied: "Something is already there",
  locked_land: "You don't own that land yet",
  water: "Can't build on water",
  needs_water: "That only goes on water",
  needs_shore: "That needs to touch the water",
  needs_mooring: "That needs land or a bridge alongside",
  needs_water_nearby: "That needs water within a few cells",
  front_off_map: "Its entrance would face off the island",
  out_of_bounds: "Off the island",
  locked: "Not unlocked yet",
};

// Cursors per tool. Demolish gets a red wrecking-ball badge so it's obvious a click removes things.
const DEMOLISH_CURSOR = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="14" fill="#e2463b" stroke="#fff" stroke-width="2.5"/>
    <path d="M10 11h12M14 11V9h4v2M12 11l1 12h6l1-12" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
  </svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, not-allowed`;
})();

// ?demo: a small starter city for screenshots and play-testing.
function buildDemo(city: City): void {
  const d = city.district;
  d.cash = 120_000;
  for (let i = 0; i < 36; i++) d.chunks.add(i);
  const mid = Math.floor(d.size / 2);
  const put = (key: string, x: number, y: number, rot = 0) => city.place(defByKey(key).id, x, y, rot);
  for (let y = 1; y < 14; y++) put(y < 4 ? "avenue" : "road", mid, y);
  for (let x = mid - 8; x <= mid + 8; x++) if (x !== mid) put("road", x, 6);
  for (let x = mid - 8; x <= mid + 8; x++) if (x !== mid) put("road", x, 12);
  put("avenue", mid, 0);
  put("wind_turbine", mid + 1, 1); put("solar_farm", mid + 1, 2); put("generator", mid - 2, 1);
  put("house", mid - 1, 2); put("house", mid - 1, 3); put("cottage", mid - 1, 4); put("townhouse", mid - 1, 5);
  put("house", mid + 1, 4); put("bakery", mid + 1, 5);
  for (let x = mid - 8; x < mid - 1; x += 1) put(x % 2 ? "house" : "cottage", x, 5);
  for (let x = mid + 2; x < mid + 8; x += 1) put(x % 2 ? "townhouse" : "house", x, 7);
  put("shop", mid + 2, 5); put("diner", mid + 3, 5);
  put("apartment", mid - 3, 7); put("villa", mid - 5, 7); put("duplex", mid - 8, 7);
  put("police", mid + 1, 9); put("clinic", mid + 3, 9); put("school", mid - 3, 9); put("fire_station", mid - 5, 9);
  put("park", mid - 1, 7); put("playground", mid - 1, 8); put("garden", mid + 1, 11);
  put("factory", mid + 6, 9); put("tree_line", mid + 5, 11);
  put("office", mid - 3, 13); put("cinema", mid + 1, 13); put("ferris_wheel", mid + 4, 13); put("car_park", mid - 6, 13);
  put("house", 5, 30); put("tower", mid - 8, 10, 0);
  // an airport behind the town (planes!), with a nuclear plant to power it
  for (let y = 14; y <= 16; y++) put("road", mid, y);
  for (let x = mid - 5; x <= mid + 9; x++) if (x !== mid) put("road", x, 16);
  put("nuclear_plant", mid + 8, 14);
  put("airport", mid - 5, 17);
  d.cash = 30_000;
  for (const t of d.tiles.values()) if (defById(t.id).population > 0) t.occ = Math.floor(defById(t.id).population / 2);
  city.refresh();
}

function devFireFor(city: City): number | undefined {
  let best: Tile | undefined;
  for (const t of city.district.tiles.values()) {
    const def = defById(t.id);
    if (def.roadCapacity > 0 || def.onWater || def.key.startsWith("ruins")) continue;
    if (!best || def.key === "tower" || (defById(best.id).key !== "tower" && def.w * def.h > defById(best.id).w * defById(best.id).h)) best = t;
  }
  if (!best) return undefined;
  city.events.events.push({ id: 999, kind: "fire", anchor: best.anchor, ticksLeft: EVENTS.FIRE_TICKS, label: `Fire at the ${defById(best.id).name}` });
  city.district.fx.disabled.set(best.anchor, "burning");
  city.refresh();
  return best.anchor;
}

export function startGame(root: HTMLElement): void {
  const store = new SaveStore();
  const sounds = new Sounds();
  const params = new URLSearchParams(location.search);

  root.innerHTML = `<canvas class="view"></canvas><div class="labels"></div><div class="hud"></div>`;
  const canvas = root.querySelector<HTMLCanvasElement>(".view")!;
  const labels = new Labels(root.querySelector<HTMLElement>(".labels")!);
  const hud = root.querySelector<HTMLElement>(".hud")!;
  const drag = new Draggables(hud);

  const rig = createScene(canvas);
  const extent = GRID.SIZE * CELL;
  fitShadow(rig.sun, new THREE.Vector3(extent / 2, 0, extent / 2), extent + 40);
  const cam = new CityCamera(rig.camera);
  cam.setBounds(extent, 24);
  // the Roblox view: from the front-left corner, the main road running away on the left
  const homeView = () => {
    cam.setYaw(THREE.MathUtils.degToRad(62));
    cam.focus(new THREE.Vector3(extent * 0.52, 0, extent * 0.42), 235);
  };
  homeView();

  let session: Session | null = null;
  let world: WorldView | null = null;
  let traffic: Traffic | null = null;
  let city: City | null = null;
  let tool: Tool = { kind: "inspect" };
  let rot = 0;
  let hover: [number, number] | null = null;
  let hoverBuilding: number | undefined; // a building model under the pointer (roads don't count: they're ground)
  let ghostCell: [number, number] = [0, 0];
  let unsubscribe: (() => void) | null = null;

  // ---- panels
  const jumpTo = (anchor: number) => {
    const p = world?.worldOf(anchor);
    if (!p) return;
    cam.focus(p, 55);
    select(anchor);
  };
  const toasts = new Toasts(jumpTo);
  const topCards = new TopCards();
  const events = new EventBar(jumpTo);
  const buildings = new BuildingsPanel(jumpTo);
  const help = new HelpPanel(() => drag.reset());
  const side = new SideButtons({
    stats: () => {
      stats.toggle();
      refreshPanels();
    },
    saves: () => openStart(true),
    sound: () => (sounds.enabled = !sounds.enabled),
    help: () => help.toggle(),
  });
  const goals = new GoalsBoard();
  const inspect = new InspectPanel(
    (t) => {
      demolishNow(t);
      select(null);
    },
    () => select(null),
    (anchor) => jumpTo(anchor), // "Show the jam": fly to the jammed road and select it
  );
  const stats = new StatsPanel({
    close: () => stats.toggle(),
    rename: (name) => {
      if (city?.rename(name)) notify(`Your city is now called ${city.district.name}`, true);
    },
    rebirth: () => {
      if (!city) return;
      if (!confirm(`Rebirth ${city.district.name}? The city is wiped and you start again on the same map with more income for good.`)) return;
      if (city.rebirth()) {
        select(null);
        stats.toggle();
        notify(`Rebirth ${city.district.rebirths}: income +${city.district.rebirths * 10}% for good`, true);
      }
    },
  });
  const feed = new Feed(jumpTo);
  const dock = new Dock(
    (t) => {
      tool = t;
      if (t.kind === "demolish") select(null);
      disarm();
      updateGhost();
      updateCursor();
    },
    () => turn(),
  );
  const start = new StartScreen({
    open: (slot) => {
      if (slot < 0) return openStart(session !== null);
      const s = Session.open(store, slot);
      if (s) load(s);
    },
    create: (slot, terrain, name) => load(Session.create(store, slot, terrain, name)),
    remove: (slot) => {
      store.delete(slot);
      openStart(session !== null);
    },
    exportSlot: (slot) => {
      const file = session && session.slot === slot ? session.exportText() : JSON.stringify(store.load(slot));
      const name = store.slots()[slot - 1].meta?.name ?? "city";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([file], { type: "application/json" }));
      a.download = `block-city-${name.replace(/[^\w-]+/g, "_")}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    importInto: (slot, text) => {
      try {
        importSaveText(store, slot, text);
        openStart(session !== null);
      } catch (e) {
        alert(`Couldn't import that file: ${(e as Error).message}`);
      }
    },
  });
  const left = document.createElement("div");
  left.className = "leftcol";
  left.append(goals.root, buildings.root, feed.root);
  const centre = document.createElement("div");
  centre.className = "centre";
  centre.append(topCards.root, events.root, toasts.root);
  hud.append(left, centre, side.root, inspect.root, stats.root, dock.root, help.root, start.root);
  // every panel can be moved; positions are remembered between visits
  drag.add(topCards.root, "top", null);
  drag.add(goals.root, "goals", ".ph");
  drag.add(buildings.root, "buildings", ".ph");
  drag.add(feed.root, "citizens", ".ph");
  drag.add(inspect.root, "inspect", ".ph");
  drag.add(stats.root, "statsPanel", ".sh");
  drag.add(help.root, "help", ".ph");
  drag.add(side.root, "side", null);
  drag.add(dock.root, "dock", ".dock-grip, .slim .ic, .slim b, .slim .tip");

  function devFire(): void {
    const anchor = city ? devFireFor(city) : undefined;
    if (anchor === undefined) return;
    jumpTo(anchor);
    // ?fire=fought: a few seconds in, a fire station starts putting it out (to check the water and steam)
    if (params.get("fire") === "fought") {
      setTimeout(() => {
        const e = city?.events.events.find((x) => x.id === 999);
        if (e && city) {
          e.fighting = true;
          city.refresh();
        }
      }, 4000);
    }
  }

  function openStart(canClose: boolean): void {
    hud.classList.toggle("nocity", !canClose);
    start.show(store.slots(), canClose);
  }

  function load(s: Session): void {
    if (session) session.saveNow();
    if (world) {
      rig.scene.remove(world.group);
      world.dispose();
    }
    if (traffic) rig.scene.remove(traffic.group);
    unsubscribe?.();
    session = s;
    city = s.city;
    if (params.has("demo") && city.district.tiles.size <= 1) buildDemo(city);
    world = new WorldView(city, labels);
    rig.scene.add(world.group);
    traffic = new Traffic(city);
    rig.scene.add(traffic.group);
    input.pickables = world.chunkMeshes;
    input.tiles = () => world?.tileObjects() ?? [];
    unsubscribe = city.onChange((c) => {
      refreshPanels();
      traffic?.refresh();
      if (c.kind === "tick") for (const n of city!.news) notify(n.text, n.good, n.anchor);
    });
    tool = { kind: "inspect" };
    dock.setTool(tool);
    homeView();
    refreshPanels();
    hud.classList.remove("nocity");
    start.hide();
    if (s.offlinePaid > 0) notify(`Welcome back. ${city.district.name} earned $${s.offlinePaid.toLocaleString()} while you were away.`, true);
  }

  function notify(text: string, good: boolean, anchor?: number): void {
    toasts.push({ text, good, anchor });
    if (text.startsWith("Goal done")) sounds.play("goal");
    else if (!good) sounds.play("alarm");
    else if (/Festival|rush|put out|Welcome/.test(text)) sounds.play("chime");
  }

  function refreshPanels(): void {
    if (!city) return;
    topCards.update(city);
    events.update(city);
    buildings.update(city);
    goals.update(city);
    inspect.update(city);
    stats.update(city);
    feed.update(city);
    dock.setCash(city.district.cash);
  }

  function select(anchor: number | null): void {
    world?.select(anchor);
    inspect.show(anchor);
    if (city) inspect.update(city);
  }

  function turn(): void {
    rot = (rot + 1) % 4;
    updateGhost();
  }

  // ---- demolishing: red highlight, a confirm bubble for buildings, Undo for everything
  let armed: number | null = null; // the building waiting for a second click / the bubble's button
  const bubble = document.createElement("div");
  bubble.className = "confirm";
  hud.appendChild(bubble);
  bubble.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "no") disarm();
    else if (act === "yes" && armed !== null && city) {
      const t = city.district.tiles.get(armed);
      if (t) demolishNow(t);
    }
  });

  // Cheap things nobody mourns go in one click: roads, bridges and ruins.
  function quickDemolish(t: Tile): boolean {
    const def = defById(t.id);
    return def.roadCapacity > 0 || def.key.startsWith("ruins");
  }

  function arm(t: Tile): void {
    const def = defById(t.id);
    armed = t.anchor;
    world?.markDemolish(t.anchor, true);
    bubble.innerHTML = `<div>Demolish the <b>${def.name}</b>?</div><div class="refund">+$${Math.floor(def.cost * def.refundRate).toLocaleString()} back</div><button class="yes" data-act="yes">Demolish</button><button class="no" data-act="no">Cancel</button><div class="hint">or click it again</div>`;
    bubble.classList.add("open");
    sounds.play("deny");
  }

  function disarm(): void {
    armed = null;
    bubble.classList.remove("open");
    showDemolishTarget();
  }

  function demolishNow(t: Tile): void {
    if (!city) return;
    const def = defById(t.id);
    const c = city;
    const r = c.remove(t.x, t.y);
    disarm();
    if (!r.ok) return;
    sounds.play("demolish");
    const refund = r.removed.refund;
    toasts.action(`${def.name} demolished${refund ? `, +$${refund.toLocaleString()}` : ""}`, "Undo", () => {
      if (c !== city) return; // another city was loaded since
      const back = c.restore(r.removed);
      if (back.ok) {
        sounds.play("place");
        notify(`The ${def.name} is back`, true);
      } else {
        sounds.play("deny");
        notify(back.reason === "occupied" ? "Can't undo: something was built there" : back.reason === "no_cash" ? "Can't undo: the refund has been spent" : "Can't undo that", false);
      }
    });
  }

  // The red box: on the armed building, else on whatever the Demolish tool points at.
  function showDemolishTarget(): void {
    if (!world || !city) return;
    if (tool.kind !== "demolish") {
      world.markDemolish(null);
      return;
    }
    if (armed !== null) {
      world.markDemolish(armed, true);
      return;
    }
    const target = hoverBuilding ?? (hover ? city.tileAtCell(hover[0], hover[1])?.anchor : undefined);
    world.markDemolish(target ?? null, false);
  }

  function updateCursor(): void {
    canvas.style.cursor = tool.kind === "demolish" ? DEMOLISH_CURSOR : tool.kind === "build" ? (hoverBuilding !== undefined ? "pointer" : "crosshair") : hoverBuilding !== undefined ? "pointer" : "default";
  }

  function placeConfirm(): void {
    if (armed === null || !world) return;
    const p = world.worldOf(armed);
    const top = world.heightOf(armed);
    if (!p) return disarm(); // the building is gone (burnt down, say)
    const v = p.setY(top + 1).project(rig.camera);
    const x = (v.x * 0.5 + 0.5) * canvas.clientWidth;
    const y = (-v.y * 0.5 + 0.5) * canvas.clientHeight;
    bubble.style.transform = `translate(-50%, -100%) translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
  }

  // The anchor if it is a building (not a road), else undefined.
  function buildingAt(anchor: number | undefined): number | undefined {
    if (anchor === undefined || !city) return undefined;
    const t = city.district.tiles.get(anchor);
    return t && defById(t.id).roadCapacity === 0 ? anchor : undefined;
  }

  function updateGhost(): void {
    // no ghost while pointing at a building: a tap there inspects it rather than building behind it
    if (!world || !city || tool.kind !== "build" || !hover || hoverBuilding !== undefined) {
      world?.clearGhost();
      return;
    }
    const def = defByKey(tool.key);
    const [w, h] = footprint(def, rot);
    const x = hover[0] - Math.floor((w - 1) / 2);
    const y = hover[1] - Math.floor((h - 1) / 2);
    ghostCell = [x, y];
    world.showGhost(tool.key, x, y, rot, !city.validatePlace(def.id, x, y, rot).reason);
  }

  function tryBuy(cell: [number, number]): void {
    if (!city) return;
    const ci = chunkOfCell(city.district.size, cell[0], cell[1]);
    const [cx, cy] = chunkCoords(city.district.size, ci);
    const price = city.landPriceNow();
    const r = city.buyLand(cx, cy);
    if (r.ok) {
      sounds.play("buy");
      notify(`Land bought for $${price.toLocaleString()}. The next chunk costs $${city.landPriceNow().toLocaleString()}.`, true);
    } else if (r.reason === "no_cash") {
      sounds.play("deny");
      notify(`That chunk costs $${price.toLocaleString()}.`, false);
    }
  }

  const input = new Input(canvas, cam, () => world!.ground, {
    onHover: (cell, anchor) => {
      hover = cell;
      hoverBuilding = buildingAt(anchor);
      updateGhost();
      updateCursor();
      showDemolishTarget();
    },
    onTap: (cell, _p, hit, anchor) => {
      if (!city) return;
      // the building clicked is the one whose model is under the pointer; the ground cell is only used
      // where no building is in the way (roads are flat, so they count as ground)
      const pointed = buildingAt(anchor);
      const t: Tile | undefined = pointed !== undefined ? city.district.tiles.get(pointed) : cell ? city.tileAtCell(cell[0], cell[1]) : undefined;
      if (!cell && !t) return;
      if (tool.kind === "build") {
        const def = defByKey(tool.key);
        // tapping a building while holding a card inspects it instead of building behind it
        if (pointed !== undefined) {
          select(pointed);
          return;
        }
        if (!cell) return;
        if (t && city.validatePlace(def.id, ghostCell[0], ghostCell[1], rot).reason === "occupied") {
          select(t.anchor);
          return;
        }
        const r = city.place(def.id, ghostCell[0], ghostCell[1], rot);
        if (r.ok) {
          sounds.play("place");
        } else if (r.reason === "locked_land") tryBuy(cell!);
        else {
          sounds.play("deny");
          notify(REASON_TEXT[r.reason] ?? r.reason, false);
        }
        updateGhost();
      } else if (tool.kind === "demolish") {
        if (!t) disarm();
        else if (quickDemolish(t) || armed === t.anchor) demolishNow(t); // roads, ruins, or a second click
        else arm(t); // first click on a building: ask
      } else if (t) select(t.anchor);
      else if (cell && hit?.userData.chunk !== undefined) tryBuy(cell);
      else select(null);
    },
    onKey: (key) => {
      if (key === "r" || key === "R") turn();
      else if (key === "Escape") {
        if (armed !== null) disarm();
        else dock.setTool({ kind: "inspect" });
      }
      else if (key === "0") dock.setTool({ kind: "demolish" });
      else if (key >= "1" && key <= "9") dock.pick(Number(key));
      else if (key === "b" || key === "B") dock.toggle();
    },
  });

  // ---- boot
  const requested = Number(params.get("slot"));
  const existing = requested ? Session.open(store, requested) : null;
  if (existing) load(existing);
  else if (requested && params.get("map")) load(Session.create(store, requested, params.get("map")!, "My City"));
  else openStart(false);
  // dev: ?jam fills every home and narrows the demo's trunk to a plain road, so it jams (to check the colours)
  if (params.has("jam") && city) {
    const c: City = city;
    for (const t of c.district.tiles.values()) if (defById(t.id).population > 0) t.occ = defById(t.id).population;
    const mid = Math.floor(c.district.size / 2);
    for (let y = 0; y <= 3; y++) c.place(defByKey("road").id, mid, y, 0);
    c.refresh();
  }
  // dev: ?bridge lays a highway east along the front edge, crossing the river (map=river) on a highway bridge
  if (params.has("bridge") && city) {
    const c: City = city;
    const mid = Math.floor(c.district.size / 2);
    for (let x = mid + 1; x < c.district.size - 2; x++) {
      const water = c.district.water[x] === 1; // row 0
      c.place(defByKey(water ? "highway_bridge" : "highway").id, x, 0, 0);
    }
  }
  // dev: ?fire sets a building alight (the tower if there is one) shortly after load, to check the effect
  if (params.has("fire")) setTimeout(() => devFire(), 1500);

  let acc = 0;
  const timer = new THREE.Timer();
  rig.renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    if (city && !start.root.classList.contains("open")) {
      acc += dt;
      if (acc >= ECONOMY.TICK_SECONDS) {
        acc -= ECONOMY.TICK_SECONDS;
        city.tick();
      }
    }
    input.update(dt);
    cam.update(dt);
    world?.update(dt, canvas.clientHeight / (2 * Math.tan(THREE.MathUtils.degToRad(rig.camera.fov) / 2)));
    traffic?.update(dt);
    labels.update(rig.camera, canvas.clientWidth, canvas.clientHeight);
    placeConfirm();
    rig.renderer.render(rig.scene, rig.camera);
  });
  window.addEventListener("beforeunload", () => session?.saveNow());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) session?.saveNow();
  });
}