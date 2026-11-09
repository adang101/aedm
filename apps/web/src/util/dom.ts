/** Tiny DOM helpers. Strings are always inserted as text nodes, never parsed as HTML. */
export type Child = Node | string | number | null | undefined | false;
export type Props = Record<string, unknown>;

const PROP_KEYS = new Set(["value", "checked", "disabled", "selected", "textContent", "className", "title", "placeholder"]);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val === undefined || val === null || val === false) continue;
      if (key === "class") el.className = String(val);
      else if (key === "style") el.setAttribute("style", String(val));
      else if (key.startsWith("on") && typeof val === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), val as EventListener);
      } else if (PROP_KEYS.has(key)) (el as unknown as Record<string, unknown>)[key] = val;
      else if (val === true) el.setAttribute(key, "");
      else el.setAttribute(key, String(val));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replaceChildren(el: Node, ...children: Child[]): void {
  clear(el);
  append(el, children);
}
