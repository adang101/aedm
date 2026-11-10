/**
 * Debug gallery for visual QA (?mock=1&gallery=1): every body plan in every pose, every part, every tile
 * pattern with its role treatments and every prop kind. Not used by the game.
 */
import {
  BODY_PLANS, PART_CATALOG, PART_GROUPS, PATTERNS, RAMP_NAMES, SPRITE_POSES, SPRITE_SIZES,
  type BodyPlan, type Part, type PartGroup, type SpritePalette, type SpritePose, type SpriteSpec, type TileDef,
} from "@aedm/schemas";
import { h } from "../util/dom";
import { RAMPS } from "./palette";
import { PROP_KINDS } from "./props";
import { POSE_SHADOW, composeSprite, effectivePose } from "./sprite-composer";
import { MapStyle } from "./tiles";

const PALS: SpritePalette[] = [
  { primary: RAMPS.skin[2], secondary: RAMPS.water[1], accent: RAMPS.sand[2], detail: RAMPS.earth[1] },
  { primary: RAMPS.grass[2], secondary: RAMPS.earth[2], accent: RAMPS.fire[2], detail: RAMPS.stone[1] },
  { primary: RAMPS.stone[3], secondary: RAMPS.magic[1], accent: RAMPS.fire[1], detail: RAMPS.stone[2] },
  { primary: RAMPS.magic[2], secondary: RAMPS.magic[1], accent: RAMPS.sand[3], detail: RAMPS.magic[0] },
];

const spec = (body: BodyPlan, parts: Part[], pal = PALS[0]!, size: SpriteSpec["size"] = "medium"): SpriteSpec => ({
  kind: "spec", v: 1, body, size, traits: "", palette: pal, parts: parts.map((part) => ({ part })),
});

function spriteCanvas(s: SpriteSpec, o: { facing?: "left" | "right"; frame?: number; pose?: SpritePose; w?: number; h?: number; k?: number } = {}): HTMLCanvasElement {
  const k = o.k ?? 2, w = o.w ?? 96, hh = o.h ?? 128;
  const c = h("canvas", { width: w, height: hh, style: `width:${w}px;height:${hh}px` });
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  const fx = w / 2, fy = hh - 6 * k;
  const pose = effectivePose(s, o.pose);
  g.fillStyle = "rgba(10,6,20,0.38)";
  g.beginPath(); g.ellipse(fx, fy - 2 * k, 17 * k * POSE_SHADOW[pose], 6 * k * POSE_SHADOW[pose], 0, 0, Math.PI * 2); g.fill();
  const comp = composeSprite(s, o.facing ?? "right", o.frame ?? 0, o.pose);
  g.drawImage(comp.canvas, fx - comp.footX * k, fy - comp.footY * k, comp.canvas.width * k, comp.canvas.height * k);
  return c;
}

const cell = (c: HTMLElement, label: string, wide = false) =>
  h("div", { class: `gallery-cell${wide ? " wide" : ""}` }, c, h("span", null, label));

function bodyPlanSection(): HTMLElement {
  const rows = BODY_PLANS.map((b, i) => {
    const s = spec(b, [], PALS[i % PALS.length]);
    return h("div", { class: "gallery-grid" },
      ...SPRITE_POSES.map((p) => cell(spriteCanvas(s, { pose: p }), `${b} ${p}`)),
      cell(spriteCanvas(s, { frame: 1 }), "frame 2"),
      cell(spriteCanvas(s, { facing: "left" }), "facing left"),
    );
  });
  return h("section", null, h("h2", null, "Body plans x poses"), ...rows);
}

function sizeSection(): HTMLElement {
  const row = (b: BodyPlan, parts: Part[]) => h("div", { class: "gallery-grid" },
    ...SPRITE_SIZES.map((z) => cell(spriteCanvas(spec(b, parts, PALS[1]!, z), { w: 150, h: 220 }), `${b} ${z}`, true)));
  return h("section", null, h("h2", null, "Sizes (tiny .6 / small .8 / medium 1 / large 1.3 / huge 1.6)"), row("humanoid", ["helmet", "sword"]), row("beast", ["tail", "ears_pointed"]));
}

function partsSection(): HTMLElement {
  const groups = (Object.keys(PART_GROUPS) as PartGroup[]).map((g) => h("div", null,
    h("h2", null, `Parts: ${g}`),
    h("div", { class: "gallery-grid" }, ...PART_GROUPS[g].map((part, i) => {
      const body: BodyPlan = "humanoid";
      return cell(spriteCanvas(spec(body, [part], PALS[i % PALS.length])), part);
    }))));
  return h("section", null, ...groups);
}

function partsOnBodies(): HTMLElement {
  const picks: [BodyPlan, Part[]][] = [
    ["beast", ["fur", "mane", "tail", "horns"]], ["avian", ["wings", "crown", "ears_pointed"]], ["serpent", ["fins", "spikes", "crown"]],
    ["insectoid", ["wings", "extra_eyes", "spikes"]], ["amorphous", ["drips", "crystals", "glowing_eyes"]], ["construct", ["gears", "armor", "helmet", "flames"]],
    ["spirit", ["hood", "aura", "sparkles"]], ["plant", ["leaves", "roots", "antlers"]], ["object", ["tentacles", "glowing_eyes", "smoke"]],
    ["humanoid", ["hat", "beard", "robe", "staff"]], ["humanoid", ["helmet", "armor", "shield", "sword"]], ["humanoid", ["hood", "cloak", "bow", "book"]],
    ["humanoid", ["horns", "wings", "tail", "axe"]], ["humanoid", ["crown", "robe", "orb", "halo"]], ["humanoid", ["mask", "cloak", "lantern", "smoke"]],
  ];
  return h("section", null, h("h2", null, "Parts on other body plans"),
    h("div", { class: "gallery-grid" }, ...picks.map(([b, p], i) => cell(spriteCanvas(spec(b, p, PALS[i % PALS.length])), `${b}: ${p.join(" ")}`))));
}

// ---------- tiles ----------

const ROLES = ["floor", "path", "wall", "liquid", "hazard", "obstacle", "decor", "door"] as const;
const CELL = 72;

interface Row { style: MapStyle; gids: Record<string, number>; label: string }

function patternRows(): Row[] {
  return PATTERNS.map((pattern, r) => {
    const ramp = RAMPS[RAMP_NAMES[(r + 1) % RAMP_NAMES.length]!];
    const defs: TileDef[] = ROLES.map((role, i) => ({
      gid: i + 1, material_id: `${pattern}_${role}`, role, color: ramp[role === "wall" || role === "hazard" ? 1 : 2], accent: ramp[role === "wall" ? 3 : 0],
      pattern, walkable: role !== "wall" && role !== "liquid" && role !== "obstacle", blocks_sight: role === "wall", variant: r % 4,
      layer: role === "wall" ? "walls" : "ground",
    }));
    const gids = Object.fromEntries(defs.map((d) => [d.role, d.gid]));
    return { style: new MapStyle(defs, new Map([[gids.floor!, 99]])), gids, label: pattern };
  });
}

function drawRow(g: CanvasRenderingContext2D, row: Row, x: number, y: number, time: number): void {
  const T = 48, st = row.style;
  ROLES.forEach((role, i) => {
    const px = x + i * T, gid = row.gids[role]!;
    if (role === "floor" || role === "path" || role === "liquid" || role === "hazard" || role === "door") st.drawFull(g, gid, px, y, time);
    else if (role === "wall") {
      st.drawFull(g, st.underlay, px, y + T, time);
      st.drawWall(g, gid, px, y, true, true, true, true);
    } else {
      st.drawFull(g, st.underlay, px, y, time);
      st.drawProp(g, gid, px, y, time);
    }
  });
}

function tilesSection(): HTMLElement {
  const rows = patternRows();
  const T = 48, per = 10, gap = 24;
  const colW = ROLES.length * T + 84;
  const canvas = h("canvas", { width: colW * 2 + gap, height: per * (T + 30) + 30 });
  canvas.style.width = `${canvas.width}px`;
  canvas.style.maxWidth = "none";
  const g = canvas.getContext("2d")!;
  const head = h("p", { class: "muted" }, `columns: ${ROLES.join(", ")} (wall drawn over a floor to show the 3/4 front face)`);
  const loop = (t: number) => {
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#1b1626"; g.fillRect(0, 0, canvas.width, canvas.height);
    rows.forEach((row, i) => {
      const col = Math.floor(i / per), rr = i % per;
      const x = col * (colW + gap) + 80, y = 26 + rr * (T + 30);
      drawRow(g, row, x, y, t);
      g.fillStyle = "#f6e8a0"; g.font = "bold 12px ui-sans-serif, system-ui, sans-serif"; g.textBaseline = "middle";
      g.fillText(row.label, col * (colW + gap) + 4, y + 20);
    });
    if (canvas.isConnected || t < 1000) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  void CELL;
  return h("section", null, h("h2", null, `Tile patterns x roles (${PATTERNS.length} patterns)`), head, canvas);
}

function propsSection(): HTMLElement {
  const defs: TileDef[] = [
    { gid: 1, material_id: "meadow", role: "floor", color: RAMPS.grass[1], accent: RAMPS.sand[2], pattern: "grass", walkable: true, blocks_sight: false, variant: 0, layer: "ground" },
  ];
  const kinds = [...PROP_KINDS];
  kinds.forEach((k, i) => {
    const ramp = RAMPS[RAMP_NAMES[(i + 2) % RAMP_NAMES.length]!];
    defs.push({
      gid: i + 2, material_id: k === "block" ? "plain_block" : k, role: ["tree", "pine", "rock", "crystal", "pillar", "spire", "bush", "stump"].includes(k) ? "obstacle" : "decor",
      color: ramp[1], accent: ramp[3], pattern: "none", walkable: false, blocks_sight: false, variant: 0, layer: "decor",
    });
  });
  const motifs = ["lava_pool", "spike_trap", "acid_bog", "ice_shards", "arcane_glyph", "plain_hazard"];
  motifs.forEach((m, i) => defs.push({
    gid: 100 + i, material_id: m, role: "hazard", color: RAMPS[RAMP_NAMES[(i + 3) % RAMP_NAMES.length]!][1], accent: RAMPS[RAMP_NAMES[(i + 3) % RAMP_NAMES.length]!][3],
    pattern: i % 2 ? "cracks" : "glow", walkable: true, blocks_sight: false, variant: 0, layer: "ground",
  }));
  const st = new MapStyle(defs, new Map([[1, 9]]));
  const T = 48, perRow = 12;
  const rows = Math.ceil(kinds.length / perRow) + 1;
  const canvas = h("canvas", { width: perRow * (T + 8), height: rows * (T + 30) + 20 });
  const g = canvas.getContext("2d")!;
  const loop = (t: number) => {
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#1b1626"; g.fillRect(0, 0, canvas.width, canvas.height);
    kinds.forEach((k, i) => {
      const x = (i % perRow) * (T + 8) + 4, y = 24 + Math.floor(i / perRow) * (T + 30);
      st.drawFull(g, 1, x, y, t);
      st.drawProp(g, i + 2, x, y, t);
      g.fillStyle = "#f6e8a0"; g.font = "10px ui-sans-serif, system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "top";
      g.fillText(k, x + T / 2, y + T + 2);
    });
    const y0 = 24 + Math.ceil(kinds.length / perRow) * (T + 30);
    motifs.forEach((m, i) => {
      const x = i * (T + 8) + 4;
      st.drawFull(g, 100 + i, x, y0, t);
      g.fillStyle = "#f6e8a0"; g.font = "10px ui-sans-serif, system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "top";
      g.fillText(m, x + T / 2, y0 + T + 2);
    });
    if (canvas.isConnected || t < 1000) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return h("section", null, h("h2", null, "Props (by material id) and hazard motifs"), canvas);
}

export function mountGallery(root: HTMLElement): void {
  document.body.style.overflow = "auto";
  const page = h("div", { class: "gallery-page" },
    h("h1", null, "Renderer gallery"),
    h("p", { class: "muted" }, `${BODY_PLANS.length} body plans, ${PART_CATALOG.length} parts, ${PATTERNS.length} patterns.`),
    bodyPlanSection(), sizeSection(), partsSection(), partsOnBodies(), tilesSection(), propsSection());
  root.replaceChildren(page);
  (window as unknown as { __galleryReady: boolean }).__galleryReady = true;
}
