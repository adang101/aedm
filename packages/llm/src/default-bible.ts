import type { PlotArc, PlotPattern, StoryBible } from "@aedm/schemas";
import { buildPlot } from "@aedm/engine";

const LANTERN_MARSH_MILESTONES = [
  "The party learns the cult's name: the Quiet Choir.",
  "The party finds out what became of Edda Marrow.",
  "The party reaches the place where the sleepers gather in the marsh.",
  "The party survives the Choir's counterstroke and learns how the borrowed voices can be silenced.",
  "The party ends the Choir's hold on the marsh and the sleepers wake.",
];

/**
 * The Lantern Marsh, from docs/spike-kit.md, with a plot plan of the requested pattern and arc (default: overcoming the
 * monster, into the pit and out). One milestone per stage. Used when bible generation fails and by the fake provider.
 */
export function lanternMarshBible(pattern: PlotPattern = "overcoming_the_monster", arc: PlotArc = "fall_rise"): StoryBible {
  const plot = buildPlot(pattern, arc);
  return {
    title: "The Lantern Marsh",
    digest:
      "The Lantern Marsh is a drowned coastal region where fog and tide hide old secrets. Eleven days ago the lighthouse keeper of Hollowmere, Edda Marrow, vanished. Villagers now walk toward the marsh in their sleep. A smuggling guild, the Tidewrights, wants the lighthouse cellar sealed. A cult called the Quiet Choir borrows the voices of the drowned and is gathering sleepers. Act 1 goal: learn what happened to Edda and why the sleepers walk. The party starts in Hollowmere's square at dusk.",
    tone: "Eerie, grounded, a little wry.",
    acts: [
      { title: "The Sleepers of Hollowmere", goal: "Learn what happened to Edda Marrow and why the villagers sleepwalk toward the marsh." },
      { title: "The Quiet Choir", goal: "Find the cult's gathering place and decide whether to stop it or bargain with the Tidewrights." },
    ],
    plot,
    milestones: plot.stages.map((st, i) => ({ id: `m${i + 1}`, description: LANTERN_MARSH_MILESTONES[i] as string, completed: false, stage: st.id })),
    quests: [
      { id: "q_edda", title: "Find Edda Marrow", status: "new", notes: [] },
      { id: "q_sleepers", title: "Why the sleepers walk", status: "new", notes: [] },
    ],
  };
}

export const LANTERN_MARSH_BIBLE: StoryBible = lanternMarshBible();

export const LANTERN_MARSH_FACTS = [
  { subject: "Hollow Pell", predicate: "is_alive", object: "false" },
  { subject: "Lighthouse door", predicate: "state", object: "locked; Edda's spare key hangs behind the bar at the inn" },
  { subject: "Odalys Brand", predicate: "disposition", object: "friendly" },
];
