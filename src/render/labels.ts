// DOM labels pinned to world points: chunk prices, the "3/4 !" over buildings, event badges.
// Plain divs positioned every frame from the camera; cheap at a few hundred and crisp on any DPI.
import * as THREE from "three";

export class Labels {
  private readonly items = new Map<string, { el: HTMLElement; pos: THREE.Vector3 }>();
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly layer: HTMLElement) {}

  set(id: string, pos: THREE.Vector3, html: string, className: string): void {
    let item = this.items.get(id);
    if (!item) {
      const el = document.createElement("div");
      this.layer.appendChild(el);
      item = { el, pos: pos.clone() };
      this.items.set(id, item);
    } else {
      item.pos.copy(pos);
    }
    if (item.el.innerHTML !== html) item.el.innerHTML = html;
    const cls = `label ${className}`;
    if (item.el.className !== cls) item.el.className = cls;
  }

  remove(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    item.el.remove();
    this.items.delete(id);
  }

  removeWhere(pred: (id: string) => boolean): void {
    for (const id of [...this.items.keys()]) if (pred(id)) this.remove(id);
  }

  update(camera: THREE.Camera, width: number, height: number): void {
    for (const { el, pos } of this.items.values()) {
      this.tmp.copy(pos).project(camera);
      const behind = this.tmp.z > 1;
      const x = (this.tmp.x * 0.5 + 0.5) * width;
      const y = (-this.tmp.y * 0.5 + 0.5) * height;
      el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.style.visibility = behind || x < -100 || x > width + 100 || y < -50 || y > height + 50 ? "hidden" : "visible";
    }
  }
}
