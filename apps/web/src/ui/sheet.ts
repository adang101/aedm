import { modifier, SCORE_KEYS, SCORE_NAMES, signed } from "../util/describe";
import { h, replaceChildren } from "../util/dom";
import { armorName, defenseOf, growthProgress } from "../util/sheet";
import type { AppState } from "../state/store";
import { abilityCard } from "./ability-card";
import type { Ctx } from "./types";

export interface SheetModal {
  el: HTMLElement;
  open(characterId: string): void;
  update(s: AppState): void;
}

/** Read-only character sheet. Everything untrusted goes in as text. */
export function createSheetModal(ctx: Ctx): SheetModal {
  let charId: string | null = null;
  const body = h("div", { class: "stack" });
  const closeBtn = h("button", { type: "button", class: "btn tiny ghost", onClick: () => close() }, "Close");
  const card = h("div", { class: "modal-card sheet stack", role: "dialog", "aria-modal": "true", "aria-label": "Character sheet" },
    h("div", { class: "row between" }, h("h2", null, "Character sheet"), closeBtn), body);
  const el = h("div", { class: "modal", hidden: true }, card);
  el.addEventListener("click", (ev) => { if (ev.target === el) close(); });
  el.addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Escape") close(); });

  function close(): void { charId = null; el.hidden = true; }

  function render(s: AppState): void {
    const c = charId ? s.party.find((p) => p.id === charId) : undefined;
    if (!c) { close(); return; }
    const e = s.entities[c.id];
    const hp = e?.hp ?? c.hp, hpMax = e?.hp_max ?? c.hp_max;
    const g = growthProgress(c.growth, c.level);
    const mine = s.claimed[c.id] === s.playerId || e?.owner_player_id === s.playerId;
    replaceChildren(body,
      h("div", { class: "row" },
        h("span", { class: "init-dot big", style: `background:${c.sprite_recipe.color};border-color:${c.sprite_recipe.accent}` }, c.sprite_recipe.glyph),
        h("div", { class: "stack tight grow" },
          h("div", { class: "row between" }, h("h2", null, c.name), h("span", { class: "badge" }, `Level ${c.level}`)),
          c.title ? h("div", { class: "muted" }, c.title) : null)),
      c.description ? h("p", { class: "muted" }, c.description) : null,
      h("div", { class: "stack tight" },
        h("div", { class: "row between" }, h("span", null, "Growth"), h("small", { class: "muted" }, g.maxed ? "Max level" : `${g.into} / ${g.need} to level ${c.level + 1}`)),
        h("div", { class: "budget growth", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": g.need, "aria-valuenow": g.into }, h("i", { style: `width:${g.pct}%` }))),
      h("div", { class: "sheet-stats" },
        h("div", null, h("small", { class: "label" }, "HP"), h("b", null, `${hp} / ${hpMax}`)),
        h("div", null, h("small", { class: "label" }, "Defense"), h("b", null, String(defenseOf(c.scores.dex, c.armor_bonus)))),
        h("div", null, h("small", { class: "label" }, "Armor"), h("b", null, armorName(c.armor_bonus))),
        h("div", null, h("small", { class: "label" }, "Weapon"), h("b", null, `Tier ${c.weapon_tier}`)),
        h("div", null, h("small", { class: "label" }, "Key"), h("b", null, c.key_ability.toUpperCase()))),
      h("h3", null, "Ability scores"),
      h("div", { class: "sheet-scores" }, ...SCORE_KEYS.map((k) => h("div", { class: `sheet-score${c.key_ability === k ? " key" : ""}`, title: SCORE_NAMES[k] },
        h("small", { class: "label" }, k.toUpperCase()), h("b", null, String(c.scores[k])), h("span", { class: "muted" }, signed(modifier(c.scores[k])))))),
      h("h3", null, "Tags"),
      h("div", { class: "row wrap" }, ...c.trait_tags.map((t) => h("span", { class: "badge tag" }, t))),
      h("h3", null, `Abilities (${c.abilities.length})`),
      ...c.abilities.map((a) => abilityCard(a)),
      h("h3", null, "Inventory"),
      c.inventory && c.inventory.length > 0
        ? h("ul", { class: "inv" }, ...c.inventory.map((i) => h("li", null, h("span", null, i.name), h("small", { class: "muted" }, `${i.kind}${i.tier ? ` T${i.tier}` : ""}, ${i.value} gp`))))
        : h("p", { class: "muted" }, c.inventory ? "Empty." : "Not shown."),
      mine ? null : h("p", { class: "muted" }, "You are viewing another player's character."));
  }

  return {
    el,
    open(id) { charId = id; el.hidden = false; render(ctx.store.state); closeBtn.focus(); },
    update(s) { if (charId) render(s); },
  };
}
