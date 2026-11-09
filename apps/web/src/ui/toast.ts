import { h } from "../util/dom";

let host: HTMLElement | null = null;

export function toast(message: string, kind: "error" | "info" = "error"): void {
  if (!host) {
    host = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.appendChild(host);
  }
  // Collapse repeats of the same message instead of stacking copies.
  for (const child of Array.from(host.children)) {
    if (child.textContent === message) child.remove();
  }
  const el = h("div", { class: `toast ${kind}` }, message);
  host.appendChild(el);
  while (host.children.length > 4) host.firstElementChild?.remove();
  setTimeout(() => el.remove(), 4500);
}
