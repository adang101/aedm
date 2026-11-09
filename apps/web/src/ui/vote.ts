import { h, replaceChildren } from "../util/dom";
import type { AppState } from "../state/store";
import type { Ctx } from "./types";

const LABEL: Record<string, string> = {
  skip: "Skip their turn", wait: "Wait for them", autopilot: "Let autopilot play",
};

export function createVoteModal(ctx: Ctx): { el: HTMLElement; update(s: AppState): void; tick(): void } {
  const body = h("div", { class: "modal-card stack", role: "dialog", "aria-modal": "true", "aria-label": "Vote" });
  const el = h("div", { class: "modal", hidden: true }, body);
  let timeEl: HTMLElement | null = null;
  let lastKey = "";

  function secondsLeft(s: AppState): number {
    const v = s.vote;
    return v ? Math.max(0, Math.ceil(v.seconds_left - (Date.now() - v.at) / 1000)) : 0;
  }

  return {
    el,
    update(s) {
      const v = s.vote;
      el.hidden = !v;
      if (!v) { lastKey = ""; return; }
      const key = `${v.vote_id}|${JSON.stringify(v.tally)}|${v.myChoice}`;
      if (key === lastKey) return;
      lastKey = key;
      timeEl = h("span", { class: "timer" }, `${secondsLeft(s)}s`);
      replaceChildren(body,
        h("div", { class: "row between" }, h("h2", null, "Table vote"), timeEl),
        h("p", null, v.topic),
        h("div", { class: "stack tight" }, ...v.options.map((o) => {
          const n = v.tally[o] ?? 0;
          return h("button", {
            type: "button", class: `btn vote-opt${v.myChoice === o ? " primary" : ""}`, disabled: v.myChoice !== null,
            onClick: () => {
              const id = ctx.client.send("vote_cast", { vote_id: v.vote_id, choice: o as "skip" });
              if (id) ctx.store.update((st) => { if (st.vote) st.vote.myChoice = o; });
            },
          }, h("span", null, LABEL[o] ?? o), h("span", { class: "count" }, n));
        })),
        v.myChoice ? h("p", { class: "muted" }, "Vote recorded. Waiting for the others.") : null,
      );
    },
    tick() {
      if (timeEl) timeEl.textContent = `${secondsLeft(ctx.store.state)}s`;
    },
  };
}
