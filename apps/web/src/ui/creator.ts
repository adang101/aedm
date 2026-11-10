import { ABILITIES, CHECK_TAGS, SPRITE_SHAPES, type CheckTag, type SpriteShape } from "@aedm/schemas";
import { ACCENT_SWATCHES, BODY_SWATCHES } from "../render/palette";
import { drawShapeBody } from "../render/sprites";
import {
  MAX_ABILITIES, MAX_TRAITS, autoGlyph, buildCreate, emptyForm, premadeForms, toggleTrait,
  type CreatorForm, type FormErrors,
} from "../state/creator";
import {
  POINT_BUY_BUDGET, adjust, canDecrease, canIncrease, nextCost, pointsLeft, scoreCost,
} from "../state/pointbuy";
import type { AppState } from "../state/store";
import { h, replaceChildren } from "../util/dom";
import type { Ctx } from "./types";

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
  const glyphIn = h("input", { type: "text", maxlength: 2, class: "glyph-input", "aria-label": "Sprite glyph" });

  const errBox = (key: keyof FormErrors) => h("p", { class: "field-error", "data-error": key, role: "alert" });
  const errEls: Record<string, HTMLElement> = {};
  for (const k of ["name", "title", "description", "scores", "traits", "abilities", "glyph", "sprite", "key_ability"] as const) errEls[k] = errBox(k);

  nameIn.addEventListener("input", () => {
    form.name = nameIn.value;
    if (!form.glyphTouched) { form.glyph = autoGlyph(form.name); glyphIn.value = form.glyph; }
    refreshPreview();
  });
  titleIn.addEventListener("input", () => { form.title = titleIn.value; });
  descIn.addEventListener("input", () => { form.description = descIn.value; });
  keySel.addEventListener("change", () => { form.key_ability = keySel.value as CreatorForm["key_ability"]; });
  glyphIn.addEventListener("input", () => {
    form.glyphTouched = glyphIn.value.trim() !== "";
    form.glyph = glyphIn.value.trim() || autoGlyph(form.name);
    refreshPreview();
  });

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

  // ----- sprite -----
  const preview = h("canvas", { class: "sprite-preview", width: 96, height: 128, "aria-label": "Sprite preview" });
  const shapeBox = h("div", { class: "chip-row" });
  const colorBox = h("div", { class: "swatches" });
  const accentBox = h("div", { class: "swatches" });
  function refreshPreview(): void {
    const g = preview.getContext("2d");
    if (g) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, 96, 128);
      g.scale(2, 2);
      g.fillStyle = "rgba(10,6,20,0.38)";
      g.beginPath(); g.ellipse(24, 58, 17, 6, 0, 0, Math.PI * 2); g.fill();
      drawShapeBody(g, { kind: "shape", shape: form.shape, color: form.color, accent: form.accent, glyph: form.glyph || "?" }, 24, 38);
    }
    for (const b of shapeBox.querySelectorAll("button")) b.classList.toggle("on", b.dataset.shape === form.shape);
    for (const b of colorBox.querySelectorAll("button")) b.classList.toggle("on", b.dataset.color === form.color);
    for (const b of accentBox.querySelectorAll("button")) b.classList.toggle("on", b.dataset.color === form.accent);
  }
  function buildSpriteControls(): void {
    replaceChildren(shapeBox, ...SPRITE_SHAPES.map((s) => h("button", {
      type: "button", class: "chip icon", "data-shape": s, "aria-label": s, title: s,
      onClick: () => { form.shape = s; refreshPreview(); },
    }, shapeIcon(s, form.color, form.accent, "", 34))));
    const sw = (list: readonly string[], key: "color" | "accent") => list.map((c) => h("button", {
      type: "button", class: "swatch", "data-color": c, style: `background:${c}`, "aria-label": `${key} ${c}`,
      onClick: () => { form[key] = c; buildSpriteControls(); refreshPreview(); },
    }));
    replaceChildren(colorBox, ...sw(BODY_SWATCHES, "color"));
    replaceChildren(accentBox, ...sw(ACCENT_SWATCHES, "accent"));
  }

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
      }, shapeIcon(c.sprite_recipe.shape, c.sprite_recipe.color, c.sprite_recipe.accent, c.sprite_recipe.glyph, 24), h("span", null, c.name)))),
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
        h("div", { class: "sprite-col" }, preview,
          h("div", { class: "stack tight" }, h("b", null, "Shape"), shapeBox)),
        h("div", { class: "stack tight" }, h("b", null, "Color"), colorBox, h("b", null, "Accent"), accentBox,
          h("label", { class: "inline" }, "Glyph", glyphIn), errEls.glyph!, errEls.sprite!),
      ),
    ),
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
    keySel.value = form.key_ability; glyphIn.value = form.glyph === "?" && !form.name ? "" : form.glyph;
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
