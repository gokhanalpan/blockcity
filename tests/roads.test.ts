import { describe, expect, it } from "vitest";
import { ROAD_RED, roadTint } from "@/render/roads";

describe("road colours by load", () => {
  it("plain under 20%, orange fading in by 44%, red from 85%, a separate pulsing red when jammed", () => {
    const glow = (load: number, cap: number) => roadTint(load, cap, false).emissive.r * roadTint(load, cap, false).emissiveIntensity;
    expect(glow(10, 60)).toBe(0); // 17%: plain asphalt
    const at44 = roadTint(352, 800, false); // a highway at 44% (the screenshot): visibly orange
    expect(at44.emissive.r).toBeGreaterThan(0.9);
    expect(at44.emissive.g).toBeGreaterThan(0.5);
    expect(at44.emissiveIntensity).toBeGreaterThan(0.25);
    expect(glow(20, 60)).toBeLessThan(glow(30, 60)); // 33% < 50%: it strengthens with the load
    const amber = roadTint(36, 60, false).emissive; // 60%
    expect(amber.r).toBeGreaterThan(0.9);
    expect(amber.g).toBeGreaterThan(0.4); // still orange-yellow
    const red = roadTint(Math.ceil(240 * ROAD_RED), 240, false).emissive; // 85% of an avenue (like Roblox's 98% bridge: red)
    expect(red.r).toBeGreaterThan(0.9);
    expect(red.g).toBeLessThan(0.2);
    expect(roadTint(235, 240, false).emissive.g).toBeLessThan(0.2); // 98%: red
    const jam = roadTint(70, 60, true); 
    expect(jam).not.toBe(roadTint(60, 60, false)); // over capacity has its own (pulsing) look
  });
});