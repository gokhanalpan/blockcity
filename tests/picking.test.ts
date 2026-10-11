import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { pickHits } from "@/render/input";

// A ground plane, a tall building (anchor 1) and, right behind it, a flat one (anchor 2).
function scene() {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshBasicMaterial());
  ground.rotation.x = -Math.PI / 2;
  const tall = new THREE.Group();
  tall.userData.anchor = 1;
  const body = new THREE.Mesh(new THREE.BoxGeometry(4, 14, 4), new THREE.MeshBasicMaterial());
  body.position.y = 7;
  tall.add(body);
  tall.position.set(10, 0, 10); // spans z 8..12
  const behind = new THREE.Group();
  behind.userData.anchor = 2;
  const base = new THREE.Mesh(new THREE.BoxGeometry(4, 0.2, 4), new THREE.MeshBasicMaterial());
  base.position.y = 0.1;
  behind.add(base);
  behind.position.set(10, 0, 18); // spans z 16..20
  const forSale = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshBasicMaterial());
  forSale.rotation.x = -Math.PI / 2;
  forSale.position.set(60, 0.3, 60);
  forSale.userData.chunk = 5;
  for (const o of [ground, tall, behind, forSale]) o.updateMatrixWorld(true);
  return { ground, tall, behind, forSale };
}

function ray(from: [number, number, number], to: [number, number, number]): THREE.Raycaster {
  const o = new THREE.Vector3(...from);
  return new THREE.Raycaster(o, new THREE.Vector3(...to).sub(o).normalize());
}

describe("picking", () => {
  it("a click on a tall building's wall picks that building, not the one on the ground behind it", () => {
    const { ground, tall, behind, forSale } = scene();
    // aimed at the tall building's front wall (z = 8, y = 4); carried on, it meets the ground at z = 18
    const r = ray([10, 15.2, -20], [10, 4, 8]);
    const p = pickHits(r, ground, [forSale], [tall, behind]);
    expect(p.world!.z).toBeCloseTo(18, 0); // what the old ground-only picking used: the building behind
    expect(p.anchor).toBe(1);
  });

  it("a building seen from above is picked by its roof or base; open ground picks nothing", () => {
    const { ground, tall, behind, forSale } = scene();
    expect(pickHits(ray([10, 40, 18], [10, 0, 18]), ground, [forSale], [tall, behind]).anchor).toBe(2);
    expect(pickHits(ray([10, 40, 10], [10, 0, 10]), ground, [forSale], [tall, behind]).anchor).toBe(1);
    const open = pickHits(ray([30, 40, 30], [30, 0, 30]), ground, [forSale], [tall, behind]);
    expect(open.anchor).toBeUndefined();
    expect(open.world!.x).toBeCloseTo(30, 5);
  });

  it("land for sale is still reported as the hit when no building is in the way", () => {
    const { ground, tall, behind, forSale } = scene();
    const p = pickHits(ray([60, 40, 60], [60, 0, 60]), ground, [forSale], [tall, behind]);
    expect(p.anchor).toBeUndefined();
    expect(p.hit?.userData.chunk).toBe(5);
  });
});