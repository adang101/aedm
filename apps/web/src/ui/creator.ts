import { ABILITIES, BODY_PLANS, CHECK_TAGS, PART_GROUPS, SPRITE_PROMPT_MAX, spriteSwatch, type CheckTag, type PartGroup, type PixelSprite, type SpriteRecipe, type SpriteShape, type SpriteSpec } from "@aedm/schemas";
import { drawShapeBody } from "../render/shape-recipe";
import { composePixelSprite, composeRecipe } from "../render/pixel-sprite";
import { MARGIN, composeSprite } from "../render/sprite-composer";
import {
  MAX_ABILITIES, MAX_TRAITS, buildCreate, emptyForm, premadeForms, toggleTrait,
  type CreatorForm, type FormErrors,
} from "../state/creator";
import {
  BODY_LABEL, BUILDER_SIZES, GROUP_LABEL, MAX_BUILDER_PARTS, PALETTE_SLOTS, SLOT_LABEL, SWATCHES,
  buildSpriteSpec, designedForm, randomLook, togglePart, type PaletteSlot,
} from "../state/sprite-builder";
import {
  POINT_BUY_BUDGET, adjust, canDecrease, canIncrease, nextCost, pointsLeft, scoreCost,
} from "../state/pointbuy";
import type { AppState } from "../state/store";
import { h, replaceChildren } from "../util/dom";
import { fromRecipe, blank } from "../state/pixel-editor";
import type { Ctx } from "./types";
import { openPixelEditor, rasterizeSpec } from "./pixel-editor";
import { openWorkshop, saveToWorkshop } from "./workshop";

const ABILITY_NAMES: Record<string, string> = {
  str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma",
};

export function shapeIcon(shape: SpriteShape, color: string, accent: string, glyph: string, size = 40): HTMLCanvasElement {
  const c = h("canvas", { width: size * 2, height: size * 2, style: `width:${size}px;height:${size}px` });
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.scale(size / 24, size / 24);
    drawShapeBody(ctx, { kind: "shape", shape, color, accent, glyph }, 24, 24, 17);
  }
  return c;
}

/** A composed `spec` sprite at a small size (48 x 64 crop, scaled to fit a `size` square). */
export function specIcon(spec: SpriteSpec, size = 40): HTMLCanvasElement {
  const c = h("canvas", { width: size * 2, height: size * 2, style: `width:${size}px;height:${size}px` });
  const g = c.getContext("2d");
  if (g) {
    const s = composeSprite(spec, "right", 0);
    const k = (size * 2) / 64;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "medium";
    const sx = s.footX - 24 * s.scale - 4 * s.scale, sy = s.footY - 60 * s.scale - 2 * s.scale;
    g.drawImage(s.canvas, sx, sy, 56 * s.scale, 66 * s.scale, (size * 2 - 56 * k * 0.97) / 2, 0, 56 * k * 0.97, 66 * k * 0.97);
  }
  return c;
}

/** A painted sprite at a small size; falls back to its base spec, then to a shape, if it cannot be drawn. */
export function pixelIcon(recipe: PixelSprite, name: string, size = 40): HTMLCanvasElement {
  const comp = composePixelSprite(recipe, "right", 0);
  if (!comp) return recipe.base ? specIcon(recipe.base, size) : shapeIcon("circle", ...swatchArgs(recipe, name), size);
  const c = h("canvas", { width: size * 2, height: size * 2, style: `width:${size}px;height:${size}px` });
  const g = c.getContext("2d");
  if (g) {
    const k = (size * 2) / 64;
    g.imageSmoothingEnabled = false;
    g.drawImage(comp.canvas, MARGIN, MARGIN, 48, 64, (size * 2 - 48 * k) / 2, 0, 48 * k, 64 * k);
  }
  return c;
}

function swatchArgs(r: SpriteRecipe, name: string): [string, string, string] {
  const w = spriteSwatch(r, name);
  return [w.color, w.accent, w.glyph];
}

export function recipeIcon(recipe: SpriteRecipe, name: string, size = 40): HTMLCanvasElement {
  if (recipe.kind === "spec") return specIcon(recipe, size);
  if (recipe.kind === "pixel") return pixelIcon(recipe, name, size);
  return shapeIcon(recipe.shape, recipe.color, recipe.accent, recipe.glyph, size);
}

export interface Creator {
  el: HTMLElement;
  /** Fill the form from a previously claimed character name (no-op placeholder to keep API small). */
  focusName(): void;
  /** Refresh the account-only parts (saved characters, save checkbox). */
  update(s: AppState): void;
}

export function createCreator(ctx: Ctx, onClaimed?: () => void): Creator {
  let form: CreatorForm = emptyForm();
  let errors: FormErrors = {};

  // ----- static inputs -----
  const nameIn = h("input", { type: "text", maxlength: 30, placeholder: "e.g. Brindle Ash", autocomplete: "off" });
  const titleIn = h("input", { type: "text", maxlength: 40, placeholder: "e.g. demolitions expert", autocomplete: "off" });
  const descIn = h("textarea", { rows: 2, maxlength: 300, placeholder: "Looks, manner, a hint of history. Used for flavor and the portrait." });
  const keySel = h("select", null, ...ABILITIES.map((a) => h("option", { value: a }, `${ABILITY_NAMES[a]} (${a.toUpperCase()})`)));

  const errBox = (key: keyof FormErrors) => h("p", { class: "field-error", "data-error": key, role: "alert" });
  const errEls: Record<string, HTMLElement> = {};
  for (const k of ["name", "title", "description", "scores", "traits", "abilities", "glyph", "sprite", "key_ability"] as const) errEls[k] = errBox(k);

  nameIn.addEventListener("input", () => {
    form.name = nameIn.value;
    refreshPreview();
  });
  titleIn.addEventListener("input", () => { form.title = titleIn.value; });
  descIn.addEventListener("input", () => { form.description = descIn.value; });
  keySel.addEventListener("change", () => { form.key_ability = keySel.value as CreatorForm["key_ability"]; });

  // ----- point buy -----
  const counter = h("div", { class: "points" });
  const scoreRows = h("div", { class: "score-grid" });
  function refreshScores(): void {
    const left = pointsLeft(form.scores);
    counter.className = `points ${left === 0 ? "done" : left < 0 ? "over" : ""}`;
    replaceChildren(counter,
      h("span", { class: "points-num" }, left), h("span", null, ` of ${POINT_BUY_BUDGET} points left`),
      h("button", { type: "button", class: "btn tiny ghost", onClick: () => { form.scores = emptyForm().scores; refreshScores(); } }, "Reset"));
    replaceChildren(scoreRows, ...ABILITIES.map((k) => {
      const v = form.scores[k];
      const inc = nextCost(v);
      return h("div", { class: `score-row${form.key_ability === k ? " key" : ""}` },
        h("span", { class: "score-name" }, h("b", null, k.toUpperCase()), h("small", null, ABILITY_NAMES[k])),
        h("button", { type: "button", class: "btn step", "aria-label": `Decrease ${k}`, disabled: !canDecrease(form.scores, k), onClick: () => { form.scores = adjust(form.scores, k, -1); refreshScores(); } }, "-"),
        h("span", { class: "score-val" }, v),
        h("button", { type: "button", class: "btn step", "aria-label": `Increase ${k}`, disabled: !canIncrease(form.scores, k), onClick: () => { form.scores = adjust(form.scores, k, 1); refreshScores(); } }, "+"),
        h("span", { class: "score-cost muted" }, inc === null ? `max (${scoreCost(v)} pts)` : `${scoreCost(v)} pts, next +${inc}`),
      );
    }));
  }
  keySel.addEventListener("change", refreshScores);

  // ----- traits -----
  const traitBox = h("div", { class: "chip-row wrap" });
  const traitCount = h("span", { class: "muted" });
  function refreshTraits(): void {
    traitCount.textContent = `${form.traits.length} of ${MAX_TRAITS} chosen`;
    replaceChildren(traitBox, ...CHECK_TAGS.map((t) =>
      h("button", {
        type: "button", class: `chip toggle${form.traits.includes(t) ? " on" : ""}`, "aria-pressed": String(form.traits.includes(t)),
        onClick: () => { form.traits = toggleTrait(form.traits, t as CheckTag); refreshTraits(); },
      }, t)));
  }

  // ----- abilities -----
  const abilityBox = h("div", { class: "stack" });
  const addAbility = h("button", { type: "button", class: "btn small", onClick: () => { form.abilityTexts.push(""); refreshAbilities(); } }, "Add ability");
  function refreshAbilities(): void {
    replaceChildren(abilityBox, ...form.abilityTexts.map((t, i) => {
      const ta = h("textarea", {
        rows: 2, maxlength: 300, value: t, "aria-label": `Ability ${i + 1}`,
        placeholder: "Describe what your ability does. The DM's forge will turn it into rules.",
      });
      ta.addEventListener("input", () => { form.abilityTexts[i] = ta.value; count.textContent = `${ta.value.length}/300`; });
      const count = h("small", { class: "muted" }, `${t.length}/300`);
      return h("div", { class: "ability-edit" },
        h("div", { class: "row between" }, h("b", null, `Ability ${i + 1}`), count,
          form.abilityTexts.length > 1 ? h("button", { type: "button", class: "btn tiny ghost", onClick: () => { form.abilityTexts.splice(i, 1); refreshAbilities(); } }, "Remove") : null),
        ta);
    }));
    addAbility.hidden = form.abilityTexts.length >= MAX_ABILITIES;
  }

  // ----- sprite builder -----
  let slot: PaletteSlot = "primary";
  let previewFrame = 0;
  const preview = h("canvas", { class: "sprite-preview", width: 144, height: 192, "aria-label": "Sprite preview" });
  const bodyBox = h("div", { class: "chip-row wrap" });
  const sizeBox = h("div", { class: "chip-row" });
  const slotBox = h("div", { class: "chip-row" });
  const swatchBox = h("div", { class: "swatches wide" });
  const partsBox = h("div", { class: "stack tight" });
  const partCount = h("span", { class: "muted" });
  const currentSpec = (): SpriteSpec => buildSpriteSpec(form.sprite, form.name);

  function drawPreview(): void {
    const g = preview.getContext("2d");
    if (!g) return;
    const s = form.painted
      ? composeRecipe(form.painted, "right", previewFrame) ?? composeSprite(currentSpec(), "right", previewFrame)
      : composeSprite(currentSpec(), "right", previewFrame);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, preview.width, preview.height);
    const k = 3; // 48 x 64 canvas drawn at 3x
    const fx = 72, fy = 60 * k + 6;
    g.fillStyle = "rgba(10,6,20,0.38)";
    g.beginPath(); g.ellipse(fx, fy - 2, 17 * k * 0.75 * Math.max(1, s.scale * 0.9), 6 * k * 0.7, 0, 0, Math.PI * 2); g.fill();
    g.imageSmoothingEnabled = false;
    const fit = Math.min(1, 1 / s.scale * 1.1);
    g.drawImage(s.canvas, fx - s.footX * k * fit, fy - s.footY * k * fit, s.canvas.width * k * fit, s.canvas.height * k * fit);
  }
  // ----- paint over / paint from scratch -----
  const paintNote = h("p", { class: "muted", role: "status" });
  const paintOver = h("button", { type: "button", class: "btn small", onClick: () => startEditor("over") }, "Paint over");
  const paintScratch = h("button", { type: "button", class: "btn small", onClick: () => startEditor("scratch") }, "Paint from scratch");
  const editPaint = h("button", { type: "button", class: "btn small", onClick: () => startEditor("edit") }, "Edit painting");
  const removePaint = h("button", { type: "button", class: "btn small ghost", onClick: () => { clearPainting(); refreshPreview(); } }, "Remove painting");
  const paintRow = h("div", { class: "paint-row" }, paintOver, editPaint, paintScratch, removePaint);
  function clearPainting(): void { form.painted = undefined; }
  function startEditor(mode: "over" | "scratch" | "edit"): void {
    const size = form.painted?.size ?? form.sprite.size;
    let px = blank();
    let base: SpriteSpec | undefined;
    if (mode === "edit" && form.painted) {
      px = fromRecipe(form.painted) ?? px;
      base = form.painted.base;
    } else if (mode === "over") {
      base = currentSpec();
      try { px = rasterizeSpec(base).px; } catch { base = undefined; }
    }
    openPixelEditor({
      px, size, base, traits: base?.traits,
      onSave: (sprite) => { form.painted = sprite; refreshPreview(); },
    });
  }
  function refreshPaintControls(): void {
    const has = !!form.painted;
    paintOver.hidden = has; editPaint.hidden = !has; removePaint.hidden = !has;
    paintNote.textContent = has
      ? "Using your painting. Changing the look below replaces it."
      : "Or make your own pixel sprite: start from this look or from a blank canvas.";
  }
  function refreshPreview(): void {
    drawPreview();
    refreshPaintControls();
    for (const b of bodyBox.querySelectorAll("button")) b.classList.toggle("on", b.dataset.body === form.sprite.body);
    for (const b of sizeBox.querySelectorAll("button")) b.classList.toggle("on", b.dataset.size === form.sprite.size);
    for (const b of slotBox.querySelectorAll("button")) b.classList.toggle("on", b.dataset.slot === slot);
    for (const b of swatchBox.querySelectorAll("button")) b.classList.toggle("on", b.dataset.color === form.sprite.palette[slot]);
    const n = form.sprite.parts.length;
    partCount.textContent = `${n} of ${MAX_BUILDER_PARTS} chosen`;
    for (const b of partsBox.querySelectorAll("button")) {
      const on = form.sprite.parts.includes(b.dataset.part as never);
      b.classList.toggle("on", on);
      b.classList.toggle("dim", !on && n >= MAX_BUILDER_PARTS);
      b.setAttribute("aria-pressed", String(on));
    }
  }
  function buildSpriteControls(): void {
    replaceChildren(bodyBox, ...BODY_PLANS.map((b) => h("button", {
      type: "button", class: "chip", "data-body": b, onClick: () => { clearPainting(); form.sprite.body = b; refreshPreview(); },
    }, BODY_LABEL[b])));
    replaceChildren(sizeBox, ...BUILDER_SIZES.map((z) => h("button", {
      type: "button", class: "chip", "data-size": z, onClick: () => { clearPainting(); form.sprite.size = z; refreshPreview(); },
    }, z)));
    replaceChildren(slotBox, ...PALETTE_SLOTS.map((k) => h("button", {
      type: "button", class: "chip slot", "data-slot": k, onClick: () => { slot = k; buildSpriteControls(); refreshPreview(); },
    }, h("span", { class: "dot", style: `background:${form.sprite.palette[k]}` }), SLOT_LABEL[k])));
    replaceChildren(swatchBox, ...SWATCHES.map((c) => h("button", {
      type: "button", class: "swatch", "data-color": c, style: `background:${c}`, "aria-label": `${SLOT_LABEL[slot]} color ${c}`,
      onClick: () => { clearPainting(); form.sprite.palette[slot] = c; buildSpriteControls(); refreshPreview(); },
    })));
    replaceChildren(partsBox, ...(Object.keys(PART_GROUPS) as PartGroup[]).map((g) => h("div", { class: "part-group" },
      h("b", null, GROUP_LABEL[g]),
      h("div", { class: "chip-row wrap" }, ...PART_GROUPS[g].map((part) => h("button", {
        type: "button", class: "chip toggle small", "data-part": part,
        onClick: () => { clearPainting(); form.sprite.parts = togglePart(form.sprite.parts, part); refreshPreview(); },
      }, part.replace(/_/g, " ")))))));
  }
  const randomBtn = h("button", {
    type: "button", class: "btn small",
    onClick: () => {
      clearPainting();
      form.sprite = randomLook(form.name, form.sprite.rolls + 1);
      buildSpriteControls(); refreshPreview();
    },
  }, "Randomize look");

  // ----- describe your look -----
  const lookIn = h("textarea", {
    rows: 2, maxlength: SPRITE_PROMPT_MAX, "aria-label": "Describe your look",
    placeholder: "e.g. a lanky heron-folk ferryman with a lantern and a patched blue coat",
  });
  const lookCount = h("small", { class: "muted" }, `0/${SPRITE_PROMPT_MAX}`);
  const lookNote = h("p", { class: "muted", role: "status" });
  const designBtn = h("button", { type: "button", class: "btn small" }, "Design");
  lookIn.addEventListener("input", () => { lookCount.textContent = `${lookIn.value.length}/${SPRITE_PROMPT_MAX}`; });
  let designing = false;
  let designed = false;
  designBtn.addEventListener("click", () => {
    const prompt = lookIn.value.trim();
    if (designing) return;
    if (!prompt) { lookNote.textContent = "Describe your character's look first."; return; }
    const name = form.name.trim().slice(0, 30);
    const id = ctx.client.send("design_sprite", {
      prompt, role_hint: "pc", seed: Math.floor(Math.random() * 0x7fffffff), ...(name ? { name } : {}),
    });
    if (!id) return;
    designing = true;
    designBtn.disabled = true;
    lookNote.textContent = "Designing...";
    ctx.client.afterReply(id, (type, msg) => {
      designing = false;
      designBtn.disabled = false;
      if (type === "sprite_designed" && msg.type === "sprite_designed") {
        clearPainting();
        form.sprite = { ...designedForm(msg.payload.spec), rolls: form.sprite.rolls };
        designed = true;
        designBtn.textContent = "Design again";
        lookNote.textContent = msg.payload.source === "offline"
          ? "Designed offline from keywords. Press Design again for another take, or tweak below."
          : "Press Design again for another take, or tweak it below.";
        buildSpriteControls(); refreshPreview();
      } else {
        lookNote.textContent = "That did not work. Try again in a moment.";
      }
    });
  });
  const describeBox = h("section", { class: "stack tight describe-look" },
    h("div", { class: "row between" }, h("b", null, "Describe your look"), lookCount),
    lookIn, h("div", { class: "row" }, designBtn), lookNote);
  let seen = false;
  const bob = setInterval(() => {
    if (preview.isConnected) seen = true;
    else if (seen) { clearInterval(bob); return; }
    previewFrame = 1 - previewFrame;
    drawPreview();
  }, 450);

  // ----- Workshop (accounts) -----
  const wsSave = h("button", { type: "button", class: "btn small", title: "Keep this look in your Workshop library" }, "Save look to Workshop");
  const wsOpen = h("button", { type: "button", class: "btn small ghost" }, "Open Workshop");
  const workshopRow = h("div", { class: "paint-row workshop-row", hidden: true }, wsSave, wsOpen);
  wsSave.addEventListener("click", () => {
    const recipe: SpriteRecipe = form.painted ?? currentSpec();
    wsSave.disabled = true;
    const ok = saveToWorkshop(ctx, {
      name: form.name.trim() || "My look", role_hint: "pc", concept: lookIn.value.trim() || form.description, recipe,
    }, () => { wsSave.disabled = false; });
    if (!ok) wsSave.disabled = false;
  });
  wsOpen.addEventListener("click", () => openWorkshop(ctx));

  // ----- premades -----
  const premades = premadeForms();
  const premadeRow = h("div", { class: "chip-row wrap" },
    h("span", { class: "muted" }, "Quick start:"),
    ...premades.map((p) => h("button", {
      type: "button", class: "chip", onClick: () => { form = structuredClone(p.form); errors = {}; syncAll(); },
    }, p.label)));

  // ----- accounts: saved characters and "save this one" -----
  const savedBox = h("section", { class: "stack tight saved-chars", "aria-label": "From my characters" });
  const saveChk = h("input", { type: "checkbox", id: "save-character", checked: true });
  const saveRow = h("label", { class: "inline check", for: "save-character" }, saveChk, "Save to my characters");
  let savedKey = "";
  function updateAccount(s: AppState): void {
    const signedIn = !!s.auth.user;
    saveRow.hidden = !signedIn;
    workshopRow.hidden = !signedIn;
    const list = signedIn ? s.auth.characters : [];
    savedBox.hidden = list.length === 0;
    const key = JSON.stringify(list.map((c) => [c.id, c.name]));
    if (key === savedKey) return;
    savedKey = key;
    replaceChildren(savedBox,
      h("h3", null, "From my characters"),
      h("div", { class: "chip-row wrap" }, ...list.map((c) => h("button", {
        type: "button", class: "chip saved-chip", title: c.ability_names.join(", "),
        onClick: () => {
          const id = ctx.client.send("claim_character", { character_id: "template", template_id: c.id });
          if (id) {
            ctx.store.update((st) => { st.myCharacterName = c.name; });
            onClaimed?.();
          }
        },
      }, recipeIcon(c.sprite_recipe, c.name, 24), h("span", null, c.name)))),
      h("p", { class: "muted" }, "Pick one to claim it, or build a new character below."));
  }

  // ----- submit -----
  const summary = h("p", { class: "field-error", role: "alert" });
  const submit = h("button", { type: "submit", class: "btn primary big" }, "Claim this character");
  const formEl = h("form", { class: "creator stack", novalidate: true, autocomplete: "off" },
    savedBox,
    h("div", { class: "row between wrap" }, h("h2", null, "Create your character"), premadeRow),
    h("div", { class: "grid2" },
      h("div", { class: "stack" },
        h("label", null, "Name", nameIn, errEls.name!),
        h("label", null, "Title", titleIn, errEls.title!),
        h("label", null, "Description", descIn, errEls.description!),
        h("label", null, "Key ability", keySel, errEls.key_ability!),
      ),
      h("div", { class: "stack" },
        describeBox,
        h("div", { class: "sprite-col" }, preview,
          h("div", { class: "stack tight" }, h("b", null, "Body plan"), bodyBox, h("b", null, "Size"), sizeBox, randomBtn)),
        h("section", { class: "stack tight paint-section" }, h("b", null, "Paint your own"), paintNote, paintRow, workshopRow),
      ),
    ),
    h("section", { class: "stack tight sprite-builder" },
      h("h3", null, "Look"),
      h("p", { class: "muted" }, "Pick colors for each slot from the master palette."),
      slotBox, swatchBox,
      h("div", { class: "row between" }, h("b", null, "Parts"), partCount),
      partsBox, errEls.sprite!, errEls.glyph!),
    h("section", { class: "stack tight" }, h("h3", null, "Ability scores"), h("p", { class: "muted" }, `Spend exactly ${POINT_BUY_BUDGET} points. Each score is 8 to 15.`), counter, scoreRows, errEls.scores!),
    h("section", { class: "stack tight" }, h("h3", null, "Two traits"), h("div", { class: "row" }, traitCount), traitBox, errEls.traits!),
    h("section", { class: "stack tight" }, h("h3", null, "Abilities (1 to 3)"),
      h("p", { class: "muted" }, "Describe each ability in your own words. The DM's forge will turn it into rules, and may tone it down."),
      abilityBox, addAbility, errEls.abilities!),
    summary,
    saveRow,
    submit,
  );

  function showErrors(): void {
    for (const [k, el] of Object.entries(errEls)) el.textContent = errors[k as keyof FormErrors] ?? "";
    summary.textContent = Object.keys(errors).length ? "Fix the highlighted fields and try again." : "";
  }

  function syncAll(): void {
    nameIn.value = form.name; titleIn.value = form.title; descIn.value = form.description;
    if (designed) { designed = false; designBtn.textContent = "Design"; lookNote.textContent = ""; }
    keySel.value = form.key_ability;
    refreshScores(); refreshTraits(); refreshAbilities(); buildSpriteControls(); refreshPreview(); showErrors();
  }

  formEl.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const r = buildCreate(form);
    if (!r.ok) { errors = r.errors; showErrors(); formEl.querySelector(".field-error:not(:empty)")?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
    errors = {}; showErrors();
    const id = ctx.client.send("claim_character", { character_id: "new", character: r.value });
    if (id) {
      ctx.store.update((s) => { s.myCharacterName = r.value.name; });
      if (ctx.store.state.auth.user && saveChk.checked) {
        // only once the claim has worked (the forge can refuse or fail)
        ctx.client.afterReply(id, (type) => {
          if (type === "character_claimed") ctx.client.send("save_character_template", { character: r.value });
        });
      }
      onClaimed?.();
    }
  });

  syncAll();
  updateAccount(ctx.store.state);
  return { el: formEl, focusName: () => nameIn.focus(), update: updateAccount };
}
