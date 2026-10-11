// Model gallery: every catalog model laid out by build-menu category on a lawn, with the game's
// camera and lighting. A dev page to check the exported models before the world renderer exists.
// Hover a model for its name; drag to orbit, wheel to zoom.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CATEGORIES, TILE_LIST, defByKey, isRuins } from "@/sim/tileDefs";
import { instantiate, modelKeys } from "@/render/models";
import { createScene, fitShadow } from "@/render/scene";
import { CELL } from "@/render/coords";

export function startGallery(root: HTMLElement): void {
  const canvas = document.createElement("canvas");
  canvas.className = "view";
  root.appendChild(canvas);
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = "Block City models. Hover a building for its name.";
  root.appendChild(label);

  const rig = createScene(canvas);
  const { scene, camera, renderer } = rig;

  // categories as rows, plus Other (ruins) and the vehicles
  const groups: { name: string; keys: string[]; source: "tiles" | "vehicles" }[] = CATEGORIES.map((c) => ({ name: c.name, keys: [...c.keys], source: "tiles" }));
  const claimed = new Set(CATEGORIES.flatMap((c) => c.keys));
  groups.push({ name: "Ruins", keys: TILE_LIST.filter((d) => !claimed.has(d.key) && isRuins(d)).map((d) => d.key), source: "tiles" });
  groups.push({ name: "Vehicles", keys: modelKeys("vehicles"), source: "vehicles" });

  const rotors: THREE.Mesh[] = [];
  const pickables: THREE.Object3D[] = [];
  const GAP = CELL; // one cell between models
  let z = 0;
  let maxX = 0;
  for (const g of groups) {
    let x = 0;
    let rowDepth = 1;
    for (const key of g.keys) {
      const def = g.source === "tiles" ? defByKey(key) : undefined;
      const w = def ? def.w : 1;
      const h = def ? def.h : 1;
      const inst = instantiate(key, g.source);
      inst.group.position.set(x + (w * CELL) / 2, 0, z + (h * CELL) / 2);
      inst.group.userData.label = `${g.name}: ${def ? def.name : key} (${key})${def ? `  ${w}x${h}  $${def.cost}` : ""}`;
      inst.group.userData.key = key;
      scene.add(inst.group);
      pickables.push(inst.group);
      if (inst.rotor) rotors.push(inst.rotor);
      x += w * CELL + GAP;
      rowDepth = Math.max(rowDepth, h);
    }
    maxX = Math.max(maxX, x);
    z += rowDepth * CELL + GAP * 2;
  }

  // the lawn, a little bigger than the layout, with a sand rim and sea beyond
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(maxX + 2 * GAP, z + 2 * GAP), new THREE.MeshLambertMaterial({ color: 0x79b86a }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(maxX / 2, 0, z / 2 - GAP);
  grass.receiveShadow = true;
  scene.add(grass);
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(maxX + 6 * GAP, z + 6 * GAP), new THREE.MeshLambertMaterial({ color: 0xe6d6a3 }));
  sand.rotation.x = -Math.PI / 2;
  sand.position.set(maxX / 2, -0.05, z / 2 - GAP);
  sand.receiveShadow = true;
  scene.add(sand);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ color: 0x4aa3d8 }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(maxX / 2, -0.35, z / 2);
  scene.add(sea);

  const centre = new THREE.Vector3(maxX / 2, 0, z / 2);
  fitShadow(rig.sun, centre, Math.max(maxX, z) + 20);

  // the game's tilt: looking down at ~50 degrees from the front
  camera.position.set(centre.x, 110, centre.z + 150);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(centre);
  // ?gallery=<key> frames one model from its front-left, as the game's camera sees buildings
  const focus = new URLSearchParams(location.search).get("gallery");
  const hit = focus ? pickables.find((o) => o.userData.key === focus) : undefined;
  if (hit) {
    const size = new THREE.Box3().setFromObject(hit).getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z);
    controls.target.copy(hit.position).setY(size.y * 0.45);
    camera.position.copy(controls.target).add(new THREE.Vector3(-1.1 * r, 0.8 * r, -1.5 * r));
  }
  controls.maxPolarAngle = Math.PI / 2.2;
  controls.minDistance = 10;
  controls.maxDistance = 600;
  controls.enableDamping = true;
  controls.update();

  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hovered: THREE.Object3D | null = null;
  canvas.addEventListener("pointermove", (e) => {
    pointer.set((e.clientX / canvas.clientWidth) * 2 - 1, -(e.clientY / canvas.clientHeight) * 2 + 1);
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObjects(pickables, true)[0];
    let group: THREE.Object3D | null = hit ? hit.object : null;
    while (group && !group.userData.label) group = group.parent;
    if (group !== hovered) {
      hovered = group;
      label.textContent = group ? group.userData.label : "Block City models. Hover a building for its name.";
    }
  });

  const timer = new THREE.Timer();
  renderer.setAnimationLoop(() => {
    timer.update();
    const dt = timer.getDelta();
    for (const r of rotors) r.rotation.z += dt * 0.8;
    controls.update();
    renderer.render(scene, camera);
  });
}