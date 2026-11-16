import "./minimap.css";
import type { Camera } from "../render/camera";
import {
  DOT_STYLE, collectMarkers, creatureDots, fitMinimap, minimapToCameraCenter, minimapToTile, rasterizeMap, viewRect,
  type Dot, type DotShape, type Marker, type MarkerKind,
} from "../state/minimap";
import { placeName } from "../state/arrival";
import { seenFor, type SeenGrid } from "../state/seen";
import { storageGet, storageSet } from "../state/storage";
import { myEntity, type AppState } from "../state/store";
import { h } from "../util/dom";

const COLLAPSED_KEY = "aedm.minimap.collapsed";
const DOUBLE_TAP_MS = 380;

export interface MinimapHooks {
  getView(): { cam: Camera; viewW: number; viewH: number };
  lookAt(cx: number, cy: number): void;
  recenter(): void;
  walkTo(x: number, y: number): void;
}

export interface Minimap {
  el: HTMLElement;
  update(s: AppState): void;
  /** Call once per drawn frame. Repaints only when something the minimap shows has changed. */
  tick(): void;
  /** Keep clear of the combat bar along the top of the map. */
  setTopInset(px: number): void;
  destroy(): void;
}

const isNarrow = (): boolean => typeof matchMedia === "function" && matchMedia("(max-width: 760px)").matches;

function initialCollapsed(): boolean {
  const saved = storageGet(COLLAPSED_KEY);
  if (saved === "1") return true;
  if (saved === "0") return false;
  return isNarrow();
}

const MARKER_COLOR: Record<MarkerKind, string> = {
  exit: "#f0c94a", chest: "#e8b33a", door: "#c8934d", lever: "#9fd4f5", sign: "#f2efe4", altar: "#c79bff", trap: "#ff6b5a", pile: "#d9b98a",
};
const MARKER_NAME: Record<MarkerKind, string> = {
  exit: "Exit", chest: "Chest", door: "Door", lever: "Lever", sign: "Sign", altar: "Altar", trap: "Trap", pile: "Loot",
};
const OUT = "rgba(14,9,22,0.95)";

export function createMinimap(hooks: MinimapHooks): Minimap {
  let collapsed = initialCollapsed();
  let expanded = false;
  let state: AppState | null = null;
  let mapId = "";
  let seen: SeenGrid | null = null;
  let seenVersion = -1;
  let markers: Marker[] = [];
  let dots: Dot[] = [];
  let base: HTMLCanvasElement | null = null;
  let sig = "";
  let boxSig = "";
  let size = fitMinimap(20, 20, 100, 100);
  let lastTap = { t: 0, x: 0, y: 0 };
  let dragging = false;

  const name = h("span", { class: "mm-name" });
  const chevron = h("span", { class: "mm-chevron", "aria-hidden": "true" });
  const titleBtn = h("button", { type: "button", class: "mm-title", "aria-expanded": "true" }, name, chevron);
  const centreBtn = h("button", { type: "button", class: "mm-btn", title: "Centre the view on your character", "aria-label": "Centre on me" }, "⌖");
  const bigBtn = h("button", { type: "button", class: "mm-btn", title: "Show the whole map", "aria-label": "Show the whole map", "aria-pressed": "false" }, "⤢");
  const head = h("div", { class: "mm-head" }, titleBtn, centreBtn, bigBtn);
  const canvas = h("canvas", { class: "mm-canvas", role: "img", "aria-label": "Map overview. Click to look there, double-click to walk there." });
  const note = h("div", { class: "mm-note" });
  const legend = h("ul", { class: "mm-legend" });
  const body = h("div", { class: "mm-body" }, canvas, note, legend);
  const el = h("section", { class: "minimap", "aria-label": "Map overview", hidden: true }, head, body);

  const shapeItems: DotShape[] = ["me", "ally", "friendly", "neutral", "wary", "hostile"];
  for (const sh of shapeItems) legend.append(h("li", null, h("i", { class: `lg lg-${sh}`, "aria-hidden": "true" }), DOT_STYLE[sh].label));
  for (const k of ["exit", "chest", "door", "lever", "sign", "altar", "trap", "pile"] as MarkerKind[]) {
    legend.append(h("li", null, h("i", { class: `lg lg-m-${k}`, "aria-hidden": "true" }), MARKER_NAME[k]));
  }
  legend.append(h("li", { class: "lg-wide" }, "Dimmed ground: not visited yet"));

  function applyMode(): void {
    el.classList.toggle("collapsed", collapsed);
    el.classList.toggle("expanded", expanded && !collapsed);
    body.hidden = collapsed;
    centreBtn.hidden = collapsed;
    bigBtn.hidden = collapsed;
    titleBtn.setAttribute("aria-expanded", String(!collapsed));
    chevron.textContent = collapsed ? "+" : "-";
    titleBtn.title = collapsed ? "Show the map overview" : "Hide the map overview";
    bigBtn.setAttribute("aria-pressed", String(expanded));
    bigBtn.title = expanded ? "Back to the small map" : "Show the whole map";
    sig = "";
  }

  titleBtn.addEventListener("click", () => {
    collapsed = !collapsed;
    if (collapsed) expanded = false;
    storageSet(COLLAPSED_KEY, collapsed ? "1" : "0");
    applyMode();
  });
  bigBtn.addEventListener("click", () => { expanded = !expanded; applyMode(); });
  centreBtn.addEventListener("click", () => hooks.recenter());
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && expanded) { expanded = false; applyMode(); }
  };
  document.addEventListener("keydown", onKey);

  // ---------- pointer: look there; a quick second tap walks there ----------
  function local(ev: PointerEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function look(ev: PointerEvent): void {
    const m = state?.map;
    if (!m) return;
    const p = local(ev);
    const c = minimapToCameraCenter(p.x, p.y, size.k, m.width, m.height);
    hooks.lookAt(c.cx, c.cy);
  }
  canvas.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    canvas.setPointerCapture?.(ev.pointerId);
    dragging = true;
    look(ev);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (dragging) look(ev);
    else hover(ev);
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (!dragging) return;
    dragging = false;
    const m = state?.map;
    if (!m) return;
    const p = local(ev);
    const now = performance.now();
    if (now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < size.k * 2.5) {
      const t = minimapToTile(p.x, p.y, size.k, m.width, m.height);
      hooks.walkTo(t.x, t.y);
      lastTap = { t: 0, x: 0, y: 0 };
    } else lastTap = { t: now, x: p.x, y: p.y };
  });
  canvas.addEventListener("pointercancel", () => { dragging = false; });

  /** Name what is under the pointer (a hint on the big map; the names come from data the client holds). */
  function hover(ev: PointerEvent): void {
    const m = state?.map;
    if (!m || ev.pointerType !== "mouse") return;
    const p = local(ev);
    const t = minimapToTile(p.x, p.y, size.k, m.width, m.height);
    const d = dots.find((x) => Math.abs(x.x - t.x) <= 1 && Math.abs(x.y - t.y) <= 1);
    const mk = markers.find((x) => x.x === t.x && x.y === t.y);
    const tip = d ? `${d.label} (${DOT_STYLE[d.shape].label.toLowerCase()})` : mk ? MARKER_NAME[mk.kind] : "";
    if (canvas.title !== tip) canvas.title = tip;
  }

  // ---------- data ----------
  function rebuildBase(): void {
    const m = state?.map;
    if (!m) return;
    if (!base) base = document.createElement("canvas");
    base.width = m.width; base.height = m.height;
    const ctx = base.getContext("2d");
    if (!ctx) return;
    const px = rasterizeMap(m, seen);
    ctx.putImageData(new ImageData(px as unknown as Uint8ClampedArray<ArrayBuffer>, m.width, m.height), 0, 0);
    seenVersion = seen?.version ?? 0;
  }

  function update(s: AppState): void {
    state = s;
    const m = s.map;
    el.hidden = !m;
    if (!m) { mapId = ""; return; }
    name.textContent = placeName(m);
    titleBtn.setAttribute("aria-label", `${placeName(m)}. ${collapsed ? "Show" : "Hide"} the map overview`);
    if (m.id !== mapId) {
      mapId = m.id;
      seen = seenFor(s.roomId, m.id, m.meta.seed, m.width, m.height);
      expanded = false;
      applyMode();
      rebuildBase();
    }
    const objs = m.layers.find((l) => l.type === "objectgroup");
    markers = collectMarkers(m, objs && objs.type === "objectgroup" ? objs.objects : [], Object.values(s.containers));
    dots = creatureDots(s.entities, myEntity(s)?.id ?? null);
    boxSig = "";
  }

  let topInset = 0;
  function boxFor(): { w: number; h: number } {
    const parent = el.parentElement;
    const pw = parent?.clientWidth ?? 600, ph = parent?.clientHeight ?? 400;
    if (expanded) {
      const chrome = head.offsetHeight + note.offsetHeight + legend.offsetHeight + 40;
      return { w: Math.max(120, pw - 40), h: Math.max(120, ph - topInset - chrome) };
    }
    return isNarrow() ? { w: 120, h: 96 } : { w: 176, h: 150 };
  }

  function draw(): void {
    const m = state?.map;
    const ctx = canvas.getContext("2d");
    if (!m || !ctx || !base) return;
    const box = boxFor();
    size = fitMinimap(m.width, m.height, box.w, box.h, 2, expanded ? 20 : 8);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = size.width, H = size.height, k = size.k;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(base, 0, 0, W, H);

    const u = Math.max(3, Math.min(9, k * 0.9));
    for (const mk of markers) drawMarker(ctx, mk, k, u, m.width, m.height);
    const r = Math.max(2.2, Math.min(6.5, k * 0.55));
    for (const d of dots) drawDot(ctx, d, (d.x + 0.5) * k, (d.y + 0.5) * k, r);

    const { cam, viewW, viewH } = hooks.getView();
    const v = viewRect(cam, viewW, viewH, m.width, m.height);
    ctx.lineWidth = 3; ctx.strokeStyle = OUT;
    ctx.strokeRect(v.x0 * k, v.y0 * k, (v.x1 - v.x0) * k, (v.y1 - v.y0) * k);
    ctx.lineWidth = 1.5; ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(v.x0 * k, v.y0 * k, (v.x1 - v.x0) * k, (v.y1 - v.y0) * k);

    if (seen) note.textContent = `${Math.round(seen.fraction() * 100)}% of the ground visited`;
  }

  function tick(): void {
    const s = state;
    const m = s?.map;
    if (!s || !m || el.hidden) return;
    if (seen) {
      const pcs = Object.values(s.entities).filter((e) => e.kind === "pc" && e.hp > 0);
      seen.revealFor(pcs);
      if (seen.version !== seenVersion) rebuildBase();
    }
    if (collapsed) return;
    const { cam, viewW, viewH } = hooks.getView();
    const v = viewRect(cam, viewW, viewH, m.width, m.height);
    const bits = [m.id, expanded ? 1 : 0, seenVersion, Math.round(v.x0 * 4), Math.round(v.y0 * 4), Math.round(v.x1 * 4), Math.round(v.y1 * 4),
      boxSig, el.parentElement?.clientWidth ?? 0, el.parentElement?.clientHeight ?? 0, topInset];
    for (const d of dots) bits.push(d.x, d.y, d.shape);
    bits.push(markers.length);
    for (const mk of markers) bits.push(mk.x, mk.y, mk.kind);
    const next = bits.join(",");
    if (next === sig) return;
    sig = next;
    draw();
  }

  applyMode();
  return {
    el, update, tick,
    setTopInset(px) {
      if (px === topInset) return;
      topInset = px;
      el.style.top = `${px + 8}px`;
    },
    destroy() { document.removeEventListener("keydown", onKey); },
  };
}

// ---------- drawing ----------

function drawMarker(ctx: CanvasRenderingContext2D, mk: Marker, k: number, u: number, mapW: number, mapH: number): void {
  const cx = (mk.x + 0.5) * k, cy = (mk.y + 0.5) * k;
  const c = MARKER_COLOR[mk.kind];
  ctx.lineWidth = 1; ctx.strokeStyle = OUT; ctx.fillStyle = c;
  const half = u / 2;
  switch (mk.kind) {
    case "exit": {
      // a bright tick along the edge the exit is on, and an arrow pointing out of the map
      const side = mk.side ?? "n";
      const dx = side === "e" ? 1 : side === "w" ? -1 : 0, dy = side === "s" ? 1 : side === "n" ? -1 : 0;
      const ax = side === "e" ? mapW * k : side === "w" ? 0 : cx, ay = side === "s" ? mapH * k : side === "n" ? 0 : cy;
      ctx.beginPath();
      ctx.moveTo(ax + dx * 1, ay + dy * 1);
      ctx.lineTo(ax - dx * u - dy * half * 1.2, ay - dy * u - dx * half * 1.2);
      ctx.lineTo(ax - dx * u + dy * half * 1.2, ay - dy * u + dx * half * 1.2);
      ctx.closePath();
      ctx.lineWidth = 1.2; ctx.fill(); ctx.stroke();
      return;
    }
    case "door": ctx.fillRect(cx - half * 0.55, cy - half, half * 1.1, u); ctx.strokeRect(cx - half * 0.55, cy - half, half * 1.1, u); return;
    case "lever": ctx.beginPath(); ctx.arc(cx, cy, half * 0.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); return;
    case "sign": case "altar":
      ctx.beginPath(); ctx.moveTo(cx, cy - half * 1.1); ctx.lineTo(cx + half * 1.1, cy); ctx.lineTo(cx, cy + half * 1.1); ctx.lineTo(cx - half * 1.1, cy); ctx.closePath();
      ctx.fill(); ctx.stroke(); return;
    case "trap":
      ctx.lineWidth = 2.5; ctx.strokeStyle = OUT;
      ctx.beginPath(); ctx.moveTo(cx - half, cy - half); ctx.lineTo(cx + half, cy + half); ctx.moveTo(cx + half, cy - half); ctx.lineTo(cx - half, cy + half); ctx.stroke();
      ctx.lineWidth = 1.3; ctx.strokeStyle = c; ctx.stroke(); return;
    case "pile": ctx.beginPath(); ctx.arc(cx, cy, half * 0.7, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); return;
    case "chest": ctx.fillRect(cx - half, cy - half * 0.75, u, u * 0.75); ctx.strokeRect(cx - half, cy - half * 0.75, u, u * 0.75); return;
  }
}

function drawDot(ctx: CanvasRenderingContext2D, d: Dot, x: number, y: number, r: number): void {
  ctx.lineWidth = 1.2; ctx.strokeStyle = OUT; ctx.fillStyle = d.color;
  ctx.beginPath();
  switch (d.shape) {
    case "me":
      ctx.arc(x, y, r + 1.6, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, Math.PI * 2); ctx.fillStyle = d.color; ctx.fill(); return;
    case "ally": case "friendly": ctx.arc(x, y, r, 0, Math.PI * 2); break;
    case "hostile": ctx.moveTo(x, y - r - 0.8); ctx.lineTo(x + r + 0.8, y + r * 0.8); ctx.lineTo(x - r - 0.8, y + r * 0.8); ctx.closePath(); break;
    case "wary": ctx.moveTo(x, y - r - 0.8); ctx.lineTo(x + r + 0.8, y); ctx.lineTo(x, y + r + 0.8); ctx.lineTo(x - r - 0.8, y); ctx.closePath(); break;
    case "neutral": ctx.rect(x - r, y - r, r * 2, r * 2); break;
  }
  ctx.fill(); ctx.stroke();
  if (d.shape === "friendly") { ctx.beginPath(); ctx.arc(x, y, r * 0.35, 0, Math.PI * 2); ctx.fillStyle = "#0f2a19"; ctx.fill(); }
}
