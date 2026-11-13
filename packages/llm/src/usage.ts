import type { ModelProvider, ModelPurpose, ModelRequest, ModelResponse } from "./provider";

export interface PurposeUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface UsageSummary {
  byPurpose: Partial<Record<ModelPurpose, PurposeUsage>>;
  total: PurposeUsage;
}

const zero = (): PurposeUsage => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });

/** Accumulates `ModelResponse.usage` per purpose. A response with no usage still counts as a call. */
export class UsageLedger {
  private readonly rows = new Map<ModelPurpose, PurposeUsage>();

  record(purpose: ModelPurpose, usage: ModelResponse["usage"]): void {
    let row = this.rows.get(purpose);
    if (!row) {
      row = zero();
      this.rows.set(purpose, row);
    }
    row.calls += 1;
    row.inputTokens += usage?.inputTokens ?? 0;
    row.outputTokens += usage?.outputTokens ?? 0;
    row.cacheReadTokens += usage?.cacheReadTokens ?? 0;
  }

  summary(): UsageSummary {
    const byPurpose: UsageSummary["byPurpose"] = {};
    const total = zero();
    for (const [purpose, row] of this.rows) {
      byPurpose[purpose] = { ...row };
      total.calls += row.calls;
      total.inputTokens += row.inputTokens;
      total.outputTokens += row.outputTokens;
      total.cacheReadTokens += row.cacheReadTokens;
    }
    return { byPurpose, total };
  }

  reset(): void {
    this.rows.clear();
  }
}

/** One compact log line, for example `[llm] dm in=1234 out=210 cache=900`. Never includes prompt text. */
export function formatUsageLine(purpose: ModelPurpose, usage: ModelResponse["usage"]): string {
  return `[llm] ${purpose} in=${usage?.inputTokens ?? "?"} out=${usage?.outputTokens ?? "?"} cache=${usage?.cacheReadTokens ?? 0}`;
}

/** Wraps a provider so every completed call (repair calls included) is recorded; behaviour is otherwise unchanged. */
export function withUsageLedger(
  provider: ModelProvider,
  ledger: UsageLedger,
  onCall?: (purpose: ModelPurpose, usage: ModelResponse["usage"], req: ModelRequest) => void,
): ModelProvider {
  return {
    name: provider.name,
    async complete(req, opts) {
      const res = await provider.complete(req, opts);
      ledger.record(req.purpose, res.usage);
      onCall?.(req.purpose, res.usage, req);
      return res;
    },
  };
}
