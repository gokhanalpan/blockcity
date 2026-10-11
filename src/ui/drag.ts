// Draggable HUD panels. A panel is dragged by its handle (its coloured header, or the whole thing for
// small widgets); a press that moves less than 5 px is still a normal click. Positions are kept in
// localStorage (UI preference, not part of any save) and clamped to the window. Reset puts everything
// back where the stylesheet had it.

const KEY = "blockcity.ui.positions";
const THRESHOLD = 5;

type Pos = { x: number; y: number };

interface Item {
  el: HTMLElement;
  key: string;
  parent: HTMLElement;
  index: number; // original position among the parent's children
}

function load(): Record<string, Pos> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Pos>;
  } catch {
    return {};
  }
}

export class Draggables {
  private positions = load();
  private readonly items: Item[] = [];

  constructor(private readonly layer: HTMLElement) {
    window.addEventListener("resize", () => this.clampAll());
  }

  // handle: a CSS selector inside `el` that starts a drag, or null for the whole element.
  add(el: HTMLElement, key: string, handle: string | null): void {
    const parent = el.parentElement ?? this.layer;
    this.items.push({ el, key, parent, index: [...parent.children].indexOf(el) });
    const saved = this.positions[key];
    if (saved) {
      this.float(el, saved.x, saved.y);
      requestAnimationFrame(() => this.clampOne(el));
    }
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (handle && !target.closest(handle)) return;
      if (target.closest("input, textarea")) return;
      const start = el.getBoundingClientRect();
      const base = this.layer.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      let dragging = false;
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        if (!dragging) {
          if (Math.hypot(dx, dy) < THRESHOLD) return;
          dragging = true;
          this.float(el, start.left - base.left, start.top - base.top);
          el.classList.add("dragging");
        }
        const p = this.clamp(el, start.left - base.left + dx, start.top - base.top + dy);
        el.style.left = `${p.x}px`;
        el.style.top = `${p.y}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (!dragging) return;
        el.classList.remove("dragging");
        this.positions[key] = { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
        this.save();
        // the click that follows a drag must not press the button under the pointer
        const swallow = (ce: Event) => {
          ce.stopPropagation();
          ce.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  // Everything back to its stylesheet position.
  reset(): void {
    this.positions = {};
    this.save();
    const sorted = [...this.items].sort((a, b) => a.index - b.index);
    for (const it of sorted) {
      it.el.classList.remove("floating");
      it.el.style.left = "";
      it.el.style.top = "";
      if (it.el.parentElement !== it.parent) it.parent.insertBefore(it.el, it.parent.children[it.index] ?? null);
    }
  }

  private float(el: HTMLElement, x: number, y: number): void {
    // out of any flex column or centring transform, into the HUD layer itself
    if (el.parentElement !== this.layer) this.layer.appendChild(el);
    el.classList.add("floating");
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  // Keep at least a 40 px strip of the panel on screen.
  private clamp(el: HTMLElement, x: number, y: number): Pos {
    const w = el.offsetWidth || 100;
    const lw = this.layer.clientWidth;
    const lh = this.layer.clientHeight;
    return { x: Math.min(Math.max(x, 40 - w), lw - 40), y: Math.min(Math.max(y, 0), lh - 30) };
  }

  private clampOne(el: HTMLElement): void {
    if (!el.classList.contains("floating")) return;
    const p = this.clamp(el, parseFloat(el.style.left), parseFloat(el.style.top));
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
  }

  private clampAll(): void {
    for (const it of this.items) this.clampOne(it.el);
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.positions));
    } catch {
      // private mode or full storage: positions just won't persist
    }
  }
}