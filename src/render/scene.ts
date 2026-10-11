// Renderer, lights and the tilted camera shared by the game and the model gallery.
import * as THREE from "three";
import { setEnvironment } from "./models";

export interface SceneRig {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  resize: () => void;
}

export const SKY = 0x9ed6f7;

// Where the sunlight comes from (towards the sun). From the side of the default view, not from behind
// the camera: the camera looks in from the front-left (-x, -z), so the sun lights the -x faces and
// leaves the -z faces in shade. One lit side and one shaded side per building is what makes the scene
// read as lit; with the sun behind the camera both visible sides got the same light and looked flat.
export const SUN_DIR = new THREE.Vector3(-0.55, 0.8, 0.45).normalize();

// Light levels (three.js lights are physically based: a Lambert surface gets intensity / PI).
// With these a sunlit roof or lawn sits at its full colour, a sunlit wall at ~80%, a shaded wall at
// ~40% with a blue tint from the sky (as in Roblox), and ground in shadow at ~50%.
export const LIGHT = { sky: 0xd2e2ff, ground: 0xd8dcd4, ambient: 1.3, sun: 0xfff2dc, sunIntensity: 2.4, shadow: 0.85 } as const;

// A soft sky to light and reflect in: a gradient dome (zenith blue, pale horizon, grass-green ground)
// with a bright sun, prefiltered once. Glass picks up the sky; metal and plastic get a sheen.
export function skyEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const dome = new THREE.SphereGeometry(10, 48, 24);
  const pos = dome.getAttribute("position");
  const colours = new Float32Array(pos.count * 3);
  const zenith = new THREE.Color(0x6db8ee);
  const horizon = new THREE.Color(0xe6f4fb);
  const ground = new THREE.Color(0x8fae78);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / 10;
    if (t >= 0) c.copy(horizon).lerp(zenith, Math.pow(t, 0.55));
    else c.copy(horizon).lerp(ground, Math.min(1, -t * 4));
    colours[i * 3] = c.r;
    colours[i * 3 + 1] = c.g;
    colours[i * 3 + 2] = c.b;
  }
  dome.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  scene.add(new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 7.6, 7) }));
  sun.position.copy(SUN_DIR).multiplyScalar(9);
  scene.add(sun);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(scene, 0.03).texture;
  pmrem.dispose();
  return env;
}

export function createScene(canvas: HTMLCanvasElement): SceneRig {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 520, 1500); // the sea fades into the sky at the horizon
  setEnvironment(skyEnvironment(renderer)); // buildings and glass only; see models.ts

  const camera = new THREE.PerspectiveCamera(40, 1, 1, 2000);

  const hemi = new THREE.HemisphereLight(LIGHT.sky, LIGHT.ground, LIGHT.ambient);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(LIGHT.sun, LIGHT.sunIntensity);
  sun.position.copy(SUN_DIR).multiplyScalar(130);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.intensity = LIGHT.shadow; // clear shadows, as in Roblox, with a little light left in them
  scene.add(sun);
  scene.add(sun.target);

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();
  return { renderer, scene, camera, sun, resize };
}

// Size the sun's shadow box to cover a square of `extent` world units centred on `centre`.
export function fitShadow(sun: THREE.DirectionalLight, centre: THREE.Vector3, extent: number): void {
  const cam = sun.shadow.camera as THREE.OrthographicCamera;
  sun.target.position.copy(centre);
  sun.position.copy(centre).addScaledVector(SUN_DIR, extent * 1.2);
  cam.left = -extent / 2;
  cam.right = extent / 2;
  cam.top = extent / 2;
  cam.bottom = -extent / 2;
  cam.near = 1;
  cam.far = extent * 3;
  cam.updateProjectionMatrix();
}