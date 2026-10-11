// Three save slots in localStorage, plus export/import as a file. The backend is an interface so a
// cloud store can be added behind the same calls later (the SaveFile already carries id/revision).

import { GRID, SAVE } from "@/config/tuning";
import { newDistrict } from "@/sim/district";
import { City } from "@/sim/city";
import { buildSave, parseSave, type SaveFile, type SaveIdentity, type SaveMeta, newSaveId } from "./format";

export interface SaveBackend {
  read(slot: number): string | null;
  write(slot: number, text: string): void;
  remove(slot: number): void;
}

const KEY_PREFIX = "blockcity.slot.";

export class LocalStorageBackend implements SaveBackend {
  constructor(private readonly storage: Storage = globalThis.localStorage) {}
  read(slot: number): string | null {
    return this.storage.getItem(KEY_PREFIX + slot);
  }
  write(slot: number, text: string): void {
    this.storage.setItem(KEY_PREFIX + slot, text);
  }
  remove(slot: number): void {
    this.storage.removeItem(KEY_PREFIX + slot);
  }
}

export class MemoryBackend implements SaveBackend {
  private map = new Map<number, string>();
  read(slot: number): string | null {
    return this.map.get(slot) ?? null;
  }
  write(slot: number, text: string): void {
    this.map.set(slot, text);
  }
  remove(slot: number): void {
    this.map.delete(slot);
  }
}

export interface SlotSummary {
  slot: number;
  meta: SaveMeta | null; // null = empty slot
  savedAt: number;
  corrupt: boolean;
}

export class SaveStore {
  constructor(private readonly backend: SaveBackend = new LocalStorageBackend()) {}

  slots(): SlotSummary[] {
    const out: SlotSummary[] = [];
    for (let slot = 1; slot <= SAVE.SLOTS; slot++) {
      const text = this.backend.read(slot);
      if (text === null) {
        out.push({ slot, meta: null, savedAt: 0, corrupt: false });
        continue;
      }
      try {
        const save = parseSave(JSON.parse(text));
        out.push({ slot, meta: save.meta, savedAt: save.savedAt, corrupt: false });
      } catch {
        out.push({ slot, meta: null, savedAt: 0, corrupt: true });
      }
    }
    return out;
  }

  load(slot: number): SaveFile | null {
    const text = this.backend.read(slot);
    if (text === null) return null;
    return parseSave(JSON.parse(text));
  }

  save(slot: number, file: SaveFile): void {
    this.backend.write(slot, JSON.stringify(file));
  }

  delete(slot: number): void {
    this.backend.remove(slot);
  }
}

// A loaded city with its save identity, ready for autosave. Tracks play time in whole seconds.
export class Session {
  readonly city: City;
  identity: SaveIdentity;
  readonly slot: number;
  offlinePaid = 0; // what the player was paid for the time away, for the welcome-back toast
  private playStart: number;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly store: SaveStore, slot: number, city: City, identity: SaveIdentity, now: number = Date.now()) {
    this.store = store;
    this.slot = slot;
    this.city = city;
    this.identity = identity;
    this.playStart = now;
    city.onChange(() => this.scheduleSave());
  }

  // New city in a slot.
  static create(store: SaveStore, slot: number, terrain: string, name?: string): Session {
    const city = new City(newDistrict(GRID.SIZE, terrain));
    if (name) city.rename(name);
    const s = new Session(store, slot, city, { id: newSaveId(), revision: 0, playSeconds: 0 });
    s.saveNow();
    return s;
  }

  // Load an existing slot, paying offline earnings for the time away.
  static open(store: SaveStore, slot: number, now: number = Date.now()): Session | null {
    const file = store.load(slot);
    if (!file) return null;
    return Session.fromSave(store, slot, file, now);
  }

  static fromSave(store: SaveStore, slot: number, file: SaveFile, now: number = Date.now()): Session {
    const city = City.fromBlob(file.city);
    const s = new Session(store, slot, city, { id: file.id, revision: file.revision, playSeconds: file.playSeconds }, now);
    if (file.savedAt > 0) s.offlinePaid = city.payOffline((now - file.savedAt) / 1000);
    return s;
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, SAVE.AUTOSAVE_DEBOUNCE_MS);
  }

  saveNow(now: number = Date.now()): SaveFile {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.identity.playSeconds += Math.max(0, Math.floor((now - this.playStart) / 1000));
    this.playStart = now;
    this.identity.revision += 1;
    const file = buildSave(this.city, this.identity, now);
    this.store.save(this.slot, file);
    this.city.district.dirty = false;
    return file;
  }

  exportText(): string {
    return JSON.stringify(this.saveNow(), null, 0);
  }
}

// Import a file's text into a slot (replacing it). Returns the parsed save so the caller can open it.
export function importSaveText(store: SaveStore, slot: number, text: string): SaveFile {
  const file = parseSave(JSON.parse(text));
  file.id = file.id || newSaveId();
  store.save(slot, file);
  return file;
}
