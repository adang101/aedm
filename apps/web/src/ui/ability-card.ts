import type { Ability } from "@aedm/schemas";
import { describeAbility } from "../util/describe";
import { h } from "../util/dom";

/** An ability as a card: name, cost, description, rules in plain words, tags. All text via textContent. */
export function abilityCard(a: Ability, extra?: HTMLElement | null): HTMLElement {
  const d = describeAbility(a);
  return h("div", { class: "ability-card" },
    h("div", { class: "row between" }, h("b", { class: "ab-name" }, a.name), h("span", { class: "badge cost" }, `Cost ${a.cost ?? "?"}`)),
    h("p", { class: "ab-desc" }, a.description),
    h("p", { class: "ab-meta muted" }, d.header),
    h("ul", { class: "ab-effects" }, ...d.effects.map((e) => h("li", null, e))),
    d.tags.length ? h("div", { class: "row wrap" }, ...d.tags.map((t) => h("span", { class: "badge tag" }, t))) : null,
    extra ?? null);
}
