// Surfaces: every part keeps its Roblox material (brick, slate, concrete, wood, metal, grass, fabric,
// glass, plastic). The patterns (brick courses, shingles, planks, grain) are drawn in the shader from a
// per-vertex material id and surface coordinate, so there are still no image files; materials are
// physically based so metal and plastic catch the sun and glass reflects the sky (scene.environment).
// Signboards get their text from a canvas atlas built once.
//
// Builds Three.js meshes from src/assets/models.json (exported from the Roblox build by
// tools/export_models.py). Every model is a list of coloured boxes, balls, cylinders and wedges in
// Roblox studs, Y up, front facing -Z, pivot at the base centre.
//
// Each model key is merged once into a few BufferGeometries with vertex colours (opaque, glass, and
// a "rotor" group for the parts that spin), then every instance in the world is a plain Mesh sharing
// that geometry: a full 48x48 city is a few hundred draw calls, not tens of thousands.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import modelsJson from "@/assets/models.json";

export interface PartJson {
  n: string;
  k: "box" | "ball" | "cylinder" | "wedge";
  s: [number, number, number];
  p: [number, number, number];
  c: [number, number, number];
  m: string;
  r?: number[]; // row-major 3x3
  t?: number; // transparency
  text?: string;
  tc?: [number, number, number]; // sign text colour
}

export interface ModelJson {
  parts: PartJson[];
}

export interface ModelsFile {
  cell: number;
  tiles: Record<string, ModelJson>;
  vehicles: Record<string, ModelJson>;
}

export const MODELS = modelsJson as unknown as ModelsFile;

export interface BuiltModel {
  opaque: THREE.BufferGeometry | null;
  glass: THREE.BufferGeometry | null;
  rotor: THREE.BufferGeometry | null; // spinning parts (Rotor*), relative to the hub
  hub: THREE.Vector3 | null; // where the rotor group sits
  rotorAxis: "y" | "z"; // wind turbine blades spin about Z, ferris wheel about Z, hubs about Y
  signs: THREE.BufferGeometry | null; // text quads on signboards (uv into the sign atlas)
  height: number; // top of the model, for camera framing and labels
}

const cache = new Map<string, BuiltModel>();

// Material ids written per vertex (aMat). Keep in step with SURFACE_GLSL.
const MAT_ID: Record<string, number> = { plastic: 0, concrete: 1, metal: 2, grass: 3, brick: 4, glass: 5, wood: 6, slate: 7, fabric: 8, ground: 9 };

// The surface patterns, as multipliers / blends on the part colour. uv is in studs on the face.
const SURFACE_GLSL = `
varying float vMat;
varying vec2 vSurf;
varying float vUp; // the face's normal.y: 1 on flat tops, 0 on walls, between on slopes
float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), f.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// 1 on a grid line of width w (in cell units), 0 elsewhere, softened a little
float sLine(float x, float w) {
  float f = fract(x);
  return 1.0 - smoothstep(0.0, w, f) * smoothstep(0.0, w, 1.0 - f);
}
vec3 sSurface(vec3 c, vec2 uv, int m) {
  if (m == 4) { // brick: 0.9 x 0.36 studs, every other course offset half a brick, light mortar
    vec2 b = uv / vec2(0.9, 0.36);
    b.x += 0.5 * floor(b.y);
    vec2 id = floor(b);
    float mortar = max(sLine(b.x, 0.07), sLine(b.y, 0.16));
    return mix(c * (0.84 + 0.3 * sHash(id)), vec3(0.55, 0.53, 0.5), mortar * 0.9);
  }
  if (m == 7 && (abs(vUp) > 0.92 || abs(vUp) < 0.1)) { // flat or upright slate (roof caps, their edges): rough stone
    float g = sNoise(uv * 3.0) * 0.5 + sNoise(uv * 11.0) * 0.5;
    float joint = max(sLine(uv.x / 1.4, 0.03), sLine(uv.y / 1.4, 0.03));
    return c * (0.88 + 0.2 * g) * (1.0 - 0.1 * joint);
  }
  if (m == 7) { // sloped slate: staggered shingles with dark gaps
    vec2 b = uv / vec2(0.6, 0.42);
    b.x += 0.5 * floor(b.y);
    vec2 id = floor(b);
    float gap = max(sLine(b.x, 0.06), sLine(b.y, 0.12));
    return c * (0.82 + 0.3 * sHash(id)) * (1.0 - 0.4 * gap);
  }
  if (m == 1) { // concrete: a faint grain, nearly smooth from a distance like Roblox concrete
    float g = sNoise(uv * 4.0) * 0.5 + sNoise(uv * 15.0) * 0.5;
    return c * (0.96 + 0.07 * g);
  }
  if (m == 6) { // wood: planks with gaps and grain
    float p = uv.y / 0.34;
    float id = floor(p);
    float grain = sNoise(vec2(uv.x * 1.2 + sHash(vec2(id, 3.0)) * 17.0, p * 9.0));
    return c * (0.84 + 0.22 * sHash(vec2(id, 1.0)) + 0.14 * grain) * (1.0 - 0.35 * sLine(p, 0.08));
  }
  if (m == 2) { // metal: brushed
    return c * (0.93 + 0.14 * sNoise(vec2(uv.x * 0.6, uv.y * 36.0)));
  }
  if (m == 3 || m == 9) { // grass, ground
    return c * (0.84 + 0.32 * (sNoise(uv * 3.0) * 0.5 + sNoise(uv * 13.0) * 0.5));
  }
  if (m == 8) { // fabric
    return c * (0.9 + 0.12 * abs(sin(uv.x * 38.0)) * abs(sin(uv.y * 38.0)));
  }
  return c; // smooth plastic
}
float sRoughness(int m) {
  if (m == 0) return 0.5;
  if (m == 2) return 0.35;
  if (m == 5) return 0.05;
  if (m == 1 || m == 4 || m == 7 || m == 3 || m == 9) return 0.92;
  return 0.8;
}
`;

function withSurfaces<T extends THREE.MeshStandardMaterial>(m: T): T {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aMat;\nattribute vec2 aUv;\nvarying float vMat;\nvarying vec2 vSurf;\nvarying float vUp;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvMat = aMat;\nvSurf = aUv;\nvUp = normal.y; // models only turn about Y, so this is the world normal's y");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + SURFACE_GLSL)
      .replace("#include <color_fragment>", "#include <color_fragment>\nint sMat = int(vMat + 0.5);\ndiffuseColor.rgb = sSurface(diffuseColor.rgb, vSurf, sMat);")
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = sRoughness(sMat);")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = sMat == 2 ? 0.45 : 0.0;");
  };
  m.customProgramCacheKey = () => "block-city-surfaces";
  return m;
}

// Buildings and vehicles, and their glass. They take the sky (envMap) for reflections; nothing else in
// the scene does (scene.environment would also light the Lambert terrain and the water). Each WebGL
// context needs its own pair, since the sky texture belongs to the renderer that made it.
// Roblox's Glass material shows a part's colour darker and deeper than the colour itself: a
// (130, 185, 230) window band reads as about (80, 130, 200). Raising the linear colour to a power does
// the same, darkening the light channels less than the dim ones, so blue glass stays blue, just deeper.
function robloxGlass(m: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = pow(diffuseColor.rgb, vec3(1.6)) * 0.65;");
  };
  m.customProgramCacheKey = () => "block-city-glass";
  return m;
}

export function surfaceMaterials(env: THREE.Texture | null = null): { opaque: THREE.MeshStandardMaterial; glass: THREE.MeshStandardMaterial } {
  // envMapIntensity is low on the solid parts: their sky light is mostly the hemisphere light already
  const opaque = withSurfaces(new THREE.MeshStandardMaterial({ vertexColors: true, envMap: env, envMapIntensity: 0.35 }));
  // glass: opacity per part (vertex alpha); a little sky in it, not so much the blue turns white
  const glass = robloxGlass(new THREE.MeshStandardMaterial({ vertexColors: true, envMap: env, transparent: true, roughness: 0.2, metalness: 0, envMapIntensity: 0.55, depthWrite: false }));
  return { opaque, glass };
}

const main = surfaceMaterials();
export const opaqueMaterial = main.opaque;
export const glassMaterial = main.glass;

// The main view's sky (set once by createScene).
export function setEnvironment(env: THREE.Texture): void {
  for (const m of [opaqueMaterial, glassMaterial]) {
    m.envMap = env;
    m.needsUpdate = true;
  }
}
export const ghostMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false });
export const plainMaterial = new THREE.MeshLambertMaterial({ vertexColors: true }); // small props without surfaces (people)

// A wedge the Roblox way: full height at the back (+Z), sloping down to the front (-Z).
export function wedgeGeometry(sx: number, sy: number, sz: number): THREE.BufferGeometry {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  // vertices
  const a = [-hx, -hy, -hz]; // bottom front left
  const b = [hx, -hy, -hz]; // bottom front right
  const c = [hx, -hy, hz]; // bottom back right
  const d = [-hx, -hy, hz]; // bottom back left
  const e = [-hx, hy, hz]; // top back left
  const f = [hx, hy, hz]; // top back right
  // counter-clockwise seen from outside, so every face is front-facing and its normal points out
  const tri = (p: number[], q: number[], r: number[]) => [...p, ...r, ...q];
  const pos = [
    // bottom (facing -Y)
    ...tri(a, c, b), ...tri(a, d, c),
    // back (facing +Z)
    ...tri(d, e, f), ...tri(d, f, c),
    // slope (facing -Z/+Y)
    ...tri(a, b, f), ...tri(a, f, e),
    // left side (facing -X)
    ...tri(a, e, d),
    // right side (facing +X)
    ...tri(b, c, f),
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function partGeometry(p: PartJson): THREE.BufferGeometry {
  const g = rawGeometry(p);
  if (g.getAttribute("uv")) g.deleteAttribute("uv"); // merging needs identical attribute sets
  // surface coordinate in studs: the two local axes across each face (by the face normal)
  const pos = g.getAttribute("position");
  const nrm = g.getAttribute("normal");
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));
    if (ax >= ay && ax >= az) {
      uv[i * 2] = pos.getZ(i);
      uv[i * 2 + 1] = pos.getY(i);
    } else if (ay >= az) {
      uv[i * 2] = pos.getX(i);
      uv[i * 2 + 1] = pos.getZ(i);
    } else {
      uv[i * 2] = pos.getX(i);
      uv[i * 2 + 1] = pos.getY(i);
    }
  }
  g.setAttribute("aUv", new THREE.BufferAttribute(uv, 2));
  g.setAttribute("aMat", new THREE.BufferAttribute(new Float32Array(n).fill(MAT_ID[p.m] ?? 0), 1));
  return g;
}

// ---------------------------------------------------------------------------------------------
// Signboards: all sign texts drawn once into a canvas atlas; each sign gets a quad on its front face.
// ---------------------------------------------------------------------------------------------
interface Atlas {
  material: THREE.MeshLambertMaterial;
  cells: Map<string, [number, number, number, number]>; // u0, v0, u1, v1
}
let atlas: Atlas | null | undefined;

function signAtlas(): Atlas | null {
  if (atlas !== undefined) return atlas;
  if (typeof document === "undefined") return (atlas = null); // tests run without a DOM
  const labels = new Map<string, [number, number, number]>();
  for (const src of [MODELS.tiles, MODELS.vehicles]) {
    for (const m of Object.values(src)) for (const p of m.parts) if (p.text && !labels.has(p.text)) labels.set(p.text, p.tc ?? [255, 255, 255]);
  }
  const CW = 512;
  const CH = 112;
  const cols = 2;
  const rows = Math.max(1, Math.ceil(labels.size / cols));
  const canvas = document.createElement("canvas");
  canvas.width = CW * cols;
  canvas.height = CH * rows;
  const ctx = canvas.getContext("2d")!;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cells = new Map<string, [number, number, number, number]>();
  [...labels.entries()].forEach(([text, tc], i) => {
    const x = (i % cols) * CW;
    const y = Math.floor(i / cols) * CH;
    // Roblox TextScaled: as large as fits the label
    let size = CH * 0.8;
    ctx.font = `900 ${size}px "Nunito", "Arial Black", Arial, sans-serif`;
    const w = ctx.measureText(text).width;
    if (w > CW * 0.92) size *= (CW * 0.92) / w;
    ctx.font = `900 ${size}px "Nunito", "Arial Black", Arial, sans-serif`;
    ctx.fillStyle = `rgb(${tc[0]}, ${tc[1]}, ${tc[2]})`;
    ctx.fillText(text, x + CW / 2, y + CH / 2 + size * 0.04);
    cells.set(text, [x / canvas.width, 1 - (y + CH) / canvas.height, (x + CW) / canvas.width, 1 - y / canvas.height]);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.MeshLambertMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  return (atlas = { material, cells });
}

// A quad over the sign's front (-Z) face carrying its text.
function signQuad(p: PartJson, a: Atlas): THREE.BufferGeometry | null {
  const cell = p.text ? a.cells.get(p.text) : undefined;
  if (!cell) return null;
  // keep the text's aspect: the atlas cell is 512 x 112
  const w = p.s[0] * 0.92;
  const h = Math.min(p.s[1] * 0.8, w * (112 / 512));
  const g = new THREE.PlaneGeometry(w, h);
  g.rotateY(Math.PI); // face -Z, reading left to right from the front
  g.translate(0, 0, -p.s[2] / 2 - 0.01);
  const uv = g.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) uv.setXY(i, cell[0] + uv.getX(i) * (cell[2] - cell[0]), cell[1] + uv.getY(i) * (cell[3] - cell[1]));
  return placePart(g, p);
}

export function rawGeometry(p: PartJson): THREE.BufferGeometry {
  const [sx, sy, sz] = p.s;
  switch (p.k) {
    case "ball":
      return new THREE.SphereGeometry(sx / 2, 12, 8);
    case "cylinder": {
      // Roblox cylinders lie along X: length sx, diameter sy
      const g = new THREE.CylinderGeometry(sy / 2, sy / 2, sx, 16);
      g.rotateZ(-Math.PI / 2);
      return g;
    }
    case "wedge":
      return wedgeGeometry(sx, sy, sz);
    default:
      return new THREE.BoxGeometry(sx, sy, sz);
  }
}

// alpha: undefined for solid parts (RGB), or the part's opacity for the see-through group (RGBA),
// so a Roblox window at Transparency 0.2 is 80% opaque here too.
function colourise(g: THREE.BufferGeometry, [r, gg, b]: [number, number, number], alpha?: number): void {
  const n = g.getAttribute("position").count;
  const k = alpha === undefined ? 3 : 4;
  const colours = new Float32Array(n * k);
  const c = new THREE.Color(r / 255, gg / 255, b / 255).convertSRGBToLinear();
  for (let i = 0; i < n; i++) {
    colours[i * k] = c.r;
    colours[i * k + 1] = c.g;
    colours[i * k + 2] = c.b;
    if (k === 4) colours[i * k + 3] = alpha!;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colours, k));
}

// Opacity of a see-through part. Roblox glass hides what's behind it more than its Transparency
// suggests (a 0.2 band reads as nearly solid), so glass gets half its transparency; other parts get it all.
function partAlpha(p: PartJson): number {
  const t = p.t ?? 0;
  return p.m === "glass" ? Math.min(1 - t * 0.5, 0.94) : 1 - t;
}

function placePart(g: THREE.BufferGeometry, p: PartJson, offset?: THREE.Vector3): THREE.BufferGeometry {
  const m = new THREE.Matrix4();
  if (p.r) {
    const r = p.r;
    m.set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
  }
  const [x, y, z] = p.p;
  m.setPosition(x - (offset?.x ?? 0), y - (offset?.y ?? 0), z - (offset?.z ?? 0));
  g.applyMatrix4(m);
  return g;
}

function isRotor(p: PartJson): boolean {
  return p.n.startsWith("Rotor");
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (list.length === 0) return null;
  const nonIndexed = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(nonIndexed, false);
  for (const g of list) g.dispose();
  return merged;
}

// variant "slab": the road models minus their Preview* parts (the world decorates roads from their
// neighbours instead; the preview lines only belong on the menu card).
export function buildModel(key: string, source: "tiles" | "vehicles" = "tiles", variant: "full" | "slab" = "full"): BuiltModel {
  const cacheKey = `${source}:${key}:${variant}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const model = MODELS[source][key];
  if (!model) throw new Error(`no model for ${source}/${key}`);
  const opaque: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const rotor: THREE.BufferGeometry[] = [];
  const signs: THREE.BufferGeometry[] = [];
  const a = signAtlas();
  let hub: THREE.Vector3 | null = null;
  let height = 0;
  const hubPart = model.parts.find((p) => p.n === "Hub");
  if (hubPart) hub = new THREE.Vector3(...hubPart.p);
  for (const p of model.parts) {
    if (p.t !== undefined && p.t >= 1) continue; // invisible helper parts
    if (variant === "slab" && p.n.startsWith("Preview")) continue;
    height = Math.max(height, p.p[1] + p.s[1] / 2);
    if (a && p.text) {
      const q = signQuad(p, a);
      if (q) signs.push(q);
    }
    const g = partGeometry(p);
    const seeThrough = p.m === "glass" || (p.t !== undefined && p.t > 0);
    colourise(g, p.c, seeThrough && !(hub && isRotor(p)) ? partAlpha(p) : undefined);
    if (hub && isRotor(p)) {
      rotor.push(placePart(g, p, hub));
    } else if (seeThrough) {
      glass.push(placePart(g, p));
    } else {
      opaque.push(placePart(g, p));
    }
  }
  const built: BuiltModel = {
    opaque: merge(opaque),
    glass: merge(glass),
    rotor: merge(rotor),
    hub,
    rotorAxis: "z",
    signs: signs.length ? mergeGeometries(signs, false) : null,
    height,
  };
  cache.set(cacheKey, built);
  return built;
}

export interface ModelInstance {
  group: THREE.Group;
  rotor: THREE.Mesh | null;
  height: number;
}

// A new instance of a model. The group is positioned by the caller (pivot at the base centre).
export function instantiate(key: string, source: "tiles" | "vehicles" = "tiles", ghost = false): ModelInstance {
  const built = buildModel(key, source);
  const group = new THREE.Group();
  group.name = key;
  const solid = ghost ? ghostMaterial : opaqueMaterial;
  if (built.opaque) {
    const m = new THREE.Mesh(built.opaque, solid);
    m.castShadow = !ghost;
    m.receiveShadow = !ghost;
    group.add(m);
  }
  if (built.glass) {
    const m = new THREE.Mesh(built.glass, ghost ? ghostMaterial : glassMaterial);
    group.add(m);
  }
  if (built.signs && !ghost) group.add(new THREE.Mesh(built.signs, signAtlas()!.material));
  let rotor: THREE.Mesh | null = null;
  if (built.rotor && built.hub) {
    rotor = new THREE.Mesh(built.rotor, solid);
    rotor.position.copy(built.hub);
    rotor.castShadow = !ghost;
    group.add(rotor);
  }
  return { group, rotor, height: built.height };
}

export function modelKeys(source: "tiles" | "vehicles" = "tiles"): string[] {
  return Object.keys(MODELS[source]);
}