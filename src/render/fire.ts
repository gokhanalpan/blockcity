// Fire on burning buildings. Purely visual: the world view tells it which buildings are burning (and
// whether a fire station is fighting the fire), it draws the rest.
//
//   burning   flames lick up the roof and the upper walls (white-yellow -> orange -> dark red), dark
//             smoke billows up and drifts with the wind, embers fly, an orange glow flickers on
//             everything around. The fire grows as its countdown runs.
//   fought    a fire station is in reach: water sprays in from the station's side, the flames die
//             down and the smoke turns to white steam.
//   steam     put out: steam for a few seconds, then nothing.
//   smoulder  burnt down: the ruins smoke (and flicker at first) for a while.
//
// All fires share four particle pools (flames, smoke, embers, spray): four draw calls however many
// buildings burn. The glow is one PointLight that always exists (intensity 0 when nothing burns):
// adding or removing lights would make three.js recompile every lit material, a visible stutter.

import * as THREE from "three";

export interface FireSource {
  anchor: number;
  centre: THREE.Vector3; // base centre of the building
  width: number; // footprint, world units
  depth: number;
  height: number; // top of the model
  heat: number; // 0..1, grows as the fire's countdown runs
  fighting: boolean;
  sprayFrom: THREE.Vector3 | null; // where the fire station's water comes from
}

type Mode = "burning" | "fought" | "steam" | "smoulder";

const WIND = new THREE.Vector3(0.9, 0, 0.35); // smoke drifts this way, units/s

// A soft round dot, computed (no canvas): works in tests and needs no image file.
let dotTexture: THREE.DataTexture | null = null;
function dot(): THREE.DataTexture {
  if (dotTexture) return dotTexture;
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5;
      const dy = (y + 0.5) / n - 0.5;
      const r = Math.min(1, Math.hypot(dx, dy) * 2);
      const a = Math.pow(1 - r, 1.6);
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  dotTexture = new THREE.DataTexture(data, n, n);
  dotTexture.needsUpdate = true;
  return dotTexture;
}

const VERTEX = `
attribute vec4 aColor;
attribute float aSize;
uniform float uScale;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const FRAGMENT = `
uniform sampler2D uMap;
varying vec4 vColor;
void main() {
  float a = vColor.a * texture2D(uMap, gl_PointCoord).a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;

// One pool of particles drawn as a single Points object.
class Pool {
  readonly points: THREE.Points;
  readonly max: number;
  readonly pos: Float32Array;
  readonly col: Float32Array;
  readonly size: Float32Array;
  readonly vel: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly base: Float32Array; // per-particle size at birth
  readonly tone: Float32Array; // per-particle variant (smoke: 0 dark smoke .. 1 white steam)
  private next = 0;
  private readonly uniforms = { uScale: { value: 400 }, uMap: { value: dot() as THREE.Texture } };

  constructor(max: number, blending: THREE.Blending) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max); // 0 = dead
    this.base = new Float32Array(max);
    this.tone = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aColor", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, blending });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false; // particles move far from where the geometry was first bounded
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, tone = 0): void {
    // reuse slots round-robin: when the pool is full the oldest particles make way
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.age[i] = 0;
    this.life[i] = life;
    this.base[i] = size;
    this.tone[i] = tone;
  }

  alive(): number {
    let n = 0;
    for (let i = 0; i < this.max; i++) if (this.life[i] > 0) n++;
    return n;
  }

  setScale(s: number): void {
    this.uniforms.uScale.value = s;
  }

  // Ages, moves and colours every particle; `look` sets colour, alpha and size from age (0..1).
  step(dt: number, move: (i: number, t: number, dt: number) => void, look: (i: number, t: number) => void): void {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) {
        this.life[i] = 0;
        this.col[i * 4 + 3] = 0;
        this.size[i] = 0;
        continue;
      }
      move(i, t, dt);
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      look(i, t);
    }
    const g = this.points.geometry;
    g.getAttribute("position").needsUpdate = true;
    g.getAttribute("aColor").needsUpdate = true;
    g.getAttribute("aSize").needsUpdate = true;
  }

  setColour(i: number, r: number, g: number, b: number, a: number): void {
    this.col[i * 4] = r;
    this.col[i * 4 + 1] = g;
    this.col[i * 4 + 2] = b;
    this.col[i * 4 + 3] = a;
  }

  clear(): void {
    this.life.fill(0);
    this.col.fill(0);
    this.size.fill(0);
  }
}

class Fire {
  mode: Mode = "burning";
  modeTime = 0; // seconds in the current mode
  heat = 0.5; // smoothed
  targetHeat = 0.5;
  fighting = false;
  sprayFrom: THREE.Vector3 | null = null;
  private acc = { flame: 0, smoke: 0, ember: 0, spray: 0 };

  constructor(public src: FireSource) {}

  // How many of each to emit this frame, given rates per second.
  private take(kind: keyof Fire["acc"], rate: number, dt: number): number {
    this.acc[kind] += rate * dt;
    const n = Math.floor(this.acc[kind]);
    this.acc[kind] -= n;
    return n;
  }

  get finished(): boolean {
    return (this.mode === "steam" && this.modeTime > 7) || (this.mode === "smoulder" && this.modeTime > 24);
  }

  // Strength of the glow, 0..1.
  glow(): number {
    if (this.mode === "burning") return this.heat;
    if (this.mode === "fought") return this.heat * Math.max(0, 1 - this.modeTime / 7);
    if (this.mode === "smoulder") return 0.35 * Math.max(0, 1 - this.modeTime / 6);
    return 0;
  }

  update(dt: number, p: { flame: Pool; glow: Pool; smoke: Pool; ember: Pool; spray: Pool }): void {
    this.modeTime += dt;
    this.heat += (this.targetHeat - this.heat) * Math.min(1, dt * 1.5);
    const { centre, width, depth, height } = this.src;
    const area = Math.sqrt((width * depth) / 16); // 1 for a one-cell building
    const fade = (seconds: number) => Math.max(0, 1 - this.modeTime / seconds);
    let flames = 0;
    let smoke = 0;
    let steam = 0;
    let embers = 0;
    let spray = 0;
    switch (this.mode) {
      case "burning":
        flames = 85 * area * this.heat;
        smoke = 20 * area * (0.5 + this.heat);
        embers = 9 * area * this.heat;
        break;
      case "fought": {
        const f = fade(7); // a fire station needs ~4 ticks (8 s); the flames are down well before
        flames = 75 * area * this.heat * f * f;
        smoke = 10 * area * f;
        steam = 22 * area * (1 - f * 0.5);
        embers = 4 * area * f;
        spray = 90;
        break;
      }
      case "steam":
        steam = 18 * area * fade(6);
        break;
      case "smoulder":
        flames = 18 * area * fade(5);
        smoke = 14 * area * fade(22);
        embers = 3 * area * fade(10);
        break;
    }
    const r = Math.random;
    // flames: anywhere over the roof, and up the top half of the walls
    for (let k = this.take("flame", flames, dt); k > 0; k--) {
      const onRoof = this.mode === "smoulder" || r() < 0.6;
      let x = centre.x + (r() - 0.5) * width * 0.9;
      let z = centre.z + (r() - 0.5) * depth * 0.9;
      let y = onRoof ? height * (this.mode === "smoulder" ? 0.15 : 0.92) : height * (0.45 + r() * 0.5);
      if (!onRoof) {
        // on a wall: snap to one of the four sides, just outside it
        if (r() < 0.5) x = centre.x + (r() < 0.5 ? -1 : 1) * width * 0.52;
        else z = centre.z + (r() < 0.5 ? -1 : 1) * depth * 0.52;
      }
      y = Math.max(0.2, y);
      const big = Math.min(1.6, Math.max(1, area));
      const size = (1.6 + r() * 2.0) * (0.75 + 0.5 * this.heat) * big;
      p.flame.emit(x, y, z, (r() - 0.5) * 0.8, 2.0 + r() * 1.8, (r() - 0.5) * 0.8, 0.55 + r() * 0.5, size);
      if (r() < 0.35) p.glow.emit(x, y + 0.2, z, (r() - 0.5) * 0.4, 1.2 + r(), (r() - 0.5) * 0.4, 0.35 + r() * 0.25, size * 1.4);
    }
    // smoke and steam: from the top, rising and spreading
    const puff = (tone: number) => {
      const x = centre.x + (r() - 0.5) * width * 0.7;
      const z = centre.z + (r() - 0.5) * depth * 0.7;
      const y = (this.mode === "smoulder" ? 0.6 : height) + 0.4 + r() * 0.6;
      p.smoke.emit(x, y, z, (r() - 0.5) * 0.6, 1.8 + r() * 1.2, (r() - 0.5) * 0.6, 3.5 + r() * 2.5, (2.2 + r() * 1.6) * Math.min(1.5, Math.max(1, area)), tone);
    };
    for (let k = this.take("smoke", smoke, dt); k > 0; k--) puff(0);
    for (let k = Math.floor(steam * dt + r()); k > 0 && steam > 0; k--) puff(1);
    // embers: small, fast, flung upward
    for (let k = this.take("ember", embers, dt); k > 0; k--) {
      p.ember.emit(centre.x + (r() - 0.5) * width * 0.6, height * 0.9, centre.z + (r() - 0.5) * depth * 0.6, (r() - 0.5) * 3, 3 + r() * 4, (r() - 0.5) * 3, 1.0 + r() * 1.4, 0.25 + r() * 0.2);
    }
    // water: arcs from the fire station's side onto the roof
    if (spray > 0 && this.sprayFrom) {
      const from = this.sprayFrom;
      const target = new THREE.Vector3(centre.x, height * 0.85, centre.z);
      const T = 0.9; // flight time
      for (let k = this.take("spray", spray, dt); k > 0; k--) {
        const tx = target.x + (r() - 0.5) * width * 0.6;
        const tz = target.z + (r() - 0.5) * depth * 0.6;
        const vx = (tx - from.x) / T;
        const vz = (tz - from.z) / T;
        const vy = (target.y - from.y) / T + 0.5 * 9.8 * T; // ballistic
        p.spray.emit(from.x, from.y, from.z, vx * (0.95 + r() * 0.1), vy * (0.95 + r() * 0.1), vz * (0.95 + r() * 0.1), T * (0.9 + r() * 0.2), 0.9 + r() * 0.5);
      }
    }
  }
}

export class FireLayer {
  readonly group = new THREE.Group();
  readonly light = new THREE.PointLight(0xff7a2a, 0, 34, 1.6);
  private readonly pools = {
    smoke: new Pool(200, THREE.NormalBlending),
    flame: new Pool(260, THREE.NormalBlending), // solid tongues: additive washes out over light walls and sky
    glow: new Pool(90, THREE.AdditiveBlending), // the bright heat at the base of the flames
    ember: new Pool(70, THREE.AdditiveBlending),
    spray: new Pool(140, THREE.NormalBlending),
  };
  private readonly fires = new Map<number, Fire>();
  private time = 0;

  constructor() {
    // smoke drawn first (behind), then water, then the glowing flames and embers on top
    this.pools.smoke.points.renderOrder = 2;
    this.pools.spray.points.renderOrder = 3;
    this.pools.flame.points.renderOrder = 4;
    this.pools.glow.points.renderOrder = 5;
    this.pools.ember.points.renderOrder = 6;
    this.group.add(this.pools.smoke.points, this.pools.spray.points, this.pools.flame.points, this.pools.glow.points, this.pools.ember.points, this.light);
  }

  // Called whenever the city changes: the buildings burning now. A fire that is no longer listed
  // goes out (steam) or, when its building has become ruins, smoulders.
  sync(burning: FireSource[], isRuins: (anchor: number) => boolean): void {
    const now = new Set<number>();
    for (const src of burning) {
      now.add(src.anchor);
      let f = this.fires.get(src.anchor);
      if (!f || f.mode === "steam" || f.mode === "smoulder") {
        f = new Fire(src);
        this.fires.set(src.anchor, f);
      }
      f.src = src;
      f.targetHeat = src.heat;
      if (src.fighting && f.mode === "burning") {
        f.mode = "fought";
        f.modeTime = 0;
      }
      f.sprayFrom = src.sprayFrom;
    }
    for (const [anchor, f] of this.fires) {
      if (now.has(anchor) || f.mode === "steam" || f.mode === "smoulder") continue;
      f.mode = isRuins(anchor) ? "smoulder" : "steam";
      f.modeTime = 0;
    }
  }

  clear(): void {
    this.fires.clear();
    for (const p of Object.values(this.pools)) p.clear();
    this.light.intensity = 0;
  }

  // Per frame. pixelScale = viewport height / (2 tan(fov / 2)), so particle sizes are in world units.
  update(dt: number, pixelScale: number): void {
    this.time += dt;
    for (const [anchor, f] of this.fires) {
      f.update(dt, this.pools);
      if (f.finished) this.fires.delete(anchor);
    }
    // the glow sits over the strongest fire and flickers
    let best: Fire | null = null;
    for (const f of this.fires.values()) if (!best || f.glow() > best.glow()) best = f;
    if (best && best.glow() > 0.01) {
      const flicker = 0.78 + 0.14 * Math.sin(this.time * 17.3) + 0.08 * Math.sin(this.time * 31.7 + 1.3);
      this.light.position.set(best.src.centre.x, best.src.height + 1.5, best.src.centre.z);
      this.light.intensity = 90 * best.glow() * flicker;
    } else {
      this.light.intensity = 0;
    }
    const { flame, glow, smoke, ember, spray } = this.pools;
    for (const p of [flame, glow, smoke, ember, spray]) p.setScale(pixelScale);
    glow.step(
      dt,
      () => {},
      (i, t) => {
        glow.setColour(i, 1, 0.62, 0.22, (1 - t) * 0.5);
        glow.size[i] = glow.base[i] * (1 - 0.3 * t);
      },
    );
    flame.step(
      dt,
      (i, _t, d) => {
        flame.vel[i * 3] += (Math.random() - 0.5) * 7 * d; // flicker sideways
        flame.vel[i * 3 + 2] += (Math.random() - 0.5) * 7 * d;
        flame.vel[i * 3 + 1] += 2.2 * d; // hot air rises faster
      },
      (i, t) => {
        // yellow at the root, orange, then deep red and dark as it dies into smoke
        let r: number;
        let g: number;
        let b: number;
        if (t < 0.3) {
          const k = t / 0.3;
          r = 1;
          g = 0.86 - 0.4 * k;
          b = 0.3 - 0.24 * k;
        } else {
          const k = (t - 0.3) / 0.7;
          r = 1 - 0.5 * k;
          g = 0.46 - 0.38 * k;
          b = 0.06;
        }
        flame.setColour(i, r, g, b, Math.min(1, (1 - t) * 1.6) * 0.88);
        flame.size[i] = flame.base[i] * (1 - 0.5 * t);
      },
    );
    smoke.step(
      dt,
      (i, _t, d) => {
        smoke.vel[i * 3] += (WIND.x - smoke.vel[i * 3]) * 0.4 * d;
        smoke.vel[i * 3 + 2] += (WIND.z - smoke.vel[i * 3 + 2]) * 0.4 * d;
        smoke.vel[i * 3 + 1] += (1.4 - smoke.vel[i * 3 + 1]) * 0.5 * d; // slows to a steady rise
      },
      (i, t) => {
        const steam = smoke.tone[i];
        // smoke starts near-black over the fire and greys as it thins; steam is white throughout
        const grey = steam > 0.5 ? 0.88 : 0.08 + 0.3 * t;
        const a = Math.min(1, t * 6) * Math.pow(1 - t, 0.8) * (steam > 0.5 ? 0.45 : 0.72);
        smoke.setColour(i, grey, grey, grey * (steam > 0.5 ? 1 : 1.04), a);
        smoke.size[i] = smoke.base[i] * (1 + 3.2 * t);
      },
    );
    ember.step(
      dt,
      (i, _t, d) => {
        ember.vel[i * 3 + 1] -= 2.5 * d; // they arc over and fall
        ember.vel[i * 3] += (WIND.x - ember.vel[i * 3]) * 0.3 * d;
      },
      (i, t) => {
        ember.setColour(i, 1, 0.75 - 0.35 * t, 0.25, (1 - t) * (0.6 + 0.4 * Math.sin(this.time * 40 + i)));
        ember.size[i] = ember.base[i];
      },
    );
    spray.step(
      dt,
      (i, _t, d) => {
        spray.vel[i * 3 + 1] -= 9.8 * d;
      },
      (i, t) => {
        spray.setColour(i, 0.55, 0.78, 1, 0.9 * (1 - t * t)); // blue enough to read against pale walls
        spray.size[i] = spray.base[i] * (1 + t);
      },
    );
  }

  // For tests and the HUD.
  stats(): { fires: number; flames: number; smoke: number; embers: number; spray: number; light: number } {
    return {
      fires: this.fires.size,
      flames: this.pools.flame.alive(),
      smoke: this.pools.smoke.alive(),
      embers: this.pools.ember.alive(),
      spray: this.pools.spray.alive(),
      light: this.light.intensity,
    };
  }
}