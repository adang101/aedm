import { describe, expect, it } from "vitest";
import { NarrationExtractor } from "./narration-stream";

function run(doc: string, size: number): { out: string; ex: NarrationExtractor } {
  const ex = new NarrationExtractor();
  let out = "";
  for (let i = 0; i < doc.length; i += size) out += ex.push(doc.slice(i, i + size));
  return { out, ex };
}

describe("NarrationExtractor", () => {
  const narration = 'She said "wait"\nthen\\left é \u{1F600} </b> done.';
  const doc = JSON.stringify({ v: 1, narration, actions: [{ type: "suggest_actions", chips: ["a", "b"] }] }, null, 1);

  for (const size of [1, 2, 3, 5, 7, 64, 10_000]) {
    it(`decodes escapes split across chunks (size ${size})`, () => {
      const { out, ex } = run(doc, size);
      expect(out).toBe(narration);
      expect(ex.done).toBe(true);
      expect(ex.narration).toBe(narration);
    });
  }

  it("works behind a code fence and when narration is not the first key", () => {
    const { out } = run('```json\n{"v":1,"narration" : "Hi \\u0041!","x":"y"}', 4);
    expect(out).toBe("Hi A!");
  });

  it("emits nothing before the key and stops after the closing quote", () => {
    const ex = new NarrationExtractor();
    expect(ex.push('{"v":1,"narr')).toBe("");
    expect(ex.push('ation":"ab')).toBe("ab");
    expect(ex.push('c","actions":[]}')).toBe("c");
    expect(ex.push('more "narration":"zzz"')).toBe("");
  });

  it("emits partial text of an unterminated string", () => {
    expect(run('{"narration":"partial \\', 3).out).toBe("partial ");
  });
});
