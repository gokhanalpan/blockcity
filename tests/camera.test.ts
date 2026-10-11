import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CityCamera } from "@/render/camera";

// Where a world point lands on screen (NDC: x right, y up).
function screen(cam: CityCamera, p: THREE.Vector3): THREE.Vector3 {
  cam.update(0);
  cam.camera.updateMatrixWorld();
  return p.clone().project(cam.camera);
}

describe("camera panning", () => {
  // pan(dx, dy) takes a drag in screen pixels: the ground follows the pointer ("grab and pull").
  // Keys use the same call: A/left = pan(+x), so the ground moves right and the view goes left.
  for (const deg of [0, 62, 152, 242]) {
    it(`drags with the pointer and keys go the right way at yaw ${deg}`, () => {
      const cam = new CityCamera(new THREE.PerspectiveCamera(40, 1.5, 1, 2000));
      cam.setBounds(1000, 100);
      cam.setYaw(THREE.MathUtils.degToRad(deg));
      cam.focus(new THREE.Vector3(96, 0, 96), 120);
      const mark = new THREE.Vector3(96, 0, 96);
      const before = screen(cam, mark);

      cam.pan(100, 0); // drag right (or A / left arrow)
      const right = screen(cam, mark);
      expect(right.x, "a point under a right drag moves right").toBeGreaterThan(before.x + 0.05);
      expect(Math.abs(right.y - before.y)).toBeLessThan(0.05);

      cam.focus(new THREE.Vector3(96, 0, 96));
      cam.pan(0, 100); // drag down (or S / down arrow)
      const down = screen(cam, mark);
      expect(down.y, "a point under a down drag moves down").toBeLessThan(before.y - 0.05);
      expect(Math.abs(down.x - before.x)).toBeLessThan(0.05);
    });
  }
});