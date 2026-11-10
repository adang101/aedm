/**
 * COMPATIBILITY SHIM (remove when the sprite renderer draws `spec` recipes).
 * Reduces any sprite recipe to the old colored-shape recipe so badges, lists and the map keep working.
 */
import type { ShapeSpriteRecipe, SpriteRecipe, BodyPlan } from "@aedm/schemas";
import { spriteSwatch } from "@aedm/schemas";

const SHAPE_FOR_BODY: Record<BodyPlan, ShapeSpriteRecipe["shape"]> = {
  humanoid: "circle", beast: "hex", avian: "triangle", serpent: "diamond", insectoid: "hex",
  amorphous: "circle", construct: "square", spirit: "diamond", plant: "triangle", object: "square",
};

export function asShape(recipe: SpriteRecipe, name = "?"): ShapeSpriteRecipe {
  if (recipe.kind === "shape") return recipe;
  const { color, accent, glyph } = spriteSwatch(recipe, name);
  return { kind: "shape", shape: SHAPE_FOR_BODY[recipe.body], color, accent, glyph };
}
