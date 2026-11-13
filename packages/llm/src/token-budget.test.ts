import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDmContext } from "./context";
import { buildEnemyPrompt } from "./enemy";
import { buildForgePrompt } from "./forge";
import { CONTEXT_PACKS } from "./fixtures/context-packs";
import { buildSpriteDesignerPrompt } from "./sprite-designer";
import { loadPrompt, renderPrompt } from "./template";
import { estimateTokens } from "./tokens";

/**
 * Token budget regression test. Ceilings live in packages/llm/token-budgets.json (current value + 5%).
 * Lower a ceiling when you shrink a prompt; never raise one without saying why.
 * Run `pnpm tokens` to print the table.
 */
const budgets = JSON.parse(readFileSync(new URL("../token-budgets.json", import.meta.url), "utf8")) as Record<string, number>;

const forge = buildForgePrompt({
  concept: "a lantern that burns blue and reveals hidden doors", abilityText: "Blue Lantern: reveal hidden things within 4 tiles", level: 3,
  allowedTags: ["light", "utility", "detection"], caps: { maxAvg: 8, maxRadius: 3, maxDuration: 3 },
});
const enemy = buildEnemyPrompt({
  concept: "a gaunt marsh-priest with a blue lantern", role: "elite", settingNotes: "Hollowmere marsh, dusk", partyLevel: 3,
  ranges: { hp: [20, 30], defense: [12, 15], attackBonus: [3, 5], damagePerRound: [6, 9] },
});
const sprite = buildSpriteDesignerPrompt({ concept: "a gaunt marsh-priest", role: "enemy", name: "Reed Priest" });

const measured: Record<string, number> = {};
for (const [name, pack] of Object.entries(CONTEXT_PACKS)) {
  const ctx = buildDmContext(pack);
  measured[`dm.user.${name}`] = estimateTokens(ctx.user);
  measured[`dm.total.${name}`] = estimateTokens(ctx.system) + estimateTokens(ctx.user);
}
measured["system.dm"] = estimateTokens(buildDmContext(CONTEXT_PACKS.opening).system);
measured["system.forge"] = estimateTokens(forge.system);
measured["system.enemy"] = estimateTokens(enemy.system);
measured["system.bible"] = estimateTokens(loadPrompt("story-bible"));
measured["system.summary"] = estimateTokens(loadPrompt("summary"));
measured["system.sprite"] = estimateTokens(sprite.system);
measured["system.repair"] = estimateTokens(renderPrompt("repair", { errors: "- field: expected string, received number" }));

describe("token budgets", () => {
  it("prints a report when AEDM_TOKEN_REPORT=1", () => {
    if (process.env.AEDM_TOKEN_REPORT !== "1") return;
    console.table(Object.entries(measured).map(([key, tokens]) => ({ key, tokens, ceiling: budgets[key] ?? "-" })));
  });

  it("has a ceiling for every measurement", () => {
    expect(Object.keys(budgets).sort()).toEqual(Object.keys(measured).sort());
  });

  it.each(Object.keys(measured))("%s stays within its ceiling", (key) => {
    expect(measured[key]).toBeGreaterThan(0);
    expect(measured[key]).toBeLessThanOrEqual(budgets[key]!);
  });

  it("orders the packs opening < typical < heavy", () => {
    expect(measured["dm.user.opening"]).toBeLessThan(measured["dm.user.typical"]!);
    expect(measured["dm.user.typical"]).toBeLessThan(measured["dm.user.heavy"]!);
  });
});
