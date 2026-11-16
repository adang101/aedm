import type { AppState } from "../state/store";
import { objectiveSummary, progressFraction, stageLabel } from "../state/objective";
import { storageGet, storageSet } from "../state/storage";
import { h, replaceChildren } from "../util/dom";

const COLLAPSED_KEY = "aedm.objective.collapsed";
const FLASH_MS = 4500;

export interface ObjectiveTracker {
  el: HTMLElement;
  update(s: AppState): void;
  destroy(): void;
}

/** Remembered choice, or collapsed by default on a narrow screen where the map is small. */
function initialCollapsed(): boolean {
  const saved = storageGet(COLLAPSED_KEY);
  if (saved === "1") return true;
  if (saved === "0") return false;
  return typeof matchMedia === "function" && matchMedia("(max-width: 760px)").matches;
}

/**
 * Compact story tracker: one line when collapsed (stage and the next thing to do), the stage title, goal and
 * checklist when open. Everything shown is model-written, so it is only ever set as text.
 */
export function createObjectiveTracker(): ObjectiveTracker {
  let collapsed = initialCollapsed();
  let lastEvent = 0;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let view: AppState["objective"] = null;

  const stage = h("span", { class: "obj-stage" });
  const summary = h("span", { class: "obj-summary" });
  const count = h("span", { class: "obj-count" });
  const chevron = h("span", { class: "obj-chevron", "aria-hidden": "true" });
  const head = h("button", { type: "button", class: "obj-head", "aria-expanded": "true", "aria-controls": "obj-body" }, stage, summary, count, chevron);
  const flash = h("div", { class: "obj-flash", role: "status", hidden: true });
  const title = h("div", { class: "obj-title" });
  const goal = h("p", { class: "obj-goal" });
  const list = h("ul", { class: "obj-list" });
  const bar = h("i");
  const body = h("div", { class: "obj-body", id: "obj-body" }, title, goal, list, h("div", { class: "obj-bar", "aria-hidden": "true" }, bar));
  const el = h("section", { class: "objective", "aria-label": "Story objectives", hidden: true }, head, flash, body);

  function applyCollapsed(): void {
    el.classList.toggle("collapsed", collapsed);
    body.hidden = collapsed;
    head.setAttribute("aria-expanded", String(!collapsed));
    chevron.textContent = collapsed ? "+" : "-";
    head.title = view ? `${view.stage.title}: ${view.stage.goal}` : "";
  }

  head.addEventListener("click", () => {
    collapsed = !collapsed;
    storageSet(COLLAPSED_KEY, collapsed ? "1" : "0");
    applyCollapsed();
  });

  function showFlash(text: string, kind: "done" | "stage" | "end"): void {
    flash.textContent = text;
    flash.className = `obj-flash ${kind}`;
    flash.hidden = false;
    el.classList.remove("pulse");
    void el.offsetWidth; // restart the animation
    el.classList.add("pulse");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash.hidden = true; el.classList.remove("pulse"); }, FLASH_MS);
  }

  return {
    el,
    update(s) {
      view = s.objective;
      el.hidden = !view;
      if (!view) { lastEvent = s.objectiveEvent?.n ?? 0; return; }
      el.classList.toggle("finished", view.finished);
      stage.textContent = view.finished ? "Done" : stageLabel(view);
      summary.textContent = objectiveSummary(view);
      count.textContent = `${view.progress.done}/${view.progress.total}`;
      title.textContent = view.stage.title;
      goal.textContent = view.stage.goal;
      replaceChildren(list, ...view.milestones.map((m) => h("li", { class: m.done ? "done" : "open" },
        h("span", { class: "obj-check", "aria-hidden": "true" }, ""),
        h("span", { class: "obj-hint" }, m.hint),
        h("span", { class: "sr-only" }, m.done ? " (done)" : " (to do)"))));
      bar.style.width = `${Math.round(progressFraction(view) * 100)}%`;
      applyCollapsed();

      const ev = s.objectiveEvent;
      if (ev && ev.n !== lastEvent) {
        lastEvent = ev.n;
        if (ev.finished) showFlash("The story is complete!", "end");
        else if (ev.advancedTo) showFlash(`${stageLabel({ ...view, stage: ev.advancedTo })}: ${ev.advancedTo.title}`, "stage");
        else if (ev.completed.length) showFlash(`Objective complete: ${ev.completed[ev.completed.length - 1]!.hint}`, "done");
      }
    },
    destroy() { clearTimeout(flashTimer); },
  };
}
