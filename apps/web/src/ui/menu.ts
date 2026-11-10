import { h } from "../util/dom";

export interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  run?: () => void;
  /** Items shown in place of this menu when clicked (one level of nesting). */
  children?: MenuItem[];
}

let current: HTMLElement | null = null;
let offKey: (() => void) | null = null;

export function closeMenu(): void {
  current?.remove();
  current = null;
  offKey?.();
  offKey = null;
}

/** Small floating context menu at a client position. Labels are set as text. */
export function openMenu(title: string, items: MenuItem[], clientX: number, clientY: number): void {
  closeMenu();
  const el = h("div", { class: "ctx-menu", role: "menu" });
  const show = (heading: string, list: MenuItem[], back?: () => void) => {
    el.replaceChildren(
      h("div", { class: "ctx-title" }, back ? h("button", { type: "button", class: "ctx-back", onClick: back, "aria-label": "Back" }, "<") : null, heading),
      ...list.map((it) => h("button", {
        type: "button", role: "menuitem", class: "ctx-item", disabled: it.disabled,
        onClick: () => {
          if (it.children) show(it.label, it.children, () => show(title, items));
          else { closeMenu(); it.run?.(); }
        },
      }, h("span", null, it.label), it.hint ? h("small", null, it.hint) : null, it.children ? h("span", null, ">") : null)),
    );
  };
  show(title, items);
  document.body.appendChild(el);
  current = el;
  const r = el.getBoundingClientRect();
  const x = Math.max(8, Math.min(clientX + 6, window.innerWidth - r.width - 8));
  const y = Math.max(8, Math.min(clientY + 6, window.innerHeight - r.height - 8));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  const onDoc = (ev: Event) => { if (current && !current.contains(ev.target as Node)) closeMenu(); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") closeMenu(); };
  setTimeout(() => document.addEventListener("pointerdown", onDoc), 0);
  document.addEventListener("keydown", onKey);
  offKey = () => { document.removeEventListener("pointerdown", onDoc); document.removeEventListener("keydown", onKey); };
}
