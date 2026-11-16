/**
 * "Seen so far" bookkeeping for the minimap. This is a client-side convenience only: it records the tiles within a
 * fixed radius of where a party member has stood this session. It does not claim the server hid anything (the map
 * always arrives whole); the minimap just dims what the party has not been near yet.
 */
export const SEEN_RADIUS = 7;

export class SeenGrid {
  readonly cells: Uint8Array;
  /** Bumped whenever a new tile becomes seen, so a cache can tell when to repaint. */
  version = 0;
  private spots = new Map<string, string>();

  constructor(readonly w: number, readonly h: number) {
    this.cells = new Uint8Array(w * h);
  }

  isSeen(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.cells[y * this.w + x] === 1;
  }

  /** Mark a disc of tiles around (cx, cy). Returns how many tiles were newly seen. */
  reveal(cx: number, cy: number, radius = SEEN_RADIUS): number {
    let added = 0;
    const r2 = radius * radius + radius;
    for (let y = Math.max(0, cy - radius); y <= Math.min(this.h - 1, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(this.w - 1, cx + radius); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        const i = y * this.w + x;
        if (this.cells[i] === 0) { this.cells[i] = 1; added++; }
      }
    }
    if (added > 0) this.version++;
    return added;
  }

  /**
   * Reveal around each walker, but only for walkers that moved since the last call (cheap enough to call every frame).
   * Returns the number of newly seen tiles.
   */
  revealFor(walkers: readonly { id: string; x: number; y: number }[], radius = SEEN_RADIUS): number {
    let added = 0;
    for (const p of walkers) {
      const at = `${p.x},${p.y}`;
      if (this.spots.get(p.id) === at) continue;
      this.spots.set(p.id, at);
      added += this.reveal(p.x, p.y, radius);
    }
    return added;
  }

  fraction(): number {
    let n = 0;
    for (const c of this.cells) n += c;
    return n / Math.max(1, this.cells.length);
  }
}

const registry = new Map<string, SeenGrid>();
const MAX_REMEMBERED = 24;

/** The grid for one map of one room, kept for the rest of the session so coming back shows what was explored. */
export function seenFor(roomId: string | null, mapId: string, seed: number, w: number, h: number): SeenGrid {
  const key = `${roomId ?? "-"}|${mapId}|${seed}`;
  let g = registry.get(key);
  if (!g || g.w !== w || g.h !== h) {
    g = new SeenGrid(w, h);
    registry.set(key, g);
    if (registry.size > MAX_REMEMBERED) registry.delete(registry.keys().next().value as string);
  }
  return g;
}

export function forgetSeen(): void { registry.clear(); }
