/**
 * Pulls the outermost JSON object out of model output: strips code fences and surrounding prose,
 * and respects strings when matching braces. Returns undefined if there is no parseable object.
 */
export function extractJson(raw: string): unknown | undefined {
  const text = raw.trim();
  if (text === "") return undefined;

  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) candidates.push(m[1] ?? "");
  candidates.push(text);

  for (const c of candidates) {
    const obj = firstObject(c);
    if (obj !== undefined) return obj;
  }
  // Unclosed fence: ```json\n{...
  const open = /```(?:json|JSON)?\s*\n?([\s\S]*)$/.exec(text);
  if (open?.[1]) {
    const obj = firstObject(open[1]);
    if (obj !== undefined) return obj;
  }
  return undefined;
}

function firstObject(s: string): unknown | undefined {
  let from = s.indexOf("{");
  while (from !== -1) {
    const end = matchingBrace(s, from);
    if (end !== -1) {
      try {
        const v: unknown = JSON.parse(s.slice(from, end + 1));
        if (v !== null && typeof v === "object" && !Array.isArray(v)) return v;
      } catch {
        // fall through to the next "{"
      }
    }
    from = s.indexOf("{", from + 1);
  }
  return undefined;
}

function matchingBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export interface ZodIssueLike {
  path: readonly PropertyKey[];
  message: string;
  code?: string;
}

/** Short bullet lines such as "- actions.2.dc: Too big: expected number to be <=99". */
export function formatZodError(error: { issues: readonly ZodIssueLike[] }, maxLines = 12): string {
  const lines = error.issues.slice(0, maxLines).map((i) => {
    const path = i.path.map(String).join(".");
    return `- ${path === "" ? "(root)" : path}: ${i.message}`;
  });
  if (error.issues.length > maxLines) lines.push(`- ...and ${error.issues.length - maxLines} more`);
  return lines.join("\n");
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}
