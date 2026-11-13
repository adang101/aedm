import { z } from "zod";
import { ContainerKindSchema } from "./enums";
import { EntityIdSchema, MapIdSchema, TileCoord, text } from "./common";
import { LockSchema } from "./map";
import { ItemSchema } from "./world";

/** At most this many items in one container (the engine's own, smaller, caps come from data). */
export const MAX_CONTAINER_ITEMS = 100;

/**
 * Something on the map that holds items: a chest (linked to a map interactable by `object_id`), a pile of dropped
 * items, the remains of a defeated creature, or an NPC's pockets (`owner_entity_id`). Engine state; saved with the game.
 * `locked` and `lock` are for chests; `opened` is whether a chest has been opened (it stays open until closed).
 */
export const ContainerSchema = z.strictObject({
  v: z.literal(1),
  id: EntityIdSchema,
  kind: ContainerKindSchema,
  map_id: MapIdSchema,
  x: TileCoord,
  y: TileCoord,
  items: z.array(ItemSchema).max(MAX_CONTAINER_ITEMS),
  /** What a player sees: "Chest", "Remains of Robed Chorister". */
  label: text(60).optional(),
  locked: z.boolean().optional(),
  lock: LockSchema.optional(),
  opened: z.boolean().optional(),
  /** The map object (chest interactable or loot entity slot) this container came from. */
  object_id: EntityIdSchema.optional(),
  /** The creature whose pockets or remains these are. */
  owner_entity_id: EntityIdSchema.optional(),
});
export type Container = z.infer<typeof ContainerSchema>;

/** What the whole table sees of a container on the map: where it is and how full, never what is inside. */
export const ContainerSummarySchema = z.strictObject({
  id: EntityIdSchema,
  kind: ContainerKindSchema,
  x: TileCoord,
  y: TileCoord,
  item_count: z.number().int().min(0).max(MAX_CONTAINER_ITEMS),
  locked: z.boolean(),
  open: z.boolean(),
  object_id: EntityIdSchema.optional(),
});
export type ContainerSummary = z.infer<typeof ContainerSummarySchema>;

/** The state of a map interactable that changed (a door opened, a lever pulled, a chest unlocked). Applies to `map_id`. */
export const InteractableViewSchema = z.strictObject({
  map_id: MapIdSchema,
  id: EntityIdSchema,
  state: z.enum(["open", "closed", "locked"]),
});
export type InteractableView = z.infer<typeof InteractableViewSchema>;

/** The contents of a container as one player sees them after opening it. A locked container shows no items. */
export const ContainerViewPayload = z.strictObject({
  container_id: EntityIdSchema,
  kind: ContainerKindSchema,
  label: text(60).optional(),
  items: z.array(ItemSchema).max(MAX_CONTAINER_ITEMS),
  locked: z.boolean(),
});
export type ContainerView = z.infer<typeof ContainerViewPayload>;
