import { h } from "../util/dom";

let host: HTMLElement | null = null;

export function toast(message: string, kind: "error" | "info" = "error"): void {
  if (!host) {
    host = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.appendChild(host);
  }
  const el = h("div", { class: `toast ${kind}` }, message);
  host.appendChild(el);
  while (host.children.length > 4) host.firstElementChild?.remove();
  setTimeout(() => el.remove(), 4500);
}
