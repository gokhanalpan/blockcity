// UI sounds synthesized with WebAudio: no files to ship. Same catalog as the Roblox Sounds.lua
// (place, buy, alarm, goal, chime, deny). Muted until the first user gesture unlocks audio.
type Name = "place" | "buy" | "alarm" | "goal" | "chime" | "deny" | "demolish";

export class Sounds {
  private ctx: AudioContext | null = null;
  enabled = true;

  constructor() {
    const unlock = () => {
      if (!this.ctx) this.ctx = new AudioContext();
      if (this.ctx.state === "suspended") void this.ctx.resume();
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType = "sine", gain = 0.18, slide = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    const t0 = ctx.currentTime + start;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  play(name: Name): void {
    if (!this.enabled || !this.ctx) return;
    switch (name) {
      case "place": this.tone(520, 0, 0.08, "triangle", 0.2, -120); break;
      case "demolish": this.tone(180, 0, 0.18, "sawtooth", 0.12, -80); break;
      case "buy": this.tone(660, 0, 0.1, "sine"); this.tone(990, 0.09, 0.14, "sine"); break;
      case "deny": this.tone(220, 0, 0.12, "square", 0.08, -60); break;
      case "chime": this.tone(880, 0, 0.12); this.tone(1320, 0.1, 0.2); break;
      case "goal": this.tone(523, 0, 0.12); this.tone(659, 0.12, 0.12); this.tone(784, 0.24, 0.12); this.tone(1047, 0.36, 0.3); break;
      case "alarm": for (let i = 0; i < 3; i++) this.tone(600 + i * 90, i * 0.18, 0.12, "square", 0.1); break;
    }
  }
}
