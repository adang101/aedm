import type { AppState, LogEntry } from "../state/store";
import { nameOf } from "../state/store";
import { h, replaceChildren } from "../util/dom";

const OUTCOME_LABEL = { success: "Success", failure: "Failure", crit: "Critical!", fumble: "Fumble" } as const;

function render(e: LogEntry, s: AppState): HTMLElement {
  switch (e.kind) {
    case "narration":
      return h("div", { class: "entry narration" }, h("p", null, e.text, e.done ? null : h("span", { class: "cursor" }, "|")));
    case "roll": {
      const r = e.roll!;
      const mod = r.modifier === 0 ? null : h("span", { class: "mod" }, r.modifier > 0 ? `+${r.modifier}` : `${r.modifier}`);
      return h("div", { class: `entry roll ${r.outcome}` },
        h("div", { class: "roll-head" }, h("b", null, nameOf(s, r.who)), h("span", { class: "muted" }, ` ${r.label}`)),
        h("div", { class: "roll-body" },
          ...r.dice.map((d) => h("span", { class: "die" }, d)), mod,
          h("span", { class: "total" }, `= ${r.total}`),
          r.target > 0 ? h("span", { class: "muted" }, `vs ${r.target}`) : null,
          r.target > 0 || r.outcome === "crit" || r.outcome === "fumble" ? h("span", { class: "pill" }, OUTCOME_LABEL[r.outcome]) : null),
      );
    }
    case "chat":
      return h("div", { class: `entry chat ${e.channel ?? "ic"}` },
        e.channel === "ooc" ? h("span", { class: "tag" }, "OOC") : null,
        e.channel === "system" ? null : h("b", { class: "who" }, e.who ?? "?"),
        " ", h("span", null, e.text));
    default:
      return h("div", { class: `entry sys ${e.kind}` }, e.text);
  }
}

export interface LogView {
  el: HTMLElement;
  update(s: AppState): void;
}

/** Story log. Entries are appended once and only re-rendered when their revision changes. */
export function createLog(): LogView {
  const el = h("div", { class: "log", role: "log", "aria-live": "polite" });
  const nodes = new Map<string, { node: HTMLElement; rev: number }>();
  return {
    el,
    update(s) {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      const keys = new Set<string>();
      let changed = false;
      for (const e of s.log) {
        keys.add(e.key);
        const cur = nodes.get(e.key);
        if (!cur) {
          const node = render(e, s);
          el.appendChild(node);
          nodes.set(e.key, { node, rev: e.rev });
          changed = true;
        } else if (cur.rev !== e.rev || (e.kind === "narration" && !e.done)) {
          const node = render(e, s);
          cur.node.replaceWith(node);
          nodes.set(e.key, { node, rev: e.rev });
          changed = true;
        }
      }
      for (const [k, v] of nodes) if (!keys.has(k)) { v.node.remove(); nodes.delete(k); changed = true; }
      if (s.log.length === 0 && !el.firstChild) replaceChildren(el);
      if (changed && nearBottom) el.scrollTop = el.scrollHeight;
    },
  };
}
