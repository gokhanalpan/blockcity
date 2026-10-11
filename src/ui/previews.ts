// Thumbnails for the build cards: each model rendered once by a small offscreen WebGL renderer
// into a PNG data URL, from the game's own camera angle and lighting, then cached.
import * as THREE from "three";
import { glassMaterial, instantiate, opaqueMaterial, surfaceMaterials } from "@/render/models";
import { CELL } from "@/render/coords";
import { LIGHT, SUN_DIR, skyEnvironment } from "@/render/scene";
import { defByKey } from "@/sim/tileDefs";

const SIZE = 128;
let renderer: THREE.WebGLRenderer | null = null;
let mats: ReturnType<typeof surfaceMaterials> | null = null; // this context's own pair, with its own sky
const cache = new Map<string, string>();

export function previewUrl(key: string): string {
  const hit = cache.get(key);
  if (hit) return hit;
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(SIZE, SIZE);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mats = surfaceMaterials(skyEnvironment(renderer));
  }
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(LIGHT.sky, LIGHT.ground, LIGHT.ambient));
  const sun = new THREE.DirectionalLight(LIGHT.sun, LIGHT.sunIntensity);
  sun.position.copy(SUN_DIR).multiplyScalar(8); // same side as in the world: front-left camera, lit -x side
  scene.add(sun);
  const def = defByKey(key);
  const inst = instantiate(key);
  inst.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.material === opaqueMaterial) o.material = mats!.opaque;
    else if (o.material === glassMaterial) o.material = mats!.glass;
  });
  const w = def.w * CELL;
  const h = def.h * CELL;
  scene.add(inst.group);
  const pad = new THREE.Mesh(new THREE.BoxGeometry(w + 1.2, 0.5, h + 1.2), new THREE.MeshLambertMaterial({ color: def.onWater ? 0x4aa3d8 : 0x79b86a }));
  pad.position.y = -0.25;
  scene.add(pad);
  const size = Math.max(w, h, inst.height * 0.9);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 500);
  const d = size * 2.1;
  camera.position.set(-d * 0.55, d * 0.75, -d * 0.8);
  camera.lookAt(0, Math.min(inst.height * 0.4, size * 0.35), 0);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");
  cache.set(key, url);
  scene.remove(inst.group);
  pad.geometry.dispose();
  return url;
}