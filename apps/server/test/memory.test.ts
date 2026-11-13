import { describe, expect, it } from "vitest";
import { createFakeProvider, type ModelRequest } from "@aedm/llm";
import { absorbTurns, CHAPTERS_KEPT, EMPTY_MEMORY } from "../src/memory";

const turns = [{ speaker: "Brindle", text: "I open the door." }, { speaker: "DM", text: "It creaks." }];

/** Replies "chapter N" to chapter requests and "story K" to folds, recording every request. */
function recorder(opts: { failFold?: boolean; failChapter?: boolean } = {}) {
  const requests: ModelRequest[] = [];
  let chapters = 0;
  let folds = 0;
  const provider = createFakeProvider((req) => {
    requests.push(req);
    if (req.messages[0]!.content.includes("<chapter>")) {
      if (opts.failFold) throw new Error("boom");
      return `story ${++folds}`;
    }
    if (opts.failChapter) throw new Error("boom");
    return `chapter ${++chapters}`;
  });
  return { provider, requests };
}

describe("absorbTurns", () => {
  it("writes a chapter from only the new turns, on the fast tier, without changing the input", async () => {
    const { provider, requests } = recorder();
    const next = await absorbTurns(provider, { storySoFar: "Old story.", chapters: ["old chapter"] }, turns);
    expect(next).toEqual({ storySoFar: "Old story.", chapters: ["old chapter", "chapter 1"] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ tier: "fast", purpose: "summary" });
    const user = requests[0]!.messages[0]!.content;
    expect(user).toContain("Brindle: I open the door.");
    expect(user).not.toContain("old chapter");
    expect(user).not.toContain("Old story.");
    expect(EMPTY_MEMORY).toEqual({ storySoFar: "", chapters: [] });
  });

  it("folds the oldest chapter into the story so far once there would be too many", async () => {
    const { provider, requests } = recorder();
    let memory = EMPTY_MEMORY;
    for (let i = 0; i < CHAPTERS_KEPT; i++) memory = (await absorbTurns(provider, memory, turns))!;
    expect(memory.chapters).toEqual(["chapter 1", "chapter 2", "chapter 3", "chapter 4"]);
    expect(requests).toHaveLength(CHAPTERS_KEPT);

    memory = (await absorbTurns(provider, memory, turns))!;
    expect(memory).toEqual({ storySoFar: "story 1", chapters: ["chapter 2", "chapter 3", "chapter 4", "chapter 5"] });
    const fold = requests.at(-1)!;
    expect(fold).toMatchObject({ tier: "fast", purpose: "summary" });
    expect(fold.messages[0]!.content).toContain("<chapter>\nchapter 1\n</chapter>");
    expect(fold.messages[0]!.content).toContain("(none)");
  });

  it("returns null when the chapter call fails so the caller keeps its turns", async () => {
    expect(await absorbTurns(recorder({ failChapter: true }).provider, EMPTY_MEMORY, turns)).toBeNull();
  });

  it("keeps the extra chapter and the old story when the fold fails, and folds it next time", async () => {
    const full = { storySoFar: "Old story.", chapters: ["a", "b", "c", "d"] };
    const next = await absorbTurns(recorder({ failFold: true }).provider, full, turns);
    expect(next).toEqual({ storySoFar: "Old story.", chapters: ["a", "b", "c", "d", "chapter 1"] });
    const healed = await absorbTurns(recorder().provider, next!, turns);
    expect(healed).toEqual({ storySoFar: "story 2", chapters: ["c", "d", "chapter 1", "chapter 1"] });
  });

  it("drops an empty chapter instead of storing it", async () => {
    const empty = createFakeProvider(() => "  ");
    expect(await absorbTurns(empty, { storySoFar: "s", chapters: ["a"] }, turns)).toEqual({ storySoFar: "s", chapters: ["a"] });
  });
});
