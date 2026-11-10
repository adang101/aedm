import { z } from "zod";
import { AbilitySchema } from "./ability";
import { AbilityScoresSchema, CharacterCreateSchema, CharacterViewSchema, SpriteRecipeSchema } from "./character";
import {
  AbilityScoreKeySchema, ConditionSchema, ContentRatingSchema, DirectionSchema, DispositionSchema, PlayerStatusSchema,
} from "./enums";
import { EntityIdSchema, MapIdSchema, text } from "./common";
import { MapSchema } from "./map";
import { QuestSchema } from "./world";

export const WS_VERSION = 1;
/** Maximum size of a client-to-server message in bytes. Larger messages are rejected. */
export const MAX_MESSAGE_BYTES = 8192;

const id = z.string().trim().min(1).max(64);
const displayName = text(24);
const tile = z.number().int().min(0).max(255);

export const WS_ERROR_CODES = ["version_mismatch", "bad_message", "rate_limited", "not_host", "not_found", "forbidden", "invalid_state"] as const;

// ---------- shared payload pieces ----------

export const RoomSettingsSchema = z.strictObject({
  content_rating: ContentRatingSchema,
  campaign_pitch: text(300, 0),
  dev_solo: z.boolean(),
});
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;
export const RoomSettingsPatchSchema = RoomSettingsSchema.partial();

export const LobbyPlayerSchema = z.strictObject({
  player_id: id,
  display_name: displayName,
  status: PlayerStatusSchema,
  ready: z.boolean(),
  character_id: id.nullable(),
});
export type LobbyPlayer = z.infer<typeof LobbyPlayerSchema>;

export const ConditionStateSchema = z.strictObject({ condition: ConditionSchema, turns: z.number().int().min(0).max(99) });

export const EntityViewSchema = z.strictObject({
  id: EntityIdSchema,
  kind: z.enum(["pc", "npc", "enemy"]),
  name: text(40),
  x: tile,
  y: tile,
  hp: z.number().int().min(0),
  hp_max: z.number().int().min(1),
  conditions: z.array(ConditionStateSchema).max(12),
  sprite: SpriteRecipeSchema,
  disposition: DispositionSchema.optional(),
  owner_player_id: id.optional(),
});
export type EntityView = z.infer<typeof EntityViewSchema>;

export const CombatStateSchema = z.strictObject({
  round: z.number().int().min(1),
  order: z.array(z.strictObject({ entity_id: EntityIdSchema, initiative: z.number().int() })).max(48),
  active_id: EntityIdSchema,
});
export type CombatState = z.infer<typeof CombatStateSchema>;

const mode = z.enum(["exploration", "combat"]);

// ---------- client -> server payloads ----------

export const CreateRoomPayload = z.strictObject({ display_name: displayName });
export const JoinRoomPayload = z.strictObject({
  invite_code: text(16),
  display_name: displayName,
  auth_token: text(256).optional(),
});
export const SetReadyPayload = z.strictObject({ ready: z.boolean() });
export const UpdateSettingsPayload = RoomSettingsPatchSchema; // host only
export const StartGamePayload = z.strictObject({}); // host only
export const ClaimCharacterPayload = z.union([
  z.strictObject({ character_id: z.literal("new"), character: CharacterCreateSchema }),
  z.strictObject({ character_id: z.literal("template"), template_id: id }), // accounts only: a saved character
  z.strictObject({ character_id: EntityIdSchema.refine((s) => s !== "new" && s !== "template") }),
]);
export const MoveIntentPayload = z.union([
  z.strictObject({ x: tile, y: tile }),
  z.strictObject({ direction: DirectionSchema }),
]);
export const ActPayload = z.strictObject({ verb: z.enum(["interact", "examine", "talk"]), target_id: EntityIdSchema });
export const UseAbilityPayload = z.strictObject({
  ability_id: id,
  target: z.union([EntityIdSchema, z.strictObject({ x: tile, y: tile })]),
});
export const BasicAttackPayload = z.strictObject({ target_id: EntityIdSchema });
export const UseItemPayload = z.strictObject({
  item_id: id,
  target: z.union([EntityIdSchema, z.strictObject({ x: tile, y: tile })]).optional(),
});
export const EndTurnPayload = z.strictObject({});
export const SayPayload = z.strictObject({ text: text(500), channel: z.enum(["ic", "ooc"]) });
export const VoteCastPayload = z.strictObject({ vote_id: id, choice: z.enum(["skip", "wait", "autopilot"]) });
export const RequestSavePayload = z.strictObject({ name: text(30) });
export const LoadSavePayload = z.strictObject({ save_id: id });
export const PingPayload = z.strictObject({});

// ---------- server -> client payloads ----------

export const RoomCreatedPayload = z.strictObject({ room_id: id, invite_code: text(16) });
export const JoinedPayload = z.strictObject({ player_id: id, auth_token: text(256), room_id: id });
export const LobbyStatePayload = z.strictObject({
  room_id: id,
  invite_code: text(16),
  host_player_id: id,
  phase: z.enum(["lobby", "playing"]),
  settings: RoomSettingsSchema,
  players: z.array(LobbyPlayerSchema).max(6),
  /** Set on a room opened by resume_campaign: the host presses load_save with this id. */
  resume_save: z.strictObject({ save_id: id, name: text(30) }).optional(),
});
export const ChatPayload = z.strictObject({
  from_id: id,
  from_name: text(40),
  channel: z.enum(["ic", "ooc", "system"]),
  text: text(2000),
});
export const LogPayload = z.strictObject({
  kind: z.enum(["narration", "system", "roll", "engine"]),
  text: text(4000),
  turn_id: id.optional(),
});
export const StateSnapshotPayload = z.strictObject({
  seq: z.number().int().min(0),
  mode,
  map: MapSchema,
  entities: z.array(EntityViewSchema),
  party: z.array(CharacterViewSchema).max(6),
  quests: z.array(QuestSchema),
  combat: CombatStateSchema.optional(),
});
export const StateDiffPayload = z.strictObject({
  seq: z.number().int().min(0),
  ack_seq: z.number().int().min(0).optional(),
  changed: z.array(EntityViewSchema),
  removed: z.array(EntityIdSchema),
  mode: mode.optional(),
  combat: CombatStateSchema.optional(),
});
export const NarrationChunkPayload = z.strictObject({ turn_id: id, text: z.string().max(4000), done: z.boolean() });
export const RollResultPayload = z.strictObject({
  who: id,
  label: text(120),
  dice: z.array(z.number().int()).min(1).max(16),
  modifier: z.number().int().default(0),
  total: z.number().int(),
  target: z.number().int(),
  outcome: z.enum(["success", "failure", "crit", "fumble"]),
});
export const CombatStatePayload = CombatStateSchema;
export const TurnTimerPayload = z.strictObject({ entity_id: EntityIdSchema, seconds_left: z.number().min(0) });
export const VoteStatePayload = z.strictObject({
  vote_id: id,
  topic: text(200),
  options: z.array(text(40)).min(1).max(6),
  tally: z.record(z.string(), z.number().int().min(0)),
  seconds_left: z.number().min(0),
});
export const MapLoadPayload = z.strictObject({ map_id: MapIdSchema, url: text(500), content_hash: text(128) });
export const PresencePayload = z.strictObject({ player_id: id, status: PlayerStatusSchema });
export const CharacterClaimedPayload = z.strictObject({ character_id: EntityIdSchema, player_id: id });
export const SaveCreatedPayload = z.strictObject({ save_id: id, name: text(30) });
export const ChipsPayload = z.strictObject({ chips: z.array(text(60)).min(2).max(4) });
export const ErrorPayload = z.strictObject({ code: text(40), message: text(500), ack_id: id.optional() });
export const PongPayload = z.strictObject({});

// ---------- level-up flow (self-contained block) ----------

export const LevelUpChoicePayload = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("score"), ability: AbilityScoreKeySchema }),
  z.strictObject({ kind: z.literal("new_ability"), text: text(300) }),
  z.strictObject({ kind: z.literal("reforge"), ability_id: id, text: text(300) }),
  z.strictObject({ kind: z.literal("skip_ability") }),
]);
export type LevelUpChoice = z.infer<typeof LevelUpChoicePayload>;

/** Sent to the owning player only. Zero picks of both kinds closes the level-up screen. */
export const LevelUpStatePayload = z.strictObject({
  character_id: EntityIdSchema,
  level: z.number().int().min(1).max(10),
  score_points: z.number().int().min(0),
  ability_picks: z.number().int().min(0),
  budget: z.number().int().min(0),
  budget_used: z.number().int().min(0),
  per_ability_cap: z.number().int().min(0),
  caps: z.strictObject({
    max_avg: z.number().min(0),
    max_radius: z.number().int().min(0),
    max_stun_turns: z.number().int().min(0),
  }),
  max_abilities: z.number().int().min(1).optional(),
  abilities: z.array(AbilitySchema).max(6),
  scores: AbilityScoresSchema,
});
export type LevelUpState = z.infer<typeof LevelUpStatePayload>;

export const LevelUpResultPayload = z.strictObject({
  ok: z.boolean(),
  message: text(500, 0),
  forge_notes: z.array(text(1000, 0)).max(20),
  ability: AbilitySchema.optional(),
});
export type LevelUpResult = z.infer<typeof LevelUpResultPayload>;

// ---------- envelopes ----------

const envelope = {
  v: z.literal(WS_VERSION),
  id,
  ts: z.number().int().min(0),
};

/** Generic envelope for the first-pass parse (version check, routing) before payload validation. */
export const WsEnvelopeSchema = z.strictObject({
  ...envelope,
  type: z.string().trim().min(1).max(40),
  payload: z.unknown(),
  ack_id: id.optional(),
});
export type WsEnvelope = z.infer<typeof WsEnvelopeSchema>;

const client = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({ ...envelope, type: z.literal(type), payload });
const server = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({ ...envelope, type: z.literal(type), payload, ack_id: id.optional() });


// ---------- accounts (separate block; see docs/contracts.md "Accounts") ----------

export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const MAX_SAVED_CHARACTERS = 20;

/** Wire limits are loose on purpose: the server validates the rules and answers with auth_error "invalid". */
export const RegisterPayload = z.strictObject({
  username: z.string().max(64),
  password: z.string().max(256),
  display_name: z.string().max(100),
});
export const LoginPayload = z.strictObject({ username: z.string().max(64), password: z.string().max(256) });
export const ResumeSessionPayload = z.strictObject({ session_token: text(128) });
export const LogoutPayload = z.strictObject({});
export const ListCharactersPayload = z.strictObject({});
export const SaveCharacterTemplatePayload = z.strictObject({ character: CharacterCreateSchema });
export const DeleteCharacterTemplatePayload = z.strictObject({ id });
export const ListCampaignsPayload = z.strictObject({});
/** `room_id` is the folder the save lives in (autosave ids repeat across rooms). */
export const ResumeCampaignPayload = z.strictObject({ save_id: id, room_id: id });

/** Returns a user-facing problem with register input, or null. Shared by server and client. */
export function validateRegistration(v: { username: string; password: string; display_name: string }): string | null {
  if (!USERNAME_PATTERN.test(v.username.trim())) return "Usernames are 3 to 20 characters: letters, digits, _ or -.";
  if (v.password.length < PASSWORD_MIN || v.password.length > PASSWORD_MAX) return `Passwords are ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`;
  const n = [...v.display_name.trim()].length;
  if (n < 1 || n > 24) return "Display names are 1 to 24 characters.";
  return null;
}

export const AuthUserSchema = z.strictObject({ id: id, username: z.string().max(20), display_name: displayName });
export type AuthUser = z.infer<typeof AuthUserSchema>;

/** What the list shows. The full template (CharacterCreate) never leaves the server. */
export const CharacterSummarySchema = z.strictObject({
  id,
  name: text(30),
  title: text(40, 0),
  key_ability: AbilityScoreKeySchema,
  sprite_recipe: SpriteRecipeSchema,
  ability_names: z.array(text(60)).max(3),
  forged: z.boolean(),
  saved_at: text(40),
});
export type CharacterSummary = z.infer<typeof CharacterSummarySchema>;

export const CampaignInfoSchema = z.strictObject({
  save_id: id,
  room_id: id,
  kind: z.enum(["autosave", "named"]),
  name: text(30),
  campaign_title: text(80, 0),
  updated_at: text(40),
  players: z.array(displayName).max(6),
  can_resume: z.boolean(),
});
export type CampaignInfo = z.infer<typeof CampaignInfoSchema>;

export const AUTH_ERROR_CODES = ["invalid_credentials", "username_taken", "invalid", "rate_limited"] as const;
export const AuthOkPayload = z.strictObject({
  user: AuthUserSchema,
  /** Only on register and login. A resumed session keeps its token. */
  session_token: text(128).optional(),
  characters: z.array(CharacterSummarySchema).max(MAX_SAVED_CHARACTERS),
});
export const AuthErrorPayload = z.strictObject({ code: z.enum(AUTH_ERROR_CODES), message: text(300) });
export const LoggedOutPayload = z.strictObject({});
export const CharactersListPayload = z.strictObject({ characters: z.array(CharacterSummarySchema).max(MAX_SAVED_CHARACTERS) });
export const CampaignsListPayload = z.strictObject({ campaigns: z.array(CampaignInfoSchema).max(100) });

const accountClientMessages = [
  client("register", RegisterPayload),
  client("login", LoginPayload),
  client("resume_session", ResumeSessionPayload),
  client("logout", LogoutPayload),
  client("list_characters", ListCharactersPayload),
  client("save_character_template", SaveCharacterTemplatePayload),
  client("delete_character_template", DeleteCharacterTemplatePayload),
  client("list_campaigns", ListCampaignsPayload),
  client("resume_campaign", ResumeCampaignPayload),
] as const;
const accountServerMessages = [
  server("auth_ok", AuthOkPayload),
  server("auth_error", AuthErrorPayload),
  server("logged_out", LoggedOutPayload),
  server("characters_list", CharactersListPayload),
  server("campaigns_list", CampaignsListPayload),
] as const;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  ...accountClientMessages,
  client("create_room", CreateRoomPayload),
  client("join_room", JoinRoomPayload),
  client("set_ready", SetReadyPayload),
  client("update_settings", UpdateSettingsPayload),
  client("start_game", StartGamePayload),
  client("claim_character", ClaimCharacterPayload),
  client("move_intent", MoveIntentPayload),
  client("act", ActPayload),
  client("use_ability", UseAbilityPayload),
  client("basic_attack", BasicAttackPayload),
  client("use_item", UseItemPayload),
  client("end_turn", EndTurnPayload),
  client("say", SayPayload),
  client("vote_cast", VoteCastPayload),
  client("request_save", RequestSavePayload),
  client("load_save", LoadSavePayload),
  client("ping", PingPayload),
  client("level_up_choice", LevelUpChoicePayload),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage["type"];

export const ServerMessageSchema = z.discriminatedUnion("type", [
  ...accountServerMessages,
  server("room_created", RoomCreatedPayload),
  server("joined", JoinedPayload),
  server("lobby_state", LobbyStatePayload),
  server("chat", ChatPayload),
  server("log", LogPayload),
  server("state_snapshot", StateSnapshotPayload),
  server("state_diff", StateDiffPayload),
  server("narration_chunk", NarrationChunkPayload),
  server("roll_result", RollResultPayload),
  server("combat_state", CombatStatePayload),
  server("turn_timer", TurnTimerPayload),
  server("vote_state", VoteStatePayload),
  server("map_load", MapLoadPayload),
  server("presence", PresencePayload),
  server("character_claimed", CharacterClaimedPayload),
  server("save_created", SaveCreatedPayload),
  server("chips", ChipsPayload),
  server("error", ErrorPayload),
  server("pong", PongPayload),
  server("level_up_state", LevelUpStatePayload),
  server("level_up_result", LevelUpResultPayload),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage["type"];

/** True when a raw frame exceeds MAX_MESSAGE_BYTES (UTF-8). Check before JSON.parse. */
export function exceedsMaxBytes(raw: string): boolean {
  return new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES;
}
