import type { Ability } from "@aedm/schemas";
import { myCharacter, myEntity, nameOf, type AppState } from "../state/store";
import { h, replaceChildren } from "../util/dom";

export type Pending = { kind: "attack" } | { kind: "ability"; ability: Ability; id: string } | null;

export interface HudCallbacks {
  onAttack(): void;
  onAbility(ability: Ability, id: string): void;
  onEndTurn(): void;
  onCancel(): void;
}

export interface Hud {
  top: HTMLElement;
  bottom: HTMLElement;
  update(s: AppState, pending: Pending): void;
  tick(s: AppState): void;
}

function timerSeconds(s: AppState): number | null {
  const t = s.turnTimer;
  if (!t) return null;
  return Math.max(0, Math.ceil(t.value.seconds_left - (Date.now() - t.at) / 1000));
}

export function createHud(cb: HudCallbacks): Hud {
  const strip = h("div", { class: "initiative", "aria-label": "Initiative order" });
  const status = h("div", { class: "turn-status" });
  const top = h("div", { class: "hud-top", hidden: true }, status, strip);
  const bottom = h("div", { class: "hud-bottom", hidden: true });
  let statusParts: { turn: HTMLElement; timer: HTMLElement } | null = null;

  return {
    top, bottom,
    update(s, pending) {
      const combat = s.combat;
      top.hidden = !combat;
      bottom.hidden = !combat;
      if (!combat) { statusParts = null; return; }
      const me = myEntity(s);
      const mine = !!me && combat.active_id === me.id;

      const turn = h("span", { class: `turn-name${mine ? " mine" : ""}` }, mine ? "Your turn" : `${nameOf(s, combat.active_id)}'s turn`);
      const timer = h("span", { class: "timer" }, timerSeconds(s) === null ? "" : `${timerSeconds(s)}s`);
      statusParts = { turn, timer };
      replaceChildren(status, h("span", { class: "round" }, `Round ${combat.round}`), turn, timer);

      replaceChildren(strip, ...combat.order.map((o) => {
        const e = s.entities[o.entity_id];
        const isActive = o.entity_id === combat.active_id;
        const sp = e?.sprite;
        return h("div", { class: `init-item ${e?.kind ?? ""}${isActive ? " active" : ""}`, title: `${e?.name ?? o.entity_id}: initiative ${o.initiative}` },
          h("span", { class: "init-dot", style: sp ? `background:${sp.color};border-color:${sp.accent}` : "" }, sp?.glyph ?? "?"),
          h("span", { class: "init-name" }, e?.name ?? o.entity_id),
          e ? h("span", { class: "init-hp" }, `${e.hp}/${e.hp_max}`) : null);
      }));

      const ch = myCharacter(s);
      const targeting = pending !== null;
      replaceChildren(bottom,
        targeting
          ? h("div", { class: "hud-hint" },
            `Choose a target for ${pending.kind === "attack" ? "your attack" : pending.ability.name}. `,
            h("button", { type: "button", class: "btn tiny", onClick: cb.onCancel }, "Cancel"))
          : null,
        h("div", { class: "actions" },
          h("button", { type: "button", class: `btn small${pending?.kind === "attack" ? " primary" : ""}`, disabled: !mine, onClick: cb.onAttack }, "Attack"),
          ...(ch?.abilities ?? []).map((a, i) => {
            const id = a.id ?? `ab_${i}`;
            const active = pending?.kind === "ability" && pending.id === id;
            return h("button", {
              type: "button", class: `btn small${active ? " primary" : ""}`, disabled: !mine, title: a.description,
              onClick: () => cb.onAbility(a, id),
            }, a.name, h("small", null, a.action === "quick" ? " (quick)" : ""));
          }),
          h("button", { type: "button", class: "btn small end-turn", disabled: !mine, onClick: cb.onEndTurn }, "End turn"),
        ),
      );
    },
    tick(s) {
      if (!statusParts) return;
      const t = timerSeconds(s);
      statusParts.timer.textContent = t === null ? "" : `${t}s`;
      statusParts.timer.classList.toggle("low", t !== null && t <= 5);
    },
  };
}
