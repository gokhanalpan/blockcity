// The island, built like Roblox smooth terrain: one heightfield over the plot and a sand margin around
// it. Land cells stay flat at y = 0 where buildings stand; the banks round off and slope down into a
// river bed under the water, so the shore follows a smooth curve instead of the cell staircase. The
// sand margin slopes into the sea the same way. One animated water sheet covers everything at WATER_Y,
// with the shallow sandy bed showing through near the banks. Also: the main road along the front edge
// that the entrance cells join, and the overlays on chunks you don't own yet.

import * as THREE from "three";
import { GRID } from "@/config/tuning";
import { chunkCoords, chunksPerSide, entranceCells, index, isBuyable, type District } from "@/sim/district";
import { CELL } from "./coords";

export const COLOURS = {
  grass: 0x7db45a,
  sand: 0xe8d9a8, // banks and the beach around the plot
  wetSand: 0xc8b382, // the bed just under the water
  bed: 0x1d4f8a, // the deep bed: makes deep water read darker
  water: 0x2a86dc,
  seaFloor: 0x174f8c,
  asphalt: 0x46484e,
  entrance: 0xf0a040,
  lockedLand: 0x31465c,
  buyableLand: 0x5b87b5,
} as const;

export const WATER_Y = -0.3; // Roblox WATER_DROP: the water surface sits this far below the land
export const MAIN_ROAD_W = 16;
const ROAD_RUN = 900; // length of the main road, running off the island both ways
const STEP = CELL / 4; // heightfield resolution: four samples per cell
const MARGIN = 40; // sand around the plot, world units
const BEACH = 28; // the beach reaches this far from the plot before it slopes into the sea
const DEEP = -2.4; // deepest bed
const MAX_DIP = -0.6; // the most a land cell's rim may sink (its corners round off into the water)

// Bed height from the smoothed "landness" b (1 = land, 0 = open water). The waterline falls at
// b ~ 0.41, a little way out into the water cells where the surface is free to curve (land cells are
// pinned flat), and the bed starts as a shallow sandy shelf before dropping away, like Roblox banks.
function bed(b: number): number {
  const t = Math.min(1, Math.max(0, (0.5 - b) / 0.42));
  return -0.02 + (DEEP + 0.02) * Math.pow(t, 1.4);
}

// Separable box blur, run three times (close to a gaussian).
function blur(src: Float32Array, n: number, r: number, passes: number): Float32Array {
  let a: Float32Array = src;
  let b: Float32Array = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < n; y++) {
      const row = y * n;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(n - 1, Math.max(0, x))];
      for (let x = 0; x < n; x++) {
        b[row + x] = acc / (2 * r + 1);
        acc += a[row + Math.min(n - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    [a, b] = [b, a];
    for (let x = 0; x < n; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += a[Math.min(n - 1, Math.max(0, y)) * n + x];
      for (let y = 0; y < n; y++) {
        b[y * n + x] = acc / (2 * r + 1);
        acc += a[Math.min(n - 1, y + r + 1) * n + x] - a[Math.max(0, y - r) * n + x];
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

function buildGround(d: District): THREE.BufferGeometry {
  const size = d.size;
  const extent = size * CELL;
  const n = Math.round((extent + 2 * MARGIN) / STEP) + 1; // vertices per side
  const per = CELL / STEP; // samples per cell (4)
  const off = MARGIN / STEP; // vertex index of the plot's edge
  const inGrid = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < size && cy < size;
  const water = (cx: number, cy: number) => d.water[index(size, cx, cy)] === 1;

  // raw landness per vertex: the share of land among the cells it touches; the margin is beach out to
  // BEACH from the plot (rounded corners), sea beyond
  const raw = new Float32Array(n * n);
  const touchesLand = new Uint8Array(n * n);
  const touchesWater = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i - off; // in samples, relative to the plot's corner
      const v = j - off;
      const xs = u % per === 0 ? [u / per - 1, u / per] : [Math.floor(u / per)];
      const ys = v % per === 0 ? [v / per - 1, v / per] : [Math.floor(v / per)];
      let land = 0;
      let count = 0;
      for (const cy of ys) {
        for (const cx of xs) {
          if (inGrid(cx, cy)) {
            count++;
            if (water(cx, cy)) touchesWater[j * n + i] = 1;
            else {
              land++;
              touchesLand[j * n + i] = 1;
            }
          }
        }
      }
      if (count > 0) raw[j * n + i] = land / count;
      else {
        const x = u * STEP;
        const z = v * STEP;
        const dx = Math.max(0, -x, x - extent);
        const dz = Math.max(0, -z, z - extent);
        raw[j * n + i] = Math.hypot(dx, dz) < BEACH ? 1 : 0;
      }
    }
  }
  const b = blur(raw, n, 3, 2); // ~0.7 cell of smoothing: rounds the staircase, keeps 2-wide canals wet

  const pos = new Float32Array(n * n * 3);
  const col = new Float32Array(n * n * 3);
  // hex colours are sRGB and THREE.Color converts them to linear itself (no convertSRGBToLinear here)
  const grass = new THREE.Color(COLOURS.grass);
  const sand = new THREE.Color(COLOURS.sand);
  const wet = new THREE.Color(COLOURS.wetSand);
  const deep = new THREE.Color(COLOURS.bed);
  const c = new THREE.Color();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const u = i - off;
      const v = j - off;
      let h = bed(b[k]);
      if (touchesLand[k]) h = touchesWater[k] ? Math.max(h, MAX_DIP) : 0; // building ground stays flat
      // every water cell keeps water at its centre, whatever the smoothing did
      if (u % per === per / 2 && v % per === per / 2 && inGrid((u - per / 2) / per, (v - per / 2) / per) && water((u - per / 2) / per, (v - per / 2) / per)) h = Math.min(h, MAX_DIP);
      pos[k * 3] = u * STEP;
      pos[k * 3 + 1] = h;
      pos[k * 3 + 2] = v * STEP;
      const inPlot = u >= 0 && v >= 0 && u <= size * per && v <= size * per;
      if (h > WATER_Y + 0.05) {
        if (inPlot) c.copy(sand).lerp(grass, THREE.MathUtils.smoothstep(b[k], 0.55, 0.9));
        else c.copy(sand);
      } else {
        c.copy(wet).lerp(deep, THREE.MathUtils.smoothstep(-h, 0.35, 1.9));
      }
      col[k * 3] = c.r;
      col[k * 3 + 1] = c.g;
      col[k * 3 + 2] = c.b;
    }
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let p = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      idx[p++] = a;
      idx[p++] = a + n;
      idx[p++] = a + 1;
      idx[p++] = a + 1;
      idx[p++] = a + n;
      idx[p++] = a + n + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// Water with moving highlights, no textures: a few travelling sine waves tilt the normal per pixel,
// and wave crests are lifted a little toward white, like the shimmer on Roblox water.
function waterMaterial(time: { value: number }): THREE.MeshPhongMaterial {
  const m = new THREE.MeshPhongMaterial({ color: COLOURS.water, transparent: true, opacity: 0.84, shininess: 60, specular: 0x6d8fb0, depthWrite: false });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWaterPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWaterPos;\nuniform float uTime;\nfloat waterCrest = 0.0;")
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        {
          vec2 q = vWaterPos.xz;
          float t = uTime;
          vec2 g = vec2(cos(q.x * 0.52 + t * 1.1), cos(q.y * 0.47 - t * 0.9)) * 0.09;
          g += vec2(cos((q.x + q.y) * 0.86 + t * 1.7), cos((q.x - q.y) * 0.93 - t * 1.4)) * 0.06;
          g += vec2(cos(q.x * 2.05 - q.y * 1.07 + t * 2.4), cos(q.y * 1.85 + q.x * 0.65 + t * 2.1)) * 0.04;
          waterCrest = smoothstep(0.1, 0.19, length(g));
          normal = normalize((viewMatrix * vec4(normalize(vec3(-g.x, 1.0, -g.y)), 0.0)).xyz);
        }`,
      )
      .replace("#include <opaque_fragment>", "#include <opaque_fragment>\ngl_FragColor.rgb += waterCrest * vec3(0.11, 0.13, 0.15);");
  };
  return m;
}

export interface Terrain {
  group: THREE.Group;
  ground: THREE.Mesh; // invisible plane for raycasting cells
  update: (dt: number) => void; // animates the water
  dispose: () => void;
}

export function buildTerrain(d: District): Terrain {
  const group = new THREE.Group();
  const size = d.size;
  const extent = size * CELL;

  const groundGeo = buildGround(d);
  const land = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  land.receiveShadow = true;
  group.add(land);

  // the deep sea floor (what you see through the water far out), and the water sheet over everything
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(extent * 10, extent * 10), new THREE.MeshLambertMaterial({ color: COLOURS.seaFloor }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(extent / 2, DEEP - 0.2, extent / 2);
  group.add(floor);
  const time = { value: 0 };
  const water = new THREE.Mesh(new THREE.PlaneGeometry(extent * 10, extent * 10), waterMaterial(time));
  water.rotation.x = -Math.PI / 2;
  water.position.set(extent / 2, WATER_Y, extent / 2);
  water.receiveShadow = true;
  water.renderOrder = 1;
  group.add(water);

  // the main road along the front edge, running off the island both ways on a low causeway
  const causeway = new THREE.Mesh(new THREE.BoxGeometry(ROAD_RUN, 2, MAIN_ROAD_W + 12), new THREE.MeshLambertMaterial({ color: COLOURS.sand }));
  causeway.position.set(extent / 2, -1.12, -MAIN_ROAD_W / 2);
  causeway.receiveShadow = true;
  group.add(causeway);
  const main = new THREE.Mesh(new THREE.BoxGeometry(ROAD_RUN, 1, MAIN_ROAD_W), new THREE.MeshLambertMaterial({ color: COLOURS.asphalt }));
  main.position.set(extent / 2, -0.48, -MAIN_ROAD_W / 2);
  main.receiveShadow = true;
  group.add(main);
  const dash = new THREE.MeshLambertMaterial({ color: 0xe8e8e8 });
  for (let x = extent / 2 - ROAD_RUN / 2 + 4; x < extent / 2 + ROAD_RUN / 2; x += 10) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(5, 0.05, 0.4), dash);
    m.position.set(x, 0.04, -MAIN_ROAD_W / 2);
    group.add(m);
  }
  // orange markers where the entrance cells meet the main road
  for (const c of entranceCells(size)) {
    const x = c % size;
    const m = new THREE.Mesh(new THREE.BoxGeometry(CELL - 0.4, 0.2, 1.2), new THREE.MeshLambertMaterial({ color: COLOURS.entrance }));
    m.position.set((x + 0.5) * CELL, 0.1, -0.7);
    group.add(m);
  }

  // invisible plane for picking
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(extent * 3, extent * 3), new THREE.MeshBasicMaterial({ visible: false }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(extent / 2, 0, extent / 2);
  group.add(ground);

  return {
    group,
    ground,
    update: (dt) => {
      time.value += dt;
    },
    dispose: () => {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    },
  };
}

// Overlays on chunks the player doesn't own: dark for locked, lighter for the ones that can be bought.
export class LandOverlay {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<number, THREE.Mesh>();
  private readonly locked = new THREE.MeshLambertMaterial({ color: COLOURS.lockedLand, transparent: true, opacity: 0.4, depthWrite: false });
  private readonly buyable = new THREE.MeshLambertMaterial({ color: COLOURS.buyableLand, transparent: true, opacity: 0.35, depthWrite: false });
  private readonly geo = new THREE.PlaneGeometry(GRID.CHUNK * CELL - 0.6, GRID.CHUNK * CELL - 0.6);

  constructor(private readonly size: number) {}

  // Returns the buyable chunk indices so the UI can label them with the price.
  update(d: District): number[] {
    const total = chunksPerSide(this.size) ** 2;
    const buyableList: number[] = [];
    for (let ci = 0; ci < total; ci++) {
      if (d.chunks.has(ci)) {
        const m = this.meshes.get(ci);
        if (m) {
          this.group.remove(m);
          this.meshes.delete(ci);
        }
        continue;
      }
      const canBuy = isBuyable(d, ci);
      if (canBuy) buyableList.push(ci);
      let m = this.meshes.get(ci);
      if (!m) {
        m = new THREE.Mesh(this.geo, this.locked);
        m.rotation.x = -Math.PI / 2;
        const [cx, cy] = chunkCoords(this.size, ci);
        m.position.set((cx + 0.5) * GRID.CHUNK * CELL, 0.3, (cy + 0.5) * GRID.CHUNK * CELL);
        m.userData.chunk = ci;
        this.group.add(m);
        this.meshes.set(ci, m);
      }
      m.material = canBuy ? this.buyable : this.locked;
    }
    return buyableList;
  }

  chunkCentre(ci: number): THREE.Vector3 {
    const [cx, cy] = chunkCoords(this.size, ci);
    return new THREE.Vector3((cx + 0.5) * GRID.CHUNK * CELL, 0.3, (cy + 0.5) * GRID.CHUNK * CELL);
  }
}