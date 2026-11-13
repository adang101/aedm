import { z } from "zod";
import {
  EntitySlotRoleSchema, EnvironmentSchema, ExitSideSchema, InteractableKindSchema, InteractableStateSchema,
  LayoutSchema, MoodSchema, RoomTypeSchema, SettingPresetSchema, SizeClassSchema, SizeSchema,
} from "./enums";
import { EntityIdSchema, HexColorSchema, MapIdSchema, TileCoord, shortWord, text } from "./common";
import { MaterialIdSchema, MaterialRefSchema, MaterialRoleSchema, PatternSchema } from "./material";

const localId = z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/, "invalid id");

export const RoomSchema = z.strictObject({
  id: localId,
  type: RoomTypeSchema,
  size: SizeSchema,
  connects_to: z.array(localId).max(11),
});
export type Room = z.infer<typeof RoomSchema>;

/** `kind` is free text; the engine maps it to a decor material or an interactable. */
export const PointOfInterestSchema = z.strictObject({ kind: text(24), room_id: localId });
export const BriefEntitySlotSchema = z.strictObject({
  role: EntitySlotRoleSchema,
  room_id: localId,
  count: z.number().int().min(1).max(6),
});
export const BriefExitSchema = z.strictObject({ side: ExitSideSchema, label: text(40) });

const refs = (max: number) => z.array(MaterialRefSchema).max(max).optional();

/** Materials per role: a library id or an inline draft, in order of preference. A preset fills what is missing. */
export const BriefMaterialsSchema = z.strictObject({
  floor: refs(3),
  path: refs(3),
  wall: refs(3),
  obstacle: refs(3),
  liquid: refs(3),
  hazard: refs(3),
  decor: refs(6),
});
export type BriefMaterials = z.infer<typeof BriefMaterialsSchema>;

export const DensitySchema = z.strictObject({
  obstacles: z.number().int().min(0).max(3),
  liquid: z.number().int().min(0).max(3),
  hazards: z.number().int().min(0).max(3),
});

/** The open-ended description of a place. `layout` and `environment` are required; `preset` is only a shortcut. */
export const SettingSchema = z.strictObject({
  name: text(40),
  preset: SettingPresetSchema.optional(),
  layout: LayoutSchema,
  environment: EnvironmentSchema,
  mood: MoodSchema,
  materials: BriefMaterialsSchema.optional(),
  density: DensitySchema.optional(),
});
export type Setting = z.infer<typeof SettingSchema>;

/** A setting reduced to what is stored on a map and in the asset store (no materials, no density). */
export const SettingSpecSchema = z.strictObject({
  name: text(40),
  preset: SettingPresetSchema.optional(),
  layout: LayoutSchema,
  environment: EnvironmentSchema,
  mood: MoodSchema,
});
export type SettingSpec = z.infer<typeof SettingSpecSchema>;

export const MapBriefSchema = z
  .strictObject({
    setting: SettingSchema,
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
/** A lock on a chest or door: the DC to pick (DEX) or force (STR), and optionally the name of the key item that opens it. */
export const LockSchema = z.strictObject({
  dc: z.number().int().min(5).max(30),
  key_item_name: text(40).optional(),
});
export type Lock = z.infer<typeof LockSchema>;

export const SIGN_TEXT_MAX = 200;
export const MAX_LEVER_LINKS = 4;

/** `lock` is for chests and doors, `links` (door ids on the same map) for levers, `text` for signs. All optional and additive. */
export const InteractableObjectSchema = z.strictObject({
  type: z.literal("interactable"),
  id: EntityIdSchema,
  kind: InteractableKindSchema,
  state: InteractableStateSchema,
  lock: LockSchema.optional(),
  links: z.array(EntityIdSchema).min(1).max(MAX_LEVER_LINKS).optional(),
  text: text(SIGN_TEXT_MAX).optional(),
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

/** One resolved tile of the map's inline tileset. Colors are master palette colors. */
export const TileDefSchema = z.strictObject({
  gid: z.number().int().min(1),
  material_id: MaterialIdSchema,
  role: MaterialRoleSchema,
  color: HexColorSchema,
  accent: HexColorSchema,
  pattern: PatternSchema,
  walkable: z.boolean(),
  blocks_sight: z.boolean(),
  /** Visual variant of the same material (0 to 3), to break up repetition. */
  variant: z.number().int().min(0).max(3),
  layer: TileLayerNameSchema,
  /** Where generated art plugs in later (M3). */
  image_asset_id: z.string().trim().min(1).max(64).optional(),
});
export type TileDef = z.infer<typeof TileDefSchema>;

export const MAX_TILEDEFS = 256;

/** The tileset travels inside the map, so the client can draw any map with no fixed catalog. */
export const InlineTilesetSchema = z.strictObject({
  first_gid: z.literal(1),
  tiles: z.array(TileDefSchema).min(1).max(MAX_TILEDEFS),
});
export type InlineTileset = z.infer<typeof InlineTilesetSchema>;

export const MapMetaSchema = z.strictObject({
  setting: SettingSpecSchema,
  theme_tags: z.array(shortWord).max(4),
  seed: z.number().int(),
  template_id: z.string().trim().min(1).max(64).optional(),
  generated_at: z.iso.datetime(),
});

export const MapSchema = z
  .strictObject({
    v: z.literal(2),
    id: MapIdSchema,
    width: z.number().int().min(20).max(60),
    height: z.number().int().min(20).max(60),
    tile_size: z.literal(48),
    tileset: InlineTilesetSchema,
    layers: z.array(MapLayerSchema).length(5),
    meta: MapMetaSchema,
  })
  .superRefine((m, ctx) => {
    const gids = new Set<number>();
    m.tileset.tiles.forEach((t, i) => {
      if (gids.has(t.gid)) ctx.addIssue({ code: "custom", message: `duplicate tile gid ${t.gid}`, path: ["tileset", "tiles", i, "gid"] });
      gids.add(t.gid);
    });
    const seen = new Set<string>();
    let objects: MapObject[] = [];
    m.layers.forEach((l, i) => {
      if (seen.has(l.name)) ctx.addIssue({ code: "custom", message: `duplicate layer ${l.name}`, path: ["layers", i, "name"] });
      seen.add(l.name);
      if (l.type === "tilelayer") {
        if (l.data.length !== m.width * m.height) {
          ctx.addIssue({ code: "custom", message: `layer ${l.name} data length ${l.data.length} != width*height ${m.width * m.height}`, path: ["layers", i, "data"] });
        }
        const missing = new Set<number>();
        for (const g of l.data) if (g !== 0 && !gids.has(g)) missing.add(g);
        if (missing.size > 0) {
          ctx.addIssue({ code: "custom", message: `layer ${l.name} uses gid(s) without a TileDef: ${[...missing].slice(0, 5).join(", ")}`, path: ["layers", i, "data"] });
        }
      } else {
        objects = l.objects;
        l.objects.forEach((o, j) => {
          if (o.x >= m.width || o.y >= m.height) {
            ctx.addIssue({ code: "custom", message: "object outside map bounds", path: ["layers", i, "objects", j] });
          }
        });
        const doors = new Set(l.objects.flatMap((o) => (o.type === "interactable" && o.kind === "door" ? [o.id] : [])));
        l.objects.forEach((o, j) => {
          if (o.type !== "interactable") return;
          const at = ["layers", i, "objects", j];
          if (o.lock && o.kind !== "chest" && o.kind !== "door") ctx.addIssue({ code: "custom", message: `a ${o.kind} cannot have a lock`, path: [...at, "lock"] });
          if (o.links && o.kind !== "lever") ctx.addIssue({ code: "custom", message: `only a lever has links, not a ${o.kind}`, path: [...at, "links"] });
          if (o.text && o.kind !== "sign") ctx.addIssue({ code: "custom", message: `only a sign has text, not a ${o.kind}`, path: [...at, "text"] });
          for (const link of o.links ?? []) {
            if (!doors.has(link)) ctx.addIssue({ code: "custom", message: `lever ${o.id} links to ${link}, which is not a door on this map`, path: [...at, "links"] });
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
