import type { ContainerView } from "@aedm/schemas";
import { myEntity, type AppState } from "../state/store";
import { h, replaceChildren } from "../util/dom";
import { REACH, cheb, verbsFor } from "../util/interact";
import type { Ctx } from "./types";

export interface ContainerPanel {
  el: HTMLElement;
  update(s: AppState): void;
}

const KIND_LABEL: Record<string, string> = { chest: "Chest", pile: "Pile of items", remains: "Remains", pockets: "Pockets" };

/** Whether the panel should close: the container is gone, or I have walked out of reach of it. */
export function shouldClose(s: AppState, seenSummary: boolean): boolean {
  const v = s.containerView;
  if (!v) return false;
  const c = s.containers[v.container_id];
  if (!c) return seenSummary;
  const me = myEntity(s);
  return !!me && cheb(me, c) > REACH;
}

/** True when the summary says the contents changed since `view` was sent, so the panel should ask again. */
export function viewIsStale(s: AppState): boolean {
  const v = s.containerView;
  const c = v ? s.containers[v.container_id] : undefined;
  return !!v && !!c && (v.items.length !== c.item_count || v.locked !== c.locked);
}

/** Floating panel listing what is in the container I opened, with Take, Take all and Close. Text only, no markup from the server. */
export function createContainerPanel(ctx: Ctx): ContainerPanel {
  const { client, store } = ctx;
  const body = h("div", { class: "stack" });
  const el = h("section", { class: "loot-panel", role: "dialog", "aria-label": "Container", hidden: true }, body);
  let shownKey = "";
  let seenSummary = false;
  let seenId = "";
  let askedFor = "";

  el.addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Escape") { ev.stopPropagation(); close(); } });

  function close(): void {
    if (store.state.containerView) store.update((s) => { s.containerView = null; });
  }

  function render(s: AppState, v: ContainerView): void {
    const c = s.containers[v.container_id];
    const title = v.label ?? KIND_LABEL[v.kind] ?? "Container";
    const closeBtn = h("button", { type: "button", class: "btn tiny ghost", onClick: close }, "Close");
    const head = h("div", { class: "row between" },
      h("h2", null, title),
      h("div", { class: "row" }, v.locked ? h("span", { class: "badge locked" }, "Locked") : null, closeBtn));
    if (v.locked) {
      const lockVerbs = c?.object_id
        ? verbsFor({ type: "interactable", id: c.object_id, kind: "chest", state: "locked", x: c.x, y: c.y })
          .filter((o) => o.verb === "unlock" || o.verb === "pick_lock" || o.verb === "force")
        : [];
      replaceChildren(body, head,
        h("p", { class: "muted" }, "It is locked. Find the key, pick the lock or force it."),
        lockVerbs.length ? h("div", { class: "row wrap" }, ...lockVerbs.map((o) => h("button", {
          type: "button", class: "btn tiny", onClick: () => client.send("act", { verb: o.verb as "unlock", target_id: o.target_id }),
        }, o.label))) : null);
      return;
    }
    const list = v.items.length === 0
      ? h("p", { class: "muted" }, "Nothing here.")
      : h("ul", { class: "inv loot-list" }, ...v.items.map((i) => h("li", null,
        h("div", { class: "loot-name" }, h("span", null, i.name),
          h("small", { class: "muted" }, `${i.kind}${i.tier ? ` T${i.tier}` : ""}, ${i.value} gp`)),
        h("button", {
          type: "button", class: "btn tiny take", "aria-label": `Take ${i.name}`,
          onClick: () => client.send("container_action", { verb: "take", container_id: v.container_id, item_id: i.id }),
        }, "Take"))));
    replaceChildren(body, head, list,
      h("div", { class: "row between" },
        h("small", { class: "muted" }, `${v.items.length} ${v.items.length === 1 ? "item" : "items"}`),
        h("button", {
          type: "button", class: "btn tiny primary take-all", disabled: v.items.length === 0,
          onClick: () => client.send("container_action", { verb: "take_all", container_id: v.container_id }),
        }, "Take all")));
  }

  function update(s: AppState): void {
    const v = s.containerView;
    if (!v) { el.hidden = true; shownKey = ""; seenSummary = false; seenId = ""; askedFor = ""; return; }
    if (v.container_id !== seenId) { seenId = v.container_id; seenSummary = false; askedFor = ""; }
    if (s.containers[v.container_id]) seenSummary = true;
    if (shouldClose(s, seenSummary)) { close(); return; }
    if (viewIsStale(s)) {
      const c = s.containers[v.container_id]!;
      const sig = `${c.item_count}|${c.locked}`;
      if (askedFor !== sig) { askedFor = sig; client.send("container_action", { verb: "open", container_id: v.container_id }); }
    } else askedFor = "";
    const key = JSON.stringify(v);
    if (key === shownKey && !el.hidden) return;
    const hadFocus = el.contains(document.activeElement);
    const fresh = el.hidden || !shownKey || JSON.parse(shownKey).container_id !== v.container_id;
    shownKey = key;
    render(s, v);
    el.hidden = false;
    if (hadFocus || fresh) (el.querySelector<HTMLElement>(".take") ?? el.querySelector<HTMLElement>("button"))?.focus();
  }

  return { el, update };
}
