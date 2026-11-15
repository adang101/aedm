import type { ObjectiveView } from "@aedm/schemas";

/** A small three-stage plot for the offline mock, with the same view shape the real server sends. */
interface MockStage { id: string; title: string; goal: string; milestones: { id: string; hint: string }[] }

export const MOCK_STAGES: MockStage[] = [
  {
    id: "st_village", title: "The Humming Village",
    goal: "Find out why the villagers of Hollowmere sleepwalk toward the marsh, and deal with whoever is singing.",
    milestones: [
      { id: "m_odalys", hint: "Talk to Odalys at the inn" },
      { id: "m_choir", hint: "Stop the grey-robed singers in the square" },
    ],
  },
  {
    id: "st_below", title: "Beneath the Marsh",
    goal: "The humming leads below the reeds. Follow it to the places the choir came from.",
    milestones: [
      { id: "m_crypt", hint: "Reach the Drowned Crypt" },
      { id: "m_trail", hint: "Scout the Frostfang Trail" },
    ],
  },
  {
    id: "st_lantern", title: "The Last Lantern",
    goal: "Whatever the lantern was keeping out has been waking up. End it before the next bell.",
    milestones: [{ id: "m_light", hint: "Light the Drowned Lantern in the crypt" }],
  },
];

export interface ObjectiveChange { view: ObjectiveView; completed: { id: string; hint: string; done: true }[] }

/** Tracks which mock milestones are done. Only the current stage's milestones can complete, as in the engine. */
export class MockObjective {
  private done = new Set<string>();

  reset(): void { this.done.clear(); }

  private currentIndex(): number {
    const i = MOCK_STAGES.findIndex((st) => st.milestones.some((m) => !this.done.has(m.id)));
    return i < 0 ? MOCK_STAGES.length - 1 : i;
  }

  view(): ObjectiveView {
    const index = this.currentIndex();
    const st = MOCK_STAGES[index]!;
    const total = MOCK_STAGES.reduce((n, x) => n + x.milestones.length, 0);
    return {
      stage: { id: st.id, index, count: MOCK_STAGES.length, title: st.title, goal: st.goal },
      milestones: st.milestones.map((m) => ({ id: m.id, hint: m.hint, done: this.done.has(m.id) })),
      progress: { done: this.done.size, total },
      finished: MOCK_STAGES.every((x) => x.milestones.every((m) => this.done.has(m.id))),
    };
  }

  /** Complete one milestone of the current stage. Returns null when it is not open (wrong stage, unknown, done). */
  complete(id: string): ObjectiveChange | null {
    const st = MOCK_STAGES[this.currentIndex()]!;
    const m = st.milestones.find((x) => x.id === id);
    if (!m || this.done.has(id)) return null;
    this.done.add(id);
    return { view: this.view(), completed: [{ id: m.id, hint: m.hint, done: true }] };
  }

  /** Complete the first open milestone (a dev shortcut for trying the tracker). */
  completeNext(): ObjectiveChange | null {
    const open = this.view().milestones.find((m) => !m.done);
    return open ? this.complete(open.id) : null;
  }
}
