import { describe, expect, it } from "vitest";
import { createFakeProvider } from "./providers/fake";
import type { ModelRequest } from "./provider";
import { formatUsageLine, UsageLedger, withUsageLedger } from "./usage";

const req = (purpose: ModelRequest["purpose"]): ModelRequest => ({ tier: "fast", system: "sys prompt", messages: [{ role: "user", content: "hello there" }], purpose });

describe("UsageLedger", () => {
  it("aggregates per purpose and in total", () => {
    const l = new UsageLedger();
    l.record("dm", { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 });
    l.record("dm", { inputTokens: 200, outputTokens: 20 });
    l.record("repair", undefined);
    const s = l.summary();
    expect(s.byPurpose.dm).toEqual({ calls: 2, inputTokens: 300, outputTokens: 30, cacheReadTokens: 50 });
    expect(s.byPurpose.repair).toEqual({ calls: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    expect(s.total).toEqual({ calls: 3, inputTokens: 300, outputTokens: 30, cacheReadTokens: 50 });
    l.reset();
    expect(l.summary().total.calls).toBe(0);
  });
  it("formats a compact line without prompt text", () => {
    expect(formatUsageLine("dm", { inputTokens: 1234, outputTokens: 210, cacheReadTokens: 900 })).toBe("[llm] dm in=1234 out=210 cache=900");
  });
});

describe("withUsageLedger", () => {
  it("records every call including repair and passes responses through", async () => {
    const inner = createFakeProvider(["one", "two"]);
    const ledger = new UsageLedger();
    const seen: string[] = [];
    const p = withUsageLedger(inner, ledger, (purpose) => seen.push(purpose));
    expect(p.name).toBe("fake");
    const a = await p.complete(req("dm"));
    const b = await p.complete(req("repair"));
    expect(a.text).toBe("one");
    expect(b.text).toBe("two");
    expect(a.usage?.inputTokens).toBeGreaterThan(0);
    expect(ledger.summary().byPurpose.dm?.calls).toBe(1);
    expect(ledger.summary().byPurpose.repair?.calls).toBe(1);
    expect(seen).toEqual(["dm", "repair"]);
  });
  it("does not record failed calls and rethrows", async () => {
    const ledger = new UsageLedger();
    const p = withUsageLedger(createFakeProvider([new Error("boom")]), ledger);
    await expect(p.complete(req("dm"))).rejects.toThrow("boom");
    expect(ledger.summary().total.calls).toBe(0);
  });
});
