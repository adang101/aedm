import { describe, expect, it } from "vitest";
import { LlmError, type ModelProvider } from "@aedm/llm";
import { forgeCharacterAbilities, forgeOneAbility, ForgeError } from "../src/forge";

const refusing: ModelProvider = {
  name: "refusing",
  complete: async () => { throw new LlmError("Model provider error (403): Requests from referer <empty> are blocked.", "api", false, { status: 403 }); },
};
const sleep = async (): Promise<void> => {};

describe("forge model failures", () => {
  it("reports the provider error to the host and tells the player to try again, not to reword", async () => {
    const seen: unknown[] = [];
    const create = { name: "Ash", title: "Ranger", description: "", ability_texts: ["Arrow volley"] } as unknown as Parameters<typeof forgeCharacterAbilities>[1];
    const err = await forgeCharacterAbilities(refusing, create, { sleep, retryBackoffMs: 0, onModelError: (e) => seen.push(e) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as Error).message).toContain("Try again in a moment");
    expect((err as Error).message).not.toContain("rewording");
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toContain("403");
  });

  it("reports level-up forge failures too", async () => {
    const seen: unknown[] = [];
    await expect(forgeOneAbility(refusing, { concept: "x", text: "y", level: 2, maxCost: 100 }, { sleep, retryBackoffMs: 0, onModelError: (e) => seen.push(e) }))
      .rejects.toBeInstanceOf(ForgeError);
    expect(seen).toHaveLength(1);
  });
});
