import { DmResponseSchema } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { extractJson, formatZodError } from "./json";

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("strips code fences", () => {
    expect(extractJson('```json\n{"a":{"b":[1,2]}}\n```')).toEqual({ a: { b: [1, 2] } });
  });
  it("finds the object in prose, with braces inside strings", () => {
    const raw = 'Sure! Here is the result:\n{"narration":"She said \\"{hello}\\" and left.","actions":[]}\nHope that helps {really}.';
    expect(extractJson(raw)).toEqual({ narration: 'She said "{hello}" and left.', actions: [] });
  });
  it("handles an unclosed fence", () => {
    expect(extractJson('```json\n{"a":1}')).toEqual({ a: 1 });
  });
  it("skips a broken first brace and returns undefined for garbage", () => {
    expect(extractJson('{ not json } then {"ok":true}')).toEqual({ ok: true });
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson("")).toBeUndefined();
    expect(extractJson("[1,2,3]")).toBeUndefined();
  });
});

describe("formatZodError", () => {
  it("makes short bullet lines with paths", () => {
    const r = DmResponseSchema.safeParse({ v: 1, narration: "too short", actions: [{ type: "nope" }], importance: 9 });
    expect(r.success).toBe(false);
    if (r.success) return;
    const text = formatZodError(r.error);
    expect(text).toMatch(/^- narration: /m);
    expect(text).toMatch(/^- importance: /m);
    expect(text.split("\n").every((l) => l.startsWith("- "))).toBe(true);
  });
});
