import { PALETTE, PALETTE_HEX, OUTLINE_HEX, RAMP_NAMES, type PixelSprite, type SpriteSize, type SpriteSpec } from "@aedm/schemas";
import { paintIndices } from "../render/pixel-sprite";
import { composeSprite } from "../render/sprite-composer";
import {
  ERASE, H, MAX_ZOOM, MIN_ZOOM, W, checkImage, clampZoom, colorId, commit, createEditor, fillMirrored, fromRgba, lineCells,
  paintCells, pick, rectCells, redo, toolForKey, undo, withMirror, type Cell, type EditorState, type Tool,
} from "../state/pixel-editor";
import { h, replaceChildren } from "../util/dom";

/** The composed front idle frame of a spec on a 48 x 64 canvas (feet on y = 60), at medium scale. */
export function rasterizeSpec(spec: SpriteSpec): { px: Uint8Array; canvas: HTMLCanvasElement } {
  const s = composeSprite({ ...spec, size: "medium" }, "right", 0);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("Canvas 2D is not available");
  g.imageSmoothingEnabled = false;
  g.drawImage(s.canvas, Math.round(24 - s.footX), Math.round(60 - s.footY));
  return { px: fromRgba(g.getImageData(0, 0, W, H).data), canvas: c };
}

export interface PixelEditorOptions {
  /** Starting image (master palette ids); blank for a new painting. */
  px: Uint8Array;
  size: SpriteSize;
  /** The spec being painted over: kept in the result, shown as onion skin. */
  base?: SpriteSpec | undefined;
  traits?: string | undefined;
  /** Receives the validated recipe. The editor closes itself afterwards. */
  onSave(sprite: PixelSprite): void;
  onCancel?(): void;
}

const TOOL_LABEL: Record<Tool, string> = { pencil: "Pencil (B)", eraser: "Eraser (E)", fill: "Fill (G)", eyedropper: "Eyedropper (I)", line: "Line (L)", rect: "Rectangle (R)" };
const TOOL_SHORT: Record<Tool, string> = { pencil: "Pencil", eraser: "Eraser", fill: "Fill", eyedropper: "Pick", line: "Line", rect: "Rect" };
const MAX_RECENT = 8;

export function openPixelEditor(o: PixelEditorOptions): { close(): void } {
  let st: EditorState = createEditor(o.px);
  const initial = o.px.slice();
  let tool: Tool = "pencil";
  let color = colorId(PALETTE.earth[2]);
  let mirror = false;
  let filled = true;
  let onion = !!o.base;
  let grid = true;
  let zoom = clampZoom(Math.min((window.innerHeight - 260) / H, (window.innerWidth - 32) / W));
  let recent: number[] = [];
  let draft: Uint8Array | null = null;

  const onionCanvas = o.base ? rasterizeSpec(o.base).canvas : null;

  // ----- main canvas -----
  const canvas = h("canvas", { class: "pe-canvas", "aria-label": "Sprite canvas, 48 by 64 pixels", tabindex: 0 });
  const g = canvas.getContext("2d")!;

  function render(): void {
    const px = draft ?? st.px;
    const z = zoom;
    canvas.width = W * z; canvas.height = H * z;
    canvas.style.width = `${W * z}px`; canvas.style.height = `${H * z}px`;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        g.fillStyle = (x + y) % 2 ? "#3a3152" : "#32294a";
        g.fillRect(x * z, y * z, z, z);
      }
    }
    if (onion && onionCanvas) {
      g.globalAlpha = 0.35; g.imageSmoothingEnabled = false;
      g.drawImage(onionCanvas, 0, 0, W * z, H * z);
      g.globalAlpha = 1;
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = PALETTE_HEX[px[y * W + x]! - 1];
        if (!c) continue;
        g.fillStyle = c;
        g.fillRect(x * z, y * z, z, z);
      }
    }
    if (grid && z >= 6) {
      g.strokeStyle = "rgba(255,255,255,0.07)"; g.lineWidth = 1;
      g.beginPath();
      for (let x = 1; x < W; x++) { g.moveTo(x * z + 0.5, 0); g.lineTo(x * z + 0.5, H * z); }
      for (let y = 1; y < H; y++) { g.moveTo(0, y * z + 0.5); g.lineTo(W * z, y * z + 0.5); }
      g.stroke();
    }
    // guides: 2 px margin box and the feet line under row 60
    g.setLineDash([4, 4]); g.lineWidth = 1;
    g.strokeStyle = "rgba(245,166,91,0.8)";
    g.strokeRect(2 * z + 0.5, 2 * z + 0.5, (W - 4) * z - 1, (H - 4) * z - 1);
    g.strokeStyle = "rgba(159,212,245,0.9)";
    g.beginPath(); g.moveTo(0, 61 * z + 0.5); g.lineTo(W * z, 61 * z + 0.5); g.stroke();
    g.setLineDash([]);
    if (mirror) {
      g.strokeStyle = "rgba(203,176,240,0.7)";
      g.beginPath(); g.moveTo((W / 2) * z + 0.5, 0); g.lineTo((W / 2) * z + 0.5, H * z); g.stroke();
    }
  }

  // ----- previews -----
  const mkPrev = (k: number) => h("canvas", { class: "pe-prev", width: W * k, height: H * k, style: `width:${W * k}px;height:${H * k}px` });
  const prev1 = mkPrev(1), prev2 = mkPrev(2), prevL = mkPrev(1);
  function drawPrev(cv: HTMLCanvasElement, k: number, flip: boolean): void {
    const c = cv.getContext("2d")!;
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, cv.width, cv.height);
    // a 48 x 48 floor tile under the feet (rows 16 to 63)
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) { c.fillStyle = (x + y) % 2 ? "#4f8a3c" : "#5a9644"; c.fillRect(x * 16 * k, (16 + y * 16) * k, 16 * k, 16 * k); }
    const img = paintIndices(draft ?? st.px, PALETTE_HEX);
    c.save();
    if (flip) { c.translate(cv.width, 0); c.scale(-1, 1); }
    c.drawImage(img, 0, 0, W * k, H * k);
    c.restore();
  }

  // ----- palette -----
  const paletteBox = h("div", { class: "pe-palette" });
  const recentBox = h("div", { class: "pe-recent" });
  const swatch = (id: number) => h("button", {
    type: "button", class: `swatch${id === color && tool !== "eraser" ? " on" : ""}`, "data-id": id, style: `background:${PALETTE_HEX[id - 1]}`,
    "aria-label": `Color ${PALETTE_HEX[id - 1]}`, title: PALETTE_HEX[id - 1],
    onClick: () => { setColor(id); },
  });
  function buildPalette(): void {
    replaceChildren(paletteBox, ...RAMP_NAMES.map((r) => h("div", { class: "pe-ramp" }, ...PALETTE[r].map((hex) => swatch(colorId(hex))))),
      h("div", { class: "pe-ramp" }, swatch(colorId(OUTLINE_HEX))));
    replaceChildren(recentBox, h("small", { class: "muted" }, "Recent"), ...recent.map(swatch));
  }
  function setColor(id: number): void {
    color = id;
    recent = [id, ...recent.filter((r) => r !== id)].slice(0, MAX_RECENT);
    if (tool === "eraser" || tool === "eyedropper") tool = "pencil";
    refreshUi();
  }

  // ----- tools / toggles / status -----
  const toolBox = h("div", { class: "pe-tools", role: "toolbar", "aria-label": "Tools" });
  const undoBtn = h("button", { type: "button", class: "btn small", onClick: () => { st = undo(st); refreshUi(); } }, "Undo");
  const redoBtn = h("button", { type: "button", class: "btn small", onClick: () => { st = redo(st); refreshUi(); } }, "Redo");
  const mirrorBtn = h("button", { type: "button", class: "chip toggle", "aria-pressed": "false", onClick: () => { mirror = !mirror; refreshUi(); } }, "Mirror (M)");
  const filledBtn = h("button", { type: "button", class: "chip toggle", onClick: () => { filled = !filled; refreshUi(); } }, "Filled rect");
  const onionBtn = h("button", { type: "button", class: "chip toggle", onClick: () => { onion = !onion; refreshUi(); } }, "Onion skin");
  const gridBtn = h("button", { type: "button", class: "chip toggle", onClick: () => { grid = !grid; refreshUi(); } }, "Grid");
  if (!onionCanvas) onionBtn.hidden = true;
  const zoomLabel = h("span", { class: "muted pe-zoom-label" });
  const zoomIn = h("button", { type: "button", class: "btn small", "aria-label": "Zoom in", onClick: () => { zoom = clampZoom(zoom + 1); refreshUi(); } }, "+");
  const zoomOut = h("button", { type: "button", class: "btn small", "aria-label": "Zoom out", onClick: () => { zoom = clampZoom(zoom - 1); refreshUi(); } }, "-");
  const colorsEl = h("div", { class: "pe-colors" });
  const checkEl = h("div", { class: "pe-check", role: "status", "aria-live": "polite" });
  const saveBtn = h("button", { type: "button", class: "btn primary", onClick: () => save() }, "Save sprite");
  const cancelBtn = h("button", { type: "button", class: "btn", onClick: () => cancel() }, "Cancel");

  function refreshUi(): void {
    for (const b of toolBox.querySelectorAll("button")) {
      const on = b.dataset.tool === tool;
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    }
    for (const [b, v] of [[mirrorBtn, mirror], [filledBtn, filled], [onionBtn, onion], [gridBtn, grid]] as const) {
      b.classList.toggle("on", v); b.setAttribute("aria-pressed", String(v));
    }
    undoBtn.disabled = st.past.length === 0;
    redoBtn.disabled = st.future.length === 0;
    zoomIn.disabled = zoom >= MAX_ZOOM; zoomOut.disabled = zoom <= MIN_ZOOM;
    zoomLabel.textContent = `${zoom}x`;
    buildPalette();
    refreshCheck();
    render();
    drawAllPrevs();
  }
  function drawAllPrevs(): void { drawPrev(prev1, 1, false); drawPrev(prev2, 2, false); drawPrev(prevL, 1, true); }
  function refreshCheck(): void {
    const c = checkImage(draft ?? st.px, { size: o.size, base: o.base, traits: o.traits });
    colorsEl.textContent = `Colors: ${c.colors} of 32`;
    colorsEl.classList.toggle("over", c.colors > 32);
    const items: HTMLElement[] = c.issues.map((i) => h("li", { class: "bad", "data-code": i.code }, i.message));
    if (c.ok && c.shifted !== 0) items.push(h("li", { class: "note" }, `The feet will be moved ${Math.abs(c.shifted)} row${Math.abs(c.shifted) === 1 ? "" : "s"} ${c.shifted > 0 ? "down" : "up"} on save.`));
    checkEl.className = `pe-check ${c.ok ? "ok" : "bad"}`;
    replaceChildren(checkEl, h("b", null, c.ok ? "Check: looks good" : "Check: fix these before saving"), h("ul", null, ...items));
    saveBtn.disabled = !c.ok;
  }

  for (const t of ["pencil", "eraser", "fill", "eyedropper", "line", "rect"] as const) {
    toolBox.appendChild(h("button", {
      type: "button", class: "btn small tool", "data-tool": t, title: TOOL_LABEL[t], "aria-label": TOOL_LABEL[t],
      onClick: () => { tool = t; refreshUi(); },
    }, TOOL_SHORT[t]));
  }

  // ----- pointer input (mouse, touch, pen) -----
  let drawing = false;
  let start: Cell = [0, 0];
  let last: Cell = [0, 0];
  const cellOf = (e: PointerEvent): Cell => {
    const r = canvas.getBoundingClientRect();
    return [Math.floor(((e.clientX - r.left) / r.width) * W), Math.floor(((e.clientY - r.top) / r.height) * H)];
  };
  const clampCell = (c: Cell): Cell => [Math.max(0, Math.min(W - 1, c[0])), Math.max(0, Math.min(H - 1, c[1]))];

  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    const c = clampCell(cellOf(e));
    canvas.focus({ preventScroll: true });
    if (tool === "eyedropper") {
      const id = pick(st.px, c[0], c[1]);
      if (id) { color = id; recent = [id, ...recent.filter((r) => r !== id)].slice(0, MAX_RECENT); tool = "pencil"; refreshUi(); }
      return;
    }
    if (tool === "fill") {
      st = commit(st, fillMirrored(st.px, c[0], c[1], color, mirror));
      refreshUi();
      return;
    }
    drawing = true; start = c; last = c;
    canvas.setPointerCapture(e.pointerId);
    const id = tool === "eraser" ? ERASE : color;
    draft = paintCells(st.px, withMirror([c], mirror), id);
    update();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    e.preventDefault();
    const c = clampCell(cellOf(e));
    const id = tool === "eraser" ? ERASE : color;
    if (tool === "pencil" || tool === "eraser") {
      if (c[0] === last[0] && c[1] === last[1]) return;
      draft = paintCells(draft ?? st.px, withMirror(lineCells(last[0], last[1], c[0], c[1]), mirror), id);
      last = c;
    } else if (tool === "line") {
      draft = paintCells(st.px, withMirror(lineCells(start[0], start[1], c[0], c[1]), mirror), id);
    } else if (tool === "rect") {
      draft = paintCells(st.px, withMirror(rectCells(start[0], start[1], c[0], c[1], filled), mirror), id);
    }
    update();
  });
  const endStroke = (e: PointerEvent): void => {
    if (!drawing) return;
    drawing = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (draft) st = commit(st, draft);
    draft = null;
    refreshUi();
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", (e) => { drawing = false; draft = null; void e; refreshUi(); });
  function update(): void { render(); drawAllPrevs(); refreshCheck(); }

  // ----- keyboard -----
  const onKey = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); st = e.shiftKey ? redo(st) : undo(st); refreshUi(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); st = redo(st); refreshUi(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const nt = toolForKey(k);
    if (nt) { tool = nt; refreshUi(); return; }
    if (k === "m") { mirror = !mirror; refreshUi(); return; }
    if (k === "+" || k === "=") { zoom = clampZoom(zoom + 1); refreshUi(); return; }
    if (k === "-") { zoom = clampZoom(zoom - 1); refreshUi(); return; }
    if (k === "escape" && !dirty()) cancel();
  };
  document.addEventListener("keydown", onKey);

  const dirty = (): boolean => st.px.some((v, i) => v !== initial[i]);

  function close(): void {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  }
  function cancel(): void {
    if (dirty() && !window.confirm("Discard your painting?")) return;
    close();
    o.onCancel?.();
  }
  function save(): void {
    const c = checkImage(st.px, { size: o.size, base: o.base, traits: o.traits });
    if (!c.ok || !c.sprite) { refreshCheck(); return; }
    close();
    o.onSave(c.sprite);
  }

  const overlay = h("div", { class: "pe-overlay", role: "dialog", "aria-modal": "true", "aria-label": "Pixel editor" },
    h("div", { class: "pe" },
      h("div", { class: "pe-head row between wrap" },
        h("h2", null, o.base ? "Paint over" : "Paint from scratch"),
        h("div", { class: "row" }, cancelBtn, saveBtn)),
      h("div", { class: "pe-body" },
        h("div", { class: "pe-stage" }, canvas),
        h("div", { class: "pe-side stack tight" },
          toolBox,
          h("div", { class: "row wrap" }, undoBtn, redoBtn, zoomOut, zoomLabel, zoomIn),
          h("div", { class: "chip-row wrap" }, mirrorBtn, filledBtn, onionBtn, gridBtn),
          colorsEl,
          paletteBox, recentBox,
          checkEl,
          h("div", { class: "pe-previews" },
            h("figure", null, prev1, h("figcaption", null, "1x")),
            h("figure", null, prev2, h("figcaption", null, "2x")),
            h("figure", null, prevL, h("figcaption", null, "Facing left"))),
          h("p", { class: "muted pe-help" }, "Dashed orange: keep the art inside. Blue line: feet. Shortcuts: B E G I L R, M mirror, Ctrl+Z / Ctrl+Y."),
        ))));
  document.body.appendChild(overlay);
  refreshUi();
  canvas.focus({ preventScroll: true });
  return { close };
}
