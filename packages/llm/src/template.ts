import { readFileSync } from "node:fs";

const cache = new Map<string, string>();

/**
 * Supplies prompt texts directly, for hosts with no readable file system (Cloudflare Workers bundle the .md files as text).
 * Anything registered wins over the file read.
 */
export function registerPrompts(prompts: Record<string, string>): void {
  for (const [name, text] of Object.entries(prompts)) cache.set(name, normalizeEol(text));
}

/** Reads packages/llm/prompts/<name>.md (relative to this module, never __dirname). */
export function loadPrompt(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const text = normalizeEol(readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8"));
  cache.set(name, text);
  return text;
}

/** A Windows checkout (core.autocrlf) gives CRLF; prompts are always LF so every host sends the model the same text. */
const CRLF = new RegExp(String.raw`\r\n`, "g");
const normalizeEol = (text: string) => text.replace(CRLF, "\n");

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Replaces {{key}} placeholders. Throws if a placeholder has no value. Inserted values are not re-expanded. */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`Missing template value for {{${key}}}`);
    return String(v);
  });
}

export function renderPrompt(name: string, vars: Record<string, string | number>): string {
  return renderTemplate(loadPrompt(name), vars);
}

/** Placeholder names a template needs. */
export function templateKeys(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string))];
}
