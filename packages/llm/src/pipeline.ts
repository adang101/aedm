import { extractJson, formatZodError, type ZodIssueLike } from "./json";
import type { ModelProvider, ModelRequest, ModelResponse } from "./provider";
import { renderPrompt } from "./template";

/** Anything with a Zod-style safeParse (all schemas from @aedm/schemas qualify). */
export interface SafeParser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly ZodIssueLike[] } };
}

export interface CallOptions {
  signal?: AbortSignal | undefined;
  /** Streams text of the FIRST call only (a repair call is never streamed). */
  onText?: ((delta: string) => void) | undefined;
  /**
   * What the repair call resends. "full" (default): the whole conversation plus the bad reply and the errors.
   * "minimal": only the system prompt (cached), the bad reply and the errors. Use it for schema-only repairs whose
   * input is large (the DM context), where the errors alone tell the model what to fix.
   */
  repairContext?: "full" | "minimal" | undefined;
}

/** Longest bad reply echoed back in a minimal repair (characters). */
export const MAX_REPAIR_ECHO = 8000;

export type ParseOutcome<T> =
  | { ok: true; data: T; repaired: boolean; rawText: string; model: string; calls: number; responses: ModelResponse[] }
  | { ok: false; errors: string; repaired: boolean; rawText: string; texts: string[]; model: string; calls: number; responses: ModelResponse[] };

/** Parses model text into T, or returns the bullet-point reason it failed. */
export function parseText<T>(text: string, schema: SafeParser<T>): { ok: true; data: T } | { ok: false; errors: string } {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, errors: "- (root): no JSON object found in the reply" };
  const r = schema.safeParse(json);
  return r.success ? { ok: true, data: r.data } : { ok: false, errors: formatZodError(r.error) };
}

/**
 * One call, parse with Zod, and at most ONE repair call that sends the validation errors back.
 * Never makes more than 2 provider calls.
 */
export async function completeWithRepair<T>(
  provider: ModelProvider,
  req: ModelRequest,
  schema: SafeParser<T>,
  opts: CallOptions = {},
  accept?: (data: T) => string | undefined,
): Promise<ParseOutcome<T>> {
  const check = (text: string) => {
    const p = parseText(text, schema);
    if (p.ok && accept) {
      const err = accept(p.data);
      if (err !== undefined) return { ok: false as const, errors: err };
    }
    return p;
  };
  const callOpts = { signal: opts.signal, onText: opts.onText } as { signal?: AbortSignal; onText?: (d: string) => void };
  const first = await provider.complete(req, callOpts);
  const p1 = check(first.text);
  if (p1.ok) {
    return { ok: true, data: p1.data, repaired: false, rawText: first.text, model: first.model, calls: 1, responses: [first] };
  }

  const badReply = first.text.trim() === "" ? "(empty reply)" : first.text;
  const repairText = renderPrompt("repair", { errors: p1.errors });
  const repairReq: ModelRequest = {
    ...req,
    purpose: "repair",
    messages: opts.repairContext === "minimal"
      ? [{ role: "user", content: `<previous_reply>\n${badReply.slice(0, MAX_REPAIR_ECHO)}\n</previous_reply>\n\n${repairText}` }]
      : [...req.messages, { role: "assistant", content: badReply }, { role: "user", content: repairText }],
  };
  const second = await provider.complete(repairReq, opts.signal ? { signal: opts.signal } : {});
  const p2 = check(second.text);
  const responses = [first, second];
  if (p2.ok) {
    return { ok: true, data: p2.data, repaired: true, rawText: second.text, model: second.model, calls: 2, responses };
  }
  return {
    ok: false, errors: p2.errors, repaired: true, rawText: second.text, texts: [first.text, second.text],
    model: second.model, calls: 2, responses,
  };
}
