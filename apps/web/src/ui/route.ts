import "./route.css";
import type { RouteNode } from "@aedm/schemas";
import type { AppState } from "../state/store";
import { routeAdvice, routeGeometry, stateLabel, wrapLabel } from "../state/route";
import { h, replaceChildren } from "../util/dom";
import type { Ctx } from "./types";

const NS = "http://www.w3.org/2000/svg";
const R = 15;

type Attrs = Record<string, string | number>;
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const k of kids) el.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
  return el;
}

export interface RoutePanel {
  el: HTMLElement;
  update(s: AppState): void;
}

/**
 * The route panel: the places the party knows as a small node map (current highlighted, visited solid, known outlined, a marker
 * where an objective waits) and, for the selected or hovered place, its summary and how to get there. Every name and summary is
 * model-written, so each is set as text (SVG text nodes and `textContent`), never as HTML.
 */
export function createRoutePanel(ctx: Ctx): RoutePanel {
  let selected: string | null = null;
  let hover: string | null = null;
  let last: AppState | null = null;

  const graph = h("div", { class: "route-graph" });
  const detail = h("div", { class: "route-detail", "aria-live": "polite" });
  const el = h("div", { class: "route-pane" }, graph, detail);

  function render(): void {
    const s = last;
    const view = s?.route;
    if (!s || !view) { replaceChildren(graph, h("p", { class: "muted" }, "No route yet.")); replaceChildren(detail); return; }
    if (selected && !view.nodes.some((n) => n.id === selected)) selected = null;
    const geo = routeGeometry(view, { pad: 54, minWidth: 260, minHeight: 150 });
    const focus = hover ?? selected ?? view.current;

    const root = svg("svg", {
      class: "route-svg", viewBox: `0 0 ${geo.width} ${geo.height}`, role: "group", "aria-label": "Route map",
      preserveAspectRatio: "xMidYMid meet", width: geo.width, height: geo.height,
    });
    const visitedIds = new Set(view.nodes.filter((n) => n.state !== "known").map((n) => n.id));
    for (const e of geo.edges) {
      const both = visitedIds.has(e.a) && visitedIds.has(e.b);
      root.appendChild(svg("line", { class: `route-edge${both ? "" : " open"}`, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 }));
    }
    for (const g of geo.nodes) {
      const n = g.node;
      const lines = wrapLabel(n.name);
      const label = svg("text", { class: "route-label", x: 0, y: R + 14, "text-anchor": "middle" });
      lines.forEach((ln, i) => label.appendChild(svg("tspan", { x: 0, dy: i === 0 ? 0 : 13 }, ln)));
      const group = svg("g", {
        class: `route-node ${n.state}${focus === n.id ? " focus" : ""}${g.marked ? " marked" : ""}`, transform: `translate(${g.cx} ${g.cy})`,
        tabindex: 0, role: "button", "aria-label": `${n.name}, ${stateLabel(n)}${g.marked ? ", an objective is here" : ""}`,
      },
      svg("title", {}, n.summary ? `${n.name}: ${n.summary}` : n.name),
      svg("circle", { class: "route-dot", r: R }),
      ...(n.state === "current" ? [svg("circle", { class: "route-ring", r: R + 5 })] : []),
      label,
      ...(g.marked ? [svg("g", { class: "route-flag", transform: `translate(${R - 2} ${-R + 2})` }, svg("circle", { r: 7 }), svg("text", { "text-anchor": "middle", y: 4 }, "!"))] : []));
      const pick = () => { selected = n.id; hover = null; render(); };
      group.addEventListener("click", pick);
      group.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
      group.addEventListener("mouseenter", () => { hover = n.id; renderDetail(); markFocus(); });
      group.addEventListener("mouseleave", () => { hover = null; renderDetail(); markFocus(); });
      root.appendChild(group);
    }
    replaceChildren(graph, root);
    renderDetail();
  }

  function markFocus(): void {
    const view = last?.route;
    if (!view) return;
    const focus = hover ?? selected ?? view.current;
    const ids = graph.querySelectorAll<SVGGElement>(".route-node");
    ids.forEach((g, i) => g.classList.toggle("focus", view.nodes[i]?.id === focus));
  }

  function renderDetail(): void {
    const s = last;
    const view = s?.route;
    if (!s || !view) return;
    const id = hover ?? selected ?? view.current;
    const node: RouteNode | undefined = view.nodes.find((n) => n.id === id);
    if (!node) { replaceChildren(detail, h("p", { class: "muted" }, "Select a place to see how to get there.")); return; }
    const advice = routeAdvice(view, node.id, s.map);
    const here = view.markers.filter((m) => m.node === node.id);
    const open = new Map((s.objective?.milestones ?? []).map((m) => [m.id, m.hint]));
    const walk = advice.walkTo;
    replaceChildren(detail,
      h("div", { class: "route-name" }, h("b", null, node.name), h("span", { class: `route-state ${node.state}` }, stateLabel(node))),
      node.summary ? h("p", { class: "route-summary" }, node.summary) : h("p", { class: "route-summary muted" }, "Not visited yet."),
      ...here.map((m) => h("p", { class: "route-objective" }, h("span", { class: "route-bang", "aria-hidden": "true" }, "!"), open.get(m.milestone_id) ?? "An objective is here.")),
      advice.text ? h("p", { class: "route-advice" }, advice.text) : null,
      walk ? h("button", {
        type: "button", class: "btn small primary",
        onClick: () => { ctx.client.send("move_intent", walk); ctx.toast(`Walking to the exit: ${node.name}`, "info"); },
      }, "Walk to the exit") : null);
  }

  return {
    el,
    update(s) { last = s; render(); },
  };
}
