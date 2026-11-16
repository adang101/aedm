import type { MapObject } from "@aedm/schemas";
import { TILE } from "./camera";
import { cheb, type Pt } from "../util/interact";
import type { Ctx } from "./px";

export interface PoiLabel {
  id: string;
  x: number;
  y: number;
  text: string;
  tone: "exit" | "thing";
}

const KIND_LABEL: Record<string, string> = {
  chest: "Chest", door: "Door", lever: "Lever", sign: "Sign", altar: "Altar", trap: "Trap",
};

/** "stairs_up" -> "Stairs up". Exit names are written by the map's author, so they only ever go through canvas text. */
export function prettyName(name: string): string {
  const s = name.replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** What to call a point of interest, from data the client holds. Hidden objects are never sent, and are skipped here too. */
export function poiLabel(o: MapObject): PoiLabel | null {
  if (o.type === "exit") return { id: `exit:${o.name}:${o.x},${o.y}`, x: o.x, y: o.y, text: `Exit: ${prettyName(o.name)}`, tone: "exit" };
  if (o.type !== "interactable" || o.hidden) return null;
  const base = KIND_LABEL[o.kind] ?? prettyName(o.kind);
  const text = o.state === "locked" ? `${base} (locked)` : (o.kind === "door" || o.kind === "chest") && o.state === "open" ? `${base} (open)` : base;
  return { id: o.id, x: o.x, y: o.y, text, tone: "thing" };
}

/** Labels worth drawing now: the one under the pointer, and anything within `near` tiles of a party member. */
export function labelsToShow(objects: readonly MapObject[], hover: Pt | null, party: readonly Pt[], near = 3): PoiLabel[] {
  const out: PoiLabel[] = [];
  for (const o of objects) {
    const l = poiLabel(o);
    if (!l) continue;
    const hovered = !!hover && hover.x === l.x && hover.y === l.y;
    if (hovered || party.some((p) => cheb(p, l) <= near)) out.push(l);
  }
  return out;
}

/** Same look as a creature's name (bold 10px, dark halo), centred under the tile. */
export function drawPoiLabel(ctx: Ctx, l: PoiLabel): void {
  ctx.save();
  ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.lineWidth = 3; ctx.strokeStyle = "rgba(20,12,30,0.9)"; ctx.lineJoin = "round";
  const x = l.x * TILE + TILE / 2, y = l.y * TILE + TILE - 4;
  ctx.strokeText(l.text, x, y);
  ctx.fillStyle = l.tone === "exit" ? "#e8c95a" : "#cbe3f5";
  ctx.fillText(l.text, x, y);
  ctx.restore();
}
