/**
 * Dependency-free, deterministic token estimator.
 *
 * This is an ESTIMATE, not a tokenizer: it exists so prompt and context size can be tracked and
 * regression-tested offline. Real providers report exact counts in `ModelResponse.usage`.
 *
 * Heuristic: prose averages about 4 characters per token; punctuation and symbols (heavy in JSON and
 * tag-structured prompts) tend to cost about one token each; digits cost about one token per 2 chars;
 * runs of whitespace are mostly absorbed into neighbouring tokens.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let wordChars = 0;
  let digits = 0;
  let symbols = 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127) wordChars++;
    else if (c === 10) newlines++;
    else if (c === 32 || c === 9 || c === 13) continue;
    else symbols++;
  }
  return Math.ceil(wordChars / 4 + digits / 2 + symbols * 0.8 + newlines * 0.5);
}

/** Estimated input tokens of a request's system prompt plus messages. */
export function estimateRequestTokens(req: { system: string; messages: { content: string }[] }): number {
  return estimateTokens(req.system) + req.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
}
