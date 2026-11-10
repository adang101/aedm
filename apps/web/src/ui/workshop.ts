import { SPRITE_PROMPT_MAX, WORKSHOP_MAX_ASSETS, type SpriteRoleHint, type SpriteSpec, type WorkshopAsset } from "@aedm/schemas";
import { blank, fromRecipe } from "../state/pixel-editor";
import type { AppState } from "../state/store";
import { ROLE_LABEL, SOURCE_LABEL, formatBytes, savePayload } from "../state/workshop";
import { h, replaceChildren } from "../util/dom";
import { recipeIcon, specIcon } from "./creator";
import { openPixelEditor, rasterizeSpec } from "./pixel-editor";
import type { Ctx } from "./types";

const DESIGN_ROLES: readonly SpriteRoleHint[] = ["npc", "enemy", "prop", "pc"];

/** Saves a recipe to the account's Workshop and tells the player how it went. */
export function saveToWorkshop(ctx: Ctx, input: Parameters<typeof savePayload>[0], done?: (ok: boolean) => void): boolean {
  const id = ctx.client.send("save_sprite_asset", savePayload(input));
  if (!id) return false;
  ctx.client.afterReply(id, (type) => {
    if (type === "sprite_assets_list") ctx.toast(`Saved "${input.name.trim().slice(0, 40) || "Untitled"}" to your Workshop`, "info");
    done?.(type === "sprite_assets_list");
  });
  return true;
}

let openModal: { close(): void } | null = null;

/** The Workshop: the account's sprite library, with a "design a look" box that works for NPCs and enemies too. */
export function openWorkshop(ctx: Ctx): { close(): void } {
  openModal?.close();
  let editingId: string | null = null;
  let confirmId: string | null = null;
  let listKey = "";

  // ----- usage -----
  const usage = h("p", { class: "muted", role: "status" });

  // ----- design a look -----
  const roleSel = h("select", { "aria-label": "What is this look for?" }, ...DESIGN_ROLES.map((r) => h("option", { value: r }, ROLE_LABEL[r])));
  const nameIn = h("input", { type: "text", maxlength: 40, placeholder: "Name, e.g. Old Wren", "aria-label": "Name" });
  const promptIn = h("textarea", { rows: 2, maxlength: SPRITE_PROMPT_MAX, "aria-label": "Describe the look", placeholder: "e.g. a lanky heron-folk ferryman with a lantern and a patched blue coat" });
  const designBtn = h("button", { type: "button", class: "btn small" }, "Design");
  const saveDesignBtn = h("button", { type: "button", class: "btn small primary", hidden: true }, "Save to Workshop");
  const designNote = h("p", { class: "muted", role: "status" });
  const previewBox = h("div", { class: "ws-preview", hidden: true });
  let designed: SpriteSpec | null = null;
  let designing = false;
  roleSel.value = "npc";

  designBtn.addEventListener("click", () => {
    const prompt = promptIn.value.trim();
    if (designing) return;
    if (!prompt) { designNote.textContent = "Describe the look first."; return; }
    const name = nameIn.value.trim().slice(0, 30);
    const id = ctx.client.send("design_sprite", {
      prompt, role_hint: roleSel.value as SpriteRoleHint, seed: Math.floor(Math.random() * 0x7fffffff), ...(name ? { name } : {}),
    });
    if (!id) return;
    designing = true; designBtn.disabled = true; designNote.textContent = "Designing...";
    ctx.client.afterReply(id, (type, msg) => {
      designing = false; designBtn.disabled = false;
      if (type === "sprite_designed" && msg.type === "sprite_designed") {
        designed = msg.payload.spec;
        designBtn.textContent = "Design again";
        designNote.textContent = msg.payload.source === "offline" ? "Designed offline from keywords. Design again for another take." : "Design again for another take, or save this one.";
        replaceChildren(previewBox, specIcon(designed, 96));
        previewBox.hidden = false; saveDesignBtn.hidden = false;
      } else {
        designNote.textContent = "That did not work. Try again in a moment.";
      }
    });
  });
  saveDesignBtn.addEventListener("click", () => {
    if (!designed) return;
    const role = roleSel.value as SpriteRoleHint;
    saveDesignBtn.disabled = true;
    saveToWorkshop(ctx, { name: nameIn.value || ROLE_LABEL[role], role_hint: role, concept: promptIn.value, recipe: designed }, () => { saveDesignBtn.disabled = false; });
  });
  const designBox = h("section", { class: "stack tight ws-design" },
    h("h3", null, "Design a look"),
    h("p", { class: "muted" }, "Describe a character, NPC or creature. Save it, then offer NPC and enemy looks to a campaign's cast."),
    h("div", { class: "row wrap" }, h("label", { class: "inline" }, "For", roleSel), nameIn),
    promptIn,
    h("div", { class: "row" }, designBtn, saveDesignBtn),
    previewBox, designNote);

  // ----- the list -----
  const listEl = h("ul", { class: "saved-list ws-list" });

  function paint(a: WorkshopAsset): void {
    const r = a.recipe;
    let px = blank();
    let base: SpriteSpec | undefined;
    if (r.kind === "pixel") { px = fromRecipe(r) ?? px; base = r.base; }
    else if (r.kind === "spec") { base = r; try { px = rasterizeSpec(r).px; } catch { base = undefined; } }
    const size = r.kind === "shape" ? "medium" : r.size;
    const inPlace = r.kind === "pixel";
    openPixelEditor({
      px, size, base, traits: base?.traits,
      onSave: (sprite) => {
        saveToWorkshop(ctx, inPlace
          ? { id: a.id, name: a.name, role_hint: a.role_hint, concept: a.concept, tags: a.tags, recipe: sprite }
          : { name: `${a.name} painted`, role_hint: a.role_hint, concept: a.concept, tags: a.tags, recipe: sprite });
      },
    });
  }

  function editRow(a: WorkshopAsset): HTMLElement {
    const name = h("input", { type: "text", maxlength: 40, value: a.name, "aria-label": "Name" });
    const role = h("select", { "aria-label": "Role" }, ...DESIGN_ROLES.map((x) => h("option", { value: x }, ROLE_LABEL[x])));
    role.value = a.role_hint;
    const concept = h("textarea", { rows: 2, maxlength: 200, "aria-label": "Short concept", value: a.concept });
    return h("li", { class: "saved ws-item editing" },
      recipeIcon(a.recipe, a.name, 48),
      h("div", { class: "saved-main stack tight" }, name, h("div", { class: "row" }, role), concept,
        h("div", { class: "row" },
          h("button", {
            type: "button", class: "btn tiny primary",
            onClick: () => {
              saveToWorkshop(ctx, { id: a.id, name: name.value, role_hint: role.value as SpriteRoleHint, concept: concept.value, tags: a.tags, recipe: a.recipe });
              editingId = null; listKey = ""; renderList(ctx.store.state);
            },
          }, "Save"),
          h("button", { type: "button", class: "btn tiny ghost", onClick: () => { editingId = null; listKey = ""; renderList(ctx.store.state); } }, "Cancel"))));
  }

  function itemRow(a: WorkshopAsset): HTMLElement {
    const confirming = confirmId === a.id;
    return h("li", { class: "saved ws-item", "data-asset": a.id },
      recipeIcon(a.recipe, a.name, 48),
      h("div", { class: "saved-main" },
        h("div", { class: "row wrap" }, h("b", null, a.name), h("span", { class: "badge" }, ROLE_LABEL[a.role_hint]), h("span", { class: "badge tag" }, SOURCE_LABEL[a.source])),
        a.concept ? h("small", { class: "muted" }, a.concept) : null,
        h("div", { class: "row wrap ws-actions" },
          h("button", { type: "button", class: "btn tiny", onClick: () => { editingId = a.id; confirmId = null; listKey = ""; renderList(ctx.store.state); } }, "Details"),
          h("button", { type: "button", class: "btn tiny", onClick: () => paint(a) }, a.recipe.kind === "pixel" ? "Edit painting" : "Paint a copy"),
          h("button", {
            type: "button", class: `btn tiny ${confirming ? "danger" : "ghost"}`, "aria-label": `Delete ${a.name}`,
            onClick: () => {
              if (confirming) { confirmId = null; ctx.client.send("delete_sprite_asset", { id: a.id }); }
              else { confirmId = a.id; listKey = ""; renderList(ctx.store.state); }
            },
          }, confirming ? "Really delete?" : "Delete"))));
  }

  function renderList(s: AppState): void {
    const w = s.auth.workshop;
    if (!w) {
      usage.textContent = s.auth.user ? "Loading your Workshop..." : "Log in to use your Workshop.";
      replaceChildren(listEl);
      listKey = "";
      return;
    }
    usage.textContent = `${w.assets.length} of ${w.maxAssets || WORKSHOP_MAX_ASSETS} sprites, ${formatBytes(w.usedBytes)} of ${formatBytes(w.maxBytes)}`;
    const key = JSON.stringify([w.assets.map((a) => [a.id, a.updated_at]), editingId, confirmId]);
    if (key === listKey) return;
    listKey = key;
    if (w.assets.length === 0) { replaceChildren(listEl, h("li", { class: "muted" }, "Nothing here yet. Design a look above, or save the look from the character creator.")); return; }
    replaceChildren(listEl, ...w.assets.map((a) => (editingId === a.id ? editRow(a) : itemRow(a))));
  }

  // ----- modal shell -----
  const closeBtn = h("button", { type: "button", class: "btn tiny ghost", onClick: () => close() }, "Close");
  const card = h("div", { class: "modal-card workshop stack", role: "dialog", "aria-modal": "true", "aria-label": "Workshop" },
    h("div", { class: "row between" }, h("h2", null, "My Workshop"), closeBtn), usage, designBox, h("h3", null, "My sprites"), listEl);
  const el = h("div", { class: "modal", "data-modal": "workshop" }, card);
  el.addEventListener("click", (ev) => { if (ev.target === el) close(); });
  el.addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Escape") close(); });
  document.body.append(el);

  const unsub = ctx.store.subscribe(renderList);
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true; unsub(); el.remove();
    if (openModal === handle) openModal = null;
  }
  const handle = { close };
  openModal = handle;
  if (!ctx.store.state.auth.workshop) ctx.client.refreshWorkshop();
  renderList(ctx.store.state);
  closeBtn.focus();
  return handle;
}
