import type { RouteView } from "@aedm/schemas";

/**
 * The offline mock's campaign route: the town in the middle with the crypt and the trail beside it (three places). It builds the
 * same view shape as the engine's `routeView`: visited places and their neighbours only, exits named as the mock maps name them.
 */
interface MockPlace {
  scene: string;
  node: string;
  name: string;
  summary: string;
  x: number;
  y: number;
  links: string[];
  /** The exit of the place's own map that leads to each linked scene: its name on the map and its side. */
  exits: Record<string, { label: string; side: "east" | "west" | "north" | "south" }>;
}

export const MOCK_PLACES: MockPlace[] = [
  {
    scene: "m_hollowmere", node: "r_town", name: "Hollowmere", summary: "A fogbound village where the sleepwalkers gather.", x: 0, y: 40, links: ["m_crypt", "m_trail"],
    exits: { m_crypt: { label: "crypt_stairs", side: "west" }, m_trail: { label: "snowy_trail", side: "east" } },
  },
  {
    scene: "m_crypt", node: "r_crypt", name: "Drowned Crypt", summary: "Cold steps below the reeds, and a lantern that should not be lit.", x: 120, y: 0, links: ["m_hollowmere"],
    exits: { m_hollowmere: { label: "stairs_up", side: "west" } },
  },
  {
    scene: "m_trail", node: "r_trail", name: "Frostfang Trail", summary: "A snowbound track out of the valley.", x: 120, y: 80, links: ["m_hollowmere"],
    exits: { m_hollowmere: { label: "road_to_town", side: "west" } },
  },
];

/** Where each open mock milestone is: the town for the people, the crypt and the trail for the places. */
const MILESTONE_SCENE: Record<string, string> = {
  m_odalys: "m_hollowmere", m_choir: "m_hollowmere", m_crypt: "m_crypt", m_trail: "m_trail", m_light: "m_crypt",
};

/** The route view for the party standing in `current`, having been to `visited`, with `openMilestones` still to do. */
export function mockRouteView(current: string, visited: readonly string[], openMilestones: readonly string[]): RouteView {
  const seen = new Set([...visited, current]);
  const shown = new Set(seen);
  for (const p of MOCK_PLACES) if (seen.has(p.scene)) for (const l of p.links) shown.add(l);
  const here = MOCK_PLACES.find((p) => p.scene === current);
  const nodes = MOCK_PLACES.filter((p) => shown.has(p.scene)).map((p) => {
    const exit = here?.exits[p.scene];
    return {
      id: p.node, name: p.name, state: p.scene === current ? ("current" as const) : seen.has(p.scene) ? ("visited" as const) : ("known" as const),
      ...(seen.has(p.scene) ? { summary: p.summary } : {}), x: p.x, y: p.y, ...(exit ? { exit } : {}),
    };
  });
  // every mock link is two-way, so each pair is listed once, from the lower scene id
  const node = (scene: string) => MOCK_PLACES.find((q) => q.scene === scene)!.node;
  const edges = MOCK_PLACES.flatMap((p) => p.links.filter((l) => p.scene < l && shown.has(p.scene) && shown.has(l)).map((l) => ({ a: p.node, b: node(l) })));
  const markers = openMilestones.flatMap((id) => {
    const place = MOCK_PLACES.find((p) => p.scene === MILESTONE_SCENE[id]);
    return place && shown.has(place.scene) ? [{ milestone_id: id, node: place.node }] : [];
  });
  return { nodes, edges, markers, current: here?.node ?? null };
}
