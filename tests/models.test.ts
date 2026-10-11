import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildModel, modelKeys, rawGeometry, type PartJson } from "@/render/models";
import { TILE_LIST } from "@/sim/tileDefs";
import { GRID } from "@/config/tuning";

describe("model factory", () => {
  it("builds every tile model into non-empty geometry that fits its footprint", () => {
    for (const def of TILE_LIST) {
      const m = buildModel(def.key);
      expect(m.opaque, def.key).not.toBeNull();
      m.opaque!.computeBoundingBox();
      const bb = m.opaque!.boundingBox!;
      const margin = 2.5; // a few parts overhang the slab on purpose (roofs, rails; the cargo crane reaches 2.4 over the water)
      expect(bb.max.x - bb.min.x, `${def.key} width`).toBeLessThanOrEqual(def.w * GRID.CELL_UNITS + margin);
      expect(bb.max.z - bb.min.z, `${def.key} depth`).toBeLessThanOrEqual(def.h * GRID.CELL_UNITS + margin);
      expect(bb.min.y, `${def.key} base`).toBeGreaterThanOrEqual(-2); // floating buildings hang nets and piles below the water
      expect(m.height).toBeGreaterThan(0.1);
      const n = m.opaque!.getAttribute("position").count;
      expect(m.opaque!.getAttribute("color").count).toBe(n);
      expect(m.opaque!.getAttribute("aMat").count, `${def.key} material ids`).toBe(n);
      expect(m.opaque!.getAttribute("aUv").count, `${def.key} surface coords`).toBe(n);
    }
  });

  it("gives the wind turbine and ferris wheel a rotor on a hub", () => {
    for (const key of ["wind_turbine", "ferris_wheel", "offshore_wind"]) {
      const m = buildModel(key);
      expect(m.hub, key).not.toBeNull();
      expect(m.rotor, key).not.toBeNull();
    }
    expect(buildModel("house").rotor).toBeNull();
  });

  it("builds the vehicles", () => {
    for (const key of modelKeys("vehicles")) {
      const m = buildModel(key, "vehicles");
      expect(m.opaque, key).not.toBeNull();
      expect(new THREE.Box3().setFromBufferAttribute(m.opaque!.getAttribute("position") as THREE.BufferAttribute).max.y).toBeGreaterThan(0.5);
    }
  });

  it("builds every part shape outside-out: each face's winding normal points away from the centre", () => {
    const shape = (k: PartJson["k"]): PartJson => ({ n: "t", k, s: [2, 1.5, 3], p: [0, 0, 0], c: [1, 1, 1], m: "plastic" });
    for (const k of ["box", "wedge", "ball", "cylinder"] as const) {
      const g = rawGeometry(shape(k));
      const geo = g.index ? g.toNonIndexed() : g;
      const pos = geo.getAttribute("position");
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      let inward = 0;
      for (let i = 0; i < pos.count; i += 3) {
        a.fromBufferAttribute(pos, i);
        b.fromBufferAttribute(pos, i + 1);
        c.fromBufferAttribute(pos, i + 2);
        const n = b.clone().sub(a).cross(c.clone().sub(a));
        if (n.lengthSq() < 1e-12) continue; // degenerate (sphere poles)
        const centre = a.clone().add(b).add(c).divideScalar(3);
        if (k === "wedge") centre.sub(new THREE.Vector3(0, -0.25, 0.5)); // relative to the wedge's centroid
        if (n.dot(centre) < 0) inward++;
      }
      expect(inward, `${k} faces wound inward`).toBe(0);
    }
  });
});