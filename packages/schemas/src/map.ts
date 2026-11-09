import { z } from "zod";
import {
  BiomeSchema, EntitySlotRoleSchema, ExitSideSchema, InteractableKindSchema, InteractableStateSchema,
  RoomTypeSchema, SizeClassSchema, SizeSchema,
} from "./enums";
import { EntityIdSchema, MapIdSchema, TileCoord, shortWord, text } from "./common";

const localId = z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/, "invalid id");

export const RoomSchema = z.strictObject({
  id: localId,
  type: RoomTypeSchema,
  size: SizeSchema,
  connects_to: z.array(localId).max(11),
});
export type Room = z.infer<typeof RoomSchema>;

export const PointOfInterestSchema = z.strictObject({ kind: text(24), room_id: localId });
export const BriefEntitySlotSchema = z.strictObject({
  role: EntitySlotRoleSchema,
  room_id: localId,
  count: z.number().int().min(1).max(6),
});
export const BriefExitSchema = z.strictObject({ side: ExitSideSchema, label: text(40) });

export const MapBriefSchema = z
  .strictObject({
    biome: BiomeSchema,
    theme_tags: z.array(shortWord).max(4),
    size_class: SizeClassSchema,
    rooms: z.array(RoomSchema).min(1).max(12),
    points_of_interest: z.array(PointOfInterestSchema).max(8),
    entity_slots: z.array(BriefEntitySlotSchema).max(8),
    exits: z.array(BriefExitSchema).min(1).max(4),
  })
  .superRefine((b, ctx) => {
    const ids = new Set<string>();
    b.rooms.forEach((r, i) => {
      if (ids.has(r.id)) ctx.addIssue({ code: "custom", message: `duplicate room id ${r.id}`, path: ["rooms", i, "id"] });
      ids.add(r.id);
    });
    b.rooms.forEach((r, i) =>
      r.connects_to.forEach((c, j) => {
        if (!ids.has(c)) ctx.addIssue({ code: "custom", message: `unknown room ${c}`, path: ["rooms", i, "connects_to", j] });
      }),
    );
    b.points_of_interest.forEach((p, i) => {
      if (!ids.has(p.room_id)) ctx.addIssue({ code: "custom", message: `unknown room ${p.room_id}`, path: ["points_of_interest", i, "room_id"] });
    });
    b.entity_slots.forEach((s, i) => {
      if (!ids.has(s.room_id)) ctx.addIssue({ code: "custom", message: `unknown room ${s.room_id}`, path: ["entity_slots", i, "room_id"] });
    });
  });
export type MapBrief = z.infer<typeof MapBriefSchema>;

// ---- Map JSON ----

export const TILE_LAYER_NAMES = ["ground", "walls", "decor", "above"] as const;
export const TileLayerNameSchema = z.enum(TILE_LAYER_NAMES);

const pos = { x: TileCoord, y: TileCoord };

export const SpawnObjectSchema = z.strictObject({ type: z.literal("spawn"), name: text(32), ...pos });
export const ExitObjectSchema = z.strictObject({
  type: z.literal("exit"),
  name: text(32),
  to: z.union([MapIdSchema, z.literal("pending")]),
  target_entry: text(32),
  ...pos,
});
export const EntitySlotObjectSchema = z.strictObject({
  type: z.literal("entity_slot"),
  id: EntityIdSchema,
  role: EntitySlotRoleSchema,
  count: z.number().int().min(1).max(6),
  ...pos,
});
export const InteractableObjectSchema = z.strictObject({
  type: z.literal("interactable"),
  id: EntityIdSchema,
  kind: InteractableKindSchema,
  state: InteractableStateSchema,
  ...pos,
});
export const TriggerObjectSchema = z.strictObject({
  type: z.literal("trigger"),
  id: EntityIdSchema,
  radius: z.number().int().min(1).max(3),
  on_enter: text(40),
  ...pos,
});
export const MapObjectSchema = z.discriminatedUnion("type", [
  SpawnObjectSchema, ExitObjectSchema, EntitySlotObjectSchema, InteractableObjectSchema, TriggerObjectSchema,
]);
export type MapObject = z.infer<typeof MapObjectSchema>;

export const TileLayerSchema = z.strictObject({
  type: z.literal("tilelayer"),
  name: TileLayerNameSchema,
  data: z.array(z.number().int().min(0)),
});
export type TileLayer = z.infer<typeof TileLayerSchema>;

export const ObjectLayerSchema = z.strictObject({
  type: z.literal("objectgroup"),
  name: z.literal("objects"),
  objects: z.array(MapObjectSchema).max(500),
});
export type ObjectLayer = z.infer<typeof ObjectLayerSchema>;

export const MapLayerSchema = z.discriminatedUnion("type", [TileLayerSchema, ObjectLayerSchema]);

export const TilesetRefSchema = z.strictObject({
  asset_id: EntityIdSchema,
  first_gid: z.number().int().min(1),
});

export const MapMetaSchema = z.strictObject({
  biome: BiomeSchema,
  theme_tags: z.array(shortWord).max(4),
  seed: z.number().int(),
  template_id: z.string().trim().min(1).max(64).optional(),
  generated_at: z.iso.datetime(),
});

export const MapSchema = z
  .strictObject({
    v: z.literal(1),
    id: MapIdSchema,
    width: z.number().int().min(20).max(60),
    height: z.number().int().min(20).max(60),
    tile_size: z.literal(48),
    tilesets: z.array(TilesetRefSchema).min(1).max(4),
    layers: z.array(MapLayerSchema).length(5),
    meta: MapMetaSchema,
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    let objects: MapObject[] = [];
    m.layers.forEach((l, i) => {
      if (seen.has(l.name)) ctx.addIssue({ code: "custom", message: `duplicate layer ${l.name}`, path: ["layers", i, "name"] });
      seen.add(l.name);
      if (l.type === "tilelayer") {
        if (l.data.length !== m.width * m.height) {
          ctx.addIssue({ code: "custom", message: `layer ${l.name} data length ${l.data.length} != width*height ${m.width * m.height}`, path: ["layers", i, "data"] });
        }
      } else {
        objects = l.objects;
        l.objects.forEach((o, j) => {
          if (o.x >= m.width || o.y >= m.height) {
            ctx.addIssue({ code: "custom", message: "object outside map bounds", path: ["layers", i, "objects", j] });
          }
        });
      }
    });
    for (const name of [...TILE_LAYER_NAMES, "objects"]) {
      if (!seen.has(name)) ctx.addIssue({ code: "custom", message: `missing layer ${name}`, path: ["layers"] });
    }
    const starts = objects.filter((o) => o.type === "spawn" && o.name === "party_start");
    if (starts.length !== 1) {
      ctx.addIssue({ code: "custom", message: "exactly one spawn named party_start is required", path: ["layers"] });
    }
  });
export type GameMap = z.infer<typeof MapSchema>;
