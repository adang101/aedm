import type { AbilityScoreKey } from "@aedm/schemas";
import { pendingLevelUp, type AppState } from "../state/store";
import { modifier, SCORE_KEYS, SCORE_NAMES, signed } from "../util/describe";
import { h, replaceChildren } from "../util/dom";
import { abilityCard } from "./ability-card";
import type { Ctx } from "./types";

const HINT = "Describe what your ability does. The DM's forge will turn it into rules.";

export interface LevelUpModal {
  el: HTMLElement;
  open(): void;
  update(s: AppState): void;
}

export function createLevelUpModal(ctx: Ctx): LevelUpModal {
  let isOpen = false;
  /** Set when the last pick was just spent while the modal was open: show the outcome until closed. */
  let done = false;
  let reforgeId: string | null = null;
  let lastKey = "";
  let lastResult: unknown = null;

  const title = h("h2", null, "Level up");
  const closeBtn = h("button", { type: "button", class: "btn tiny ghost", "aria-label": "Close level-up", onClick: () => close() }, "Close");
  const scoreBox = h("section", { class: "stack tight" });
  const budgetBox = h("section", { class: "stack tight" });
  const cardsBox = h("section", { class: "stack tight" });
  const resultBox = h("section", { class: "stack tight", "aria-live": "polite" });

  // The form is created once so typing survives re-renders of the sections around it.
  const formLabel = h("b", null, "Learn a new ability");
  const count = h("small", { class: "muted" }, "0/300");
  const area = h("textarea", { rows: 3, maxlength: 300, placeholder: HINT, "aria-label": "Ability description" });
  area.addEventListener("input", () => { count.textContent = `${area.value.length}/300`; syncForm(ctx.store.state); });
  const submit = h("button", { type: "button", class: "btn primary small", onClick: () => submitForge() }, "Learn it");
  const cancelReforge = h("button", { type: "button", class: "btn small ghost", onClick: () => { reforgeId = null; render(ctx.store.state, true); } }, "Cancel reforge");
  const spinner = h("span", { class: "spinner", role: "status", "aria-label": "Forging" });
  const forgeNote = h("small", { class: "muted" });
  const skipBtn = h("button", { type: "button", class: "btn small", onClick: () => choose({ kind: "skip_ability" }) }, "Keep my abilities");
  const form = h("section", { class: "stack tight forge-form" },
    h("div", { class: "row between" }, formLabel, count), area,
    h("div", { class: "row wrap" }, submit, cancelReforge, skipBtn, spinner), forgeNote);

  const doneBtn = h("button", { type: "button", class: "btn primary", onClick: () => close() }, "Done");
  const card = h("div", { class: "modal-card levelup stack", role: "dialog", "aria-modal": "true", "aria-labelledby": "lvl-title" },
    h("div", { class: "row between" }, title, closeBtn), resultBox, doneBtn, scoreBox, budgetBox, form, cardsBox);
  title.id = "lvl-title";
  const el = h("div", { class: "modal", hidden: true }, card);
  el.addEventListener("click", (ev) => { if (ev.target === el) close(); });
  el.addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Escape") close(); });

  function close(): void {
    isOpen = false; done = false; reforgeId = null;
    el.hidden = true;
  }

  function choose(payload: Parameters<typeof ctx.client.send<"level_up_choice">>[1]): void {
    const id = ctx.client.send("level_up_choice", payload);
    if (id) ctx.store.update((s) => { s.levelUpBusy = true; s.levelUpResult = null; });
  }

  function submitForge(): void {
    const text = area.value.trim();
    if (!text) { ctx.toast("Describe the ability first."); return; }
    if (reforgeId) choose({ kind: "reforge", ability_id: reforgeId, text });
    else choose({ kind: "new_ability", text });
  }

  function syncForm(s: AppState): void {
    const lu = s.levelUp;
    const picks = lu?.ability_picks ?? 0;
    const full = !!lu && lu.max_abilities !== undefined && lu.abilities.length >= lu.max_abilities;
    const canForge = picks > 0 && (reforgeId !== null || !full);
    form.hidden = picks <= 0;
    const target = reforgeId ? lu?.abilities.find((a) => a.id === reforgeId) : undefined;
    formLabel.textContent = target ? `Reforge ${target.name}` : "Learn a new ability";
    submit.textContent = target ? "Reforge it" : "Learn it";
    submit.hidden = !canForge;
    area.hidden = !canForge;
    count.hidden = !canForge;
    cancelReforge.hidden = reforgeId === null;
    forgeNote.textContent = canForge ? "" : `You know ${lu?.abilities.length ?? 0} abilities, the most you can hold. Reforge one, or keep them.`;
    spinner.hidden = !s.levelUpBusy;
    const busy = s.levelUpBusy;
    area.disabled = busy;
    submit.disabled = busy || area.value.trim() === "";
    skipBtn.disabled = busy;
    cancelReforge.disabled = busy;
  }

  function renderScores(s: AppState): void {
    const lu = s.levelUp;
    scoreBox.hidden = !lu || lu.score_points <= 0;
    if (!lu || lu.score_points <= 0) return;
    replaceChildren(scoreBox,
      h("h3", null, `Ability score: +1 to one (${lu.score_points} to spend)`),
      ...SCORE_KEYS.map((k: AbilityScoreKey) => {
        const v = lu.scores[k];
        const maxed = v >= 20;
        const before = modifier(v), after = modifier(Math.min(20, v + 1));
        return h("div", { class: "lvl-score" },
          h("span", { class: "lvl-score-name" }, SCORE_NAMES[k]),
          h("span", { class: "lvl-score-val" }, `${v} (${signed(before)})`),
          h("span", { class: `lvl-score-next${after > before ? " up" : ""}` }, maxed ? "max" : `${v + 1} (${signed(after)})`),
          h("button", {
            type: "button", class: "btn tiny", disabled: maxed || s.levelUpBusy, "aria-label": `Raise ${SCORE_NAMES[k]} by 1`,
            onClick: () => choose({ kind: "score", ability: k }),
          }, "+1"));
      }));
  }

  function renderBudget(s: AppState): void {
    const lu = s.levelUp;
    budgetBox.hidden = !lu || lu.ability_picks <= 0;
    cardsBox.hidden = budgetBox.hidden;
    if (!lu || lu.ability_picks <= 0) return;
    const frac = Math.min(1, lu.budget_used / Math.max(1, lu.budget));
    replaceChildren(budgetBox,
      h("h3", null, `Abilities: ${lu.ability_picks} pick${lu.ability_picks === 1 ? "" : "s"} to spend`),
      h("div", { class: "row between" }, h("span", null, "Power budget"), h("b", null, `${lu.budget_used} / ${lu.budget}`)),
      h("div", { class: "budget", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": lu.budget, "aria-valuenow": lu.budget_used },
        h("i", { class: frac > 0.9 ? "full" : "", style: `width:${Math.round(frac * 100)}%` })),
      h("p", { class: "muted" }, `${lu.budget - lu.budget_used} left. One ability may cost at most ${lu.per_ability_cap}. Damage or healing averages up to ${lu.caps.max_avg}, areas up to radius ${lu.caps.max_radius}.`));
    replaceChildren(cardsBox,
      h("h3", null, "Your abilities"),
      ...lu.abilities.map((a) => abilityCard(a, h("button", {
        type: "button", class: `btn tiny${reforgeId === a.id ? " primary" : ""}`, disabled: s.levelUpBusy,
        onClick: () => { reforgeId = reforgeId === a.id ? null : (a.id ?? null); render(ctx.store.state, true); area.focus(); },
      }, reforgeId === a.id ? "Reforging" : "Reforge"))));
  }

  function renderResult(s: AppState): void {
    const r = s.levelUpResult;
    resultBox.hidden = !r;
    if (!r) { replaceChildren(resultBox); return; }
    replaceChildren(resultBox,
      h("div", { class: `lvl-result ${r.ok ? "ok" : "bad"}` }, r.message),
      ...(r.forge_notes.length ? [h("ul", { class: "forge-notes" }, ...r.forge_notes.map((n) => h("li", null, n)))] : []),
      r.ability ? abilityCard(r.ability) : null);
  }

  function render(s: AppState, force = false): void {
    if (s.levelUpResult && s.levelUpResult !== lastResult) {
      lastResult = s.levelUpResult;
      if (s.levelUpResult.ok) { area.value = ""; count.textContent = "0/300"; }
    }
    const key = JSON.stringify([s.levelUp, s.levelUpBusy, s.levelUpResult, reforgeId, done]);
    if (!force && key === lastKey) return;
    lastKey = key;
    title.textContent = `Level ${s.levelUp?.level ?? ""}`.trim();
    renderScores(s);
    renderBudget(s);
    renderResult(s);
    syncForm(s);
    doneBtn.hidden = !done;
    skipBtn.hidden = (s.levelUp?.ability_picks ?? 0) <= 0;
  }

  return {
    el,
    open() {
      if (!pendingLevelUp(ctx.store.state)) return;
      isOpen = true; done = false; el.hidden = false;
      ctx.store.update((s) => { s.levelUpResult = null; });
      render(ctx.store.state, true);
      (card.querySelector("button.btn") as HTMLElement | null)?.focus();
    },
    update(s) {
      const pending = pendingLevelUp(s);
      if (isOpen && !pending && !done) {
        // The last pick was just spent: keep the outcome on screen until the player closes it.
        done = true;
        if (reforgeId) reforgeId = null;
      }
      if (isOpen && pending && done) done = false;
      el.hidden = !isOpen;
      if (!isOpen) return;
      if (reforgeId && !s.levelUp?.abilities.some((a) => a.id === reforgeId)) reforgeId = null;
      render(s);
    },
  };
}
