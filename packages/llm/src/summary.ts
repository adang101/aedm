import { escapeUntrusted } from "./context";
import type { CallOptions } from "./pipeline";
import { MAX_OUTPUT_TOKENS, type ModelProvider } from "./provider";
import { loadPrompt } from "./template";

/** Compresses older turns (plus the previous summary) into a short running summary. Plain text out. */
export async function summarizeTurns(
  provider: ModelProvider,
  input: { previousSummary: string; turns: { speaker: string; text: string }[] },
  opts: CallOptions = {},
): Promise<string> {
  const user = [
    `<previous_summary>\n${escapeUntrusted(input.previousSummary, 2000) || "(none)"}\n</previous_summary>`,
    `<turns>\n${input.turns.map((t) => `${t.speaker.replace(/[<>\n]/g, " ")}: ${escapeUntrusted(t.text, 600)}`).join("\n")}\n</turns>`,
  ].join("\n");
  const res = await provider.complete(
    { tier: "fast", system: loadPrompt("summary"), messages: [{ role: "user", content: user }], purpose: "summary", maxTokens: MAX_OUTPUT_TOKENS.summary },
    opts.signal ? { signal: opts.signal } : {},
  );
  return res.text.trim().split(/\s+/).slice(0, 200).join(" ");
}
