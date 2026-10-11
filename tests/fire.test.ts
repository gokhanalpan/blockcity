import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { FireLayer, type FireSource } from "@/render/fire";

const src = (over: Partial<FireSource> = {}): FireSource => ({
  anchor: 7, centre: new THREE.Vector3(10, 0, 10), width: 8, depth: 8, height: 6, heat: 0.8, fighting: false, sprayFrom: null, ...over,
});

function run(layer: FireLayer, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 30) layer.update(1 / 30, 600);
}

describe("fire effect", () => {
  it("a burning building has flames, smoke, embers and a glow", () => {
    const f = new FireLayer();
    f.sync([src()], () => false);
    run(f, 1.5);
    const s = f.stats();
    expect(s.fires).toBe(1);
    expect(s.flames).toBeGreaterThan(20);
    expect(s.smoke).toBeGreaterThan(10);
    expect(s.embers).toBeGreaterThan(3);
    expect(s.light).toBeGreaterThan(20);
    expect(s.spray).toBe(0);
  });

  it("a fire station sprays water and the flames die down to steam", () => {
    const f = new FireLayer();
    f.sync([src()], () => false);
    run(f, 1);
    const before = f.stats().flames;
    f.sync([src({ fighting: true, sprayFrom: new THREE.Vector3(0, 0.8, 0) })], () => false);
    run(f, 6);
    const s = f.stats();
    expect(s.spray).toBeGreaterThan(20);
    expect(s.flames).toBeLessThan(before / 3);
    f.sync([], () => false); // put out
    run(f, 8);
    expect(f.stats().fires).toBe(0);
    expect(f.stats().light).toBe(0);
  });

  it("a burnt-down building's ruins smoulder for a while, then stop", () => {
    const f = new FireLayer();
    f.sync([src()], () => false);
    run(f, 1);
    f.sync([], () => true); // burnt down: the tile is ruins now
    run(f, 10);
    expect(f.stats().fires).toBe(1);
    expect(f.stats().smoke).toBeGreaterThan(0);
    run(f, 20);
    expect(f.stats().fires).toBe(0);
    expect(f.stats().light).toBe(0);
  });
});