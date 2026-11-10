import { afterEach, describe, expect, it } from "vitest";
import { PALETTE_HEX, PIXEL_COUNT, PIXEL_WIDTH, encodePixels, type PixelSprite } from "@aedm/schemas";
import { brindle, startHarness, type Harness } from "./helpers";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

function pixel(rect: [number, number, number, number]): PixelSprite {
  const a = new Uint8Array(PIXEL_COUNT);
  for (let y = rect[1]; y <= rect[3]; y++) for (let x = rect[0]; x <= rect[2]; x++) a[y * PIXEL_WIDTH + x] = 1;
  return { kind: "pixel", v: 1, width: 48, height: 64, palette: [PALETTE_HEX[5]!], pixels: encodePixels(a), size: "medium", traits: "painted" };
}

describe("claim_character with a pixel sprite", () => {
  it("accepts a valid painted sprite and keeps it on the character", async () => {
    h = await startHarness();
    const a = await h.connect();
    await a.createAndJoin("Alice");
    const sprite = pixel([16, 10, 31, 60]);
    const r = await a.request("claim_character", { character_id: "new", character: { ...brindle(), sprite_recipe: sprite } });
    expect(r.type).toBe("character_claimed");
    expect(a.invalid).toEqual([]);
  });

  it("rejects a painted sprite that breaks the rules with invalid_sprite", async () => {
    h = await startHarness();
    const a = await h.connect();
    await a.createAndJoin("Alice");
    const r = await a.request("claim_character", { character_id: "new", character: { ...brindle(), sprite_recipe: pixel([0, 10, 31, 60]) } });
    expect(r.type).toBe("error");
    if (r.type === "error") {
      expect(r.payload.code).toBe("invalid_sprite");
      expect(r.payload.message).toContain("empty space");
    }
  });

  it("rejects a color that is not on the master palette", async () => {
    h = await startHarness();
    const a = await h.connect();
    await a.createAndJoin("Alice");
    const bad = { ...pixel([16, 10, 31, 60]), palette: ["#123456"] };
    const r = await a.request("claim_character", { character_id: "new", character: { ...brindle(), sprite_recipe: bad } });
    expect(r.type === "error" && r.payload.code).toBe("invalid_sprite");
  });
});
