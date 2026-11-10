import { DmActionSchema, DmResponseLooseSchema, DmResponseSchema, type DmAction, type DmResponse } from "@aedm/schemas";
import { buildDmContext, type DmContextPack } from "./context";
import { extractJson, formatZodError, truncate } from "./json";
import { NarrationExtractor } from "./narration-stream";
import { completeWithRepair } from "./pipeline";
import type { ModelProvider, Tier } from "./provider";
import { LlmError } from "./errors";

export interface DmTurnOptions {
  tier?: Tier;
  /** Route to the strong tier (the previous response had high_stakes: true). */
  highStakes?: boolean;
  /** Called with narration text as it streams from the first model call. */
  onNarration?: (delta: string) => void;
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface DmTurnResult {
  response: DmResponse;
  /** A repair call was made. */
  repaired: boolean;
  /** The strict schema never passed and the response was assembled from valid pieces. */
  salvaged: boolean;
  droppedActions: { raw: unknown; error: string }[];
  rawText: string;
  model: string;
  /** Narration delivered through onNarration. If the repair call changed it, send response.narration instead. */
  streamedNarration: string;
  calls: number;
}

export const MAX_NARRATION_WORDS = 150;

export function clampNarration(text: string, maxWords = MAX_NARRATION_WORDS): string {
  const clean = text.replace(/<\/?[a-zA-Z][^>]*>/g, "").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return clean;
  const cut = words.slice(0, maxWords).join(" ");
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf('." '));
  if (end > 0 && cut.slice(0, end + 1).split(/\s+/).length >= 40) return cut.slice(0, end + 1);
  return cut;
}

export async function runDmTurn(provider: ModelProvider, pack: DmContextPack, opts: DmTurnOptions = {}): Promise<DmTurnResult> {
  const { system, user } = buildDmContext(pack);
  const tier: Tier = opts.tier ?? (opts.highStakes ? "strong" : "standard");
  const extractor = new NarrationExtractor();
  let streamed = "";
  const onText = (delta: string) => {
    const n = extractor.push(delta);
    if (n !== "") {
      streamed += n;
      opts.onNarration?.(n);
    }
  };

  const outcome = await completeWithRepair(
    provider,
    { tier, system, messages: [{ role: "user", content: user }], purpose: "dm", ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}) },
    DmResponseSchema,
    { signal: opts.signal, onText },
  );

  if (outcome.ok) {
    return {
      response: outcome.data, repaired: outcome.repaired, salvaged: false, droppedActions: [],
      rawText: outcome.rawText, model: outcome.model, streamedNarration: streamed, calls: outcome.calls,
    };
  }

  const salvage = salvageDmResponse(outcome.texts);
  if (!salvage) {
    throw new LlmError(
      `DM reply was not usable JSON after repair: ${truncate(outcome.errors, 300)}`, "invalid_output", true,
    );
  }
  return {
    response: salvage.response, repaired: true, salvaged: true, droppedActions: salvage.dropped,
    rawText: outcome.rawText, model: outcome.model, streamedNarration: streamed, calls: outcome.calls,
  };
}

/**
 * Last resort: keep whatever is individually valid. Tries the latest reply first, then earlier ones.
 * Narration is trimmed to 150 words (never padded); invalid actions are dropped and reported.
 */
export function salvageDmResponse(
  texts: string[],
): { response: DmResponse; dropped: { raw: unknown; error: string }[] } | undefined {
  for (const text of [...texts].reverse()) {
    const json = extractJson(text);
    const loose = json === undefined ? undefined : DmResponseLooseSchema.safeParse(json);
    if (!loose?.success) continue;
    const raw = loose.data as Record<string, unknown>;

    const actions: DmAction[] = [];
    const dropped: { raw: unknown; error: string }[] = [];
    for (const a of loose.data.actions) {
      const r = DmActionSchema.safeParse(a);
      if (r.success && actions.length < 8) actions.push(r.data);
      else if (r.success) dropped.push({ raw: a, error: "more than 8 actions" });
      else dropped.push({ raw: a, error: formatZodError(r.error, 4) });
    }
    const importance = typeof raw.importance === "number" && Number.isInteger(raw.importance)
      ? Math.min(5, Math.max(1, raw.importance)) : 2;
    const notes = typeof raw.dm_notes === "string" ? raw.dm_notes.trim().split(/\s+/).slice(0, 100).join(" ") : "";
    const response: DmResponse = {
      v: 1,
      narration: clampNarration(loose.data.narration),
      actions,
      importance,
      high_stakes: raw.high_stakes === true,
      ...(notes ? { dm_notes: notes } : {}),
    };
    return { response, dropped };
  }
  return undefined;
}
