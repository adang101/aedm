import { placeName } from "../state/arrival";
import type { AppState } from "../state/store";
import { h } from "../util/dom";

const SHOW_MS = 3600;

export interface TitleCard {
  el: HTMLElement;
  update(s: AppState): void;
  destroy(): void;
}

/**
 * A place name that fades in over the map when the party arrives somewhere (the first snapshot and every scene change).
 * It ignores the pointer, so it never blocks input, and removes itself after a few seconds. The text is set as text.
 */
export function createTitleCard(): TitleCard {
  const kicker = h("div", { class: "tc-kicker" }, "The party arrives at");
  const title = h("div", { class: "tc-name" });
  const el = h("div", { class: "title-card", "aria-hidden": "true", hidden: true }, kicker, title);
  let shownFor = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    el,
    update(s) {
      const m = s.map;
      if (!m) { shownFor = ""; el.hidden = true; return; }
      if (m.id === shownFor) return;
      shownFor = m.id;
      title.textContent = placeName(m);
      el.hidden = false;
      el.classList.remove("show");
      void el.offsetWidth; // restart the animation
      el.classList.add("show");
      clearTimeout(timer);
      timer = setTimeout(() => { el.hidden = true; el.classList.remove("show"); }, SHOW_MS);
    },
    destroy() { clearTimeout(timer); },
  };
}
