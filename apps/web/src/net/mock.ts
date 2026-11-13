import {
  ClientMessageSchema, WS_VERSION, fixtures, parseDice, validateRegistration,
  type Ability, type CampaignInfo, type CharacterCreate, type CharacterSummary, type CharacterView, type EntityView, type GameMap,
  type CastEntry, type ServerMessageType, type WorkshopAsset, WORKSHOP_MAX_ASSETS, WORKSHOP_MAX_BYTES,
} from "@aedm/schemas";
import type { Transport, TransportFactory, TransportHandlers } from "./transport";
import { FIRST_SCENE, NARRATION_OPENING, blockedAt, buildScenes, sceneFromText, type MockScene } from "./mock-world";
import { designSpriteOffline } from "@aedm/engine";
import { PREMADE_SPECS } from "../state/sprite-builder";
import { MockLoot, starterPack } from "./mock-loot";

type Payload = Record<string, unknown>;
type PlayerStatus = "online" | "away" | "offline" | "autopilot";
interface MockPlayer { player_id: string; display_name: string; status: PlayerStatus; ready: boolean; character_id: string | null }
interface Settings {
  content_rating: "family" | "teen" | "mature"; campaign_pitch: string; dev_solo: boolean; plot_pattern?: string; plot_arc?: string;
  custom_cast?: "off" | "host_approval" | "open"; custom_paintings?: boolean;
}

const ME = "p_me";
const ME_CHAR = "ch_me";
const LATENCY_MS = 45;

const rnd = (n: number) => 1 + Math.floor(Math.random() * n);
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function toView(c: (typeof fixtures)["BRINDLE"]): CharacterView {
  return {
    v: 1, id: c.id, name: c.name, title: c.title, description: c.description, key_ability: c.key_ability, scores: c.scores,
    trait_tags: c.trait_tags, abilities: c.abilities, weapon_tier: c.weapon_tier, armor_bonus: c.armor_bonus,
    level: c.level, growth: c.growth, hp: c.hp, hp_max: c.hp_max, sprite_recipe: PREMADE_SPECS[c.id] ?? c.sprite_recipe,
  };
}

const FAKES = {
  mira: { id: "p_mira", name: "Mira", char: fixtures.BRINDLE, start: { x: 12, y: 11 } },
  dov: { id: "p_dov", name: "Dov", char: fixtures.TAMSIN, start: { x: 14, y: 11 } },
  sable: { id: "p_sable", name: "Sable", char: fixtures.ORRIN, start: { x: 13, y: 12 } },
};

/** Stand-in for the ability forge: every idea becomes 2d6 single-target damage. */
export function mockAbilityFrom(t: string, id: string, i = 0): Ability {
  const [head, ...rest] = t.split(":");
  const name = (rest.length ? head! : t.split(/\s+/).slice(0, 3).join(" ")).trim().slice(0, 40) || `Ability ${i + 1}`;
  const desc = (rest.length ? rest.join(":") : t).trim().slice(0, 200) || name;
  return {
    v: 1 as const, id, name, description: desc, tags: [], action: "action" as const,
    target: "enemy" as const, range_tiles: 4, cooldown_turns: 2,
    effects: [{ type: "damage" as const, shape: "single" as const, dice: "2d6", damage_type: "sharp" as const }],
    forge_notes: "Mock forge: turned into 2d6 single-target damage.", cost: 4,
  };
}

/** Build the character a real server would produce from a creator submission (the forge is faked). */
export function mockCharacterFrom(c: CharacterCreate): CharacterView {
  const con = c.scores.con;
  const hp = 8 + Math.floor((con - 10) / 2) + 2;
  const texts = c.ability_texts ?? (c.abilities ?? []).map((a) => `${a.name}: ${a.description}`);
  return {
    v: 1, id: ME_CHAR, name: c.name, title: c.title, description: c.description, key_ability: c.key_ability,
    scores: { ...c.scores }, trait_tags: c.trait_tags,
    abilities: texts.map((t, i) => mockAbilityFrom(t, `ab_me_${i + 1}`, i)),
    weapon_tier: 1, armor_bonus: 2, level: 1, growth: 0, hp, hp_max: hp,
    sprite_recipe: c.sprite_recipe ?? { kind: "shape", shape: "circle", color: "#9a6a3f", accent: "#e8c95a", glyph: (c.name.trim()[0] ?? "?").toUpperCase() },
  };
}

interface MockTemplate { id: string; character: CharacterCreate; forged: boolean; saved_at: string }
interface MockAccount { id: string; username: string; password: string; display_name: string; templates: MockTemplate[]; campaigns: CampaignInfo[]; assets: WorkshopAsset[] }

function mockAbilityNames(c: CharacterCreate): string[] {
  const texts = c.ability_texts ?? (c.abilities ?? []).map((a) => `${a.name}: ${a.description}`);
  return texts.map((t) => {
    const head = t.split(":")[0] ?? t;
    return (head.length < t.length && head.length <= 40 ? head : t.split(/\s+/).slice(0, 3).join(" ")).trim().slice(0, 60);
  }).filter(Boolean).slice(0, 3);
}

const summaryOf = (t: MockTemplate): CharacterSummary => ({
  id: t.id, name: t.character.name, title: t.character.title, key_ability: t.character.key_ability,
  sprite_recipe: t.character.sprite_recipe ?? { kind: "shape", shape: "circle", color: "#9a6a3f", accent: "#e8c95a", glyph: (t.character.name.trim()[0] ?? "?").toUpperCase() },
  ability_names: mockAbilityNames(t.character), forged: t.forged, saved_at: t.saved_at,
});

/**
 * In-browser stand-in for apps/server. It speaks the same JSON envelope protocol through the same
 * Transport interface, so the UI cannot tell the difference. State lives for the page's lifetime and
 * survives reconnects (join_room with the issued token resumes the session).
 */
export class MockServer {
  private conn: { h: TransportHandlers; open: boolean } | null = null;
  private n = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private intervals = new Set<ReturnType<typeof setInterval>>();

  // room
  private code = "";
  private joined = false;
  private hostId = ME;
  private hostIsFake = false;
  private phase: "lobby" | "playing" = "lobby";
  private settings: Settings = { content_rating: "teen", campaign_pitch: "", dev_solo: false, plot_pattern: "auto", plot_arc: "auto", custom_cast: "host_approval", custom_paintings: true };
  private cast: CastEntry[] = [];
  private players: MockPlayer[] = [];
  private myName = "Player";
  private myChar: CharacterView | null = null;
  private resume: { save_id: string; name: string } | null = null;

  // accounts (in memory for the page's lifetime; the login itself belongs to the connection, as on the real server)
  private accounts = new Map<string, MockAccount>();
  private sessions = new Map<string, string>();
  private authUser: MockAccount | null = null;

  // game
  private scenes: Record<string, MockScene> = buildScenes();
  private scene: MockScene = this.scenes[FIRST_SCENE]!;
  private map: GameMap = this.scene.map;
  private ents: Record<string, EntityView> = {};
  private party: CharacterView[] = [];
  private seq = 0;
  private mode: "exploration" | "combat" = "exploration";
  private combat: { round: number; order: string[]; idx: number } | null = null;
  private actionUsed = false;
  private walkToken = 0;
  private turnTick: ReturnType<typeof setInterval> | undefined;
  private voteId = 0;
  private turnN = 0;
  private loot = new MockLoot({
    map: () => this.map,
    me: () => this.ents[ME_CHAR],
    mine: () => this.party.find((c) => c.id === ME_CHAR),
    party: () => this.party,
    entities: () => this.ents,
    emit: (type, payload, ack) => this.emit(type as ServerMessageType, payload, ack),
    fail: (code, message, ack) => this.fail(code, message, ack),
    engine: (text) => this.engine(text),
    diff: (extra) => this.diff([], [], extra),
    snapshot: () => this.sendSnapshot(),
    roll: (label, modifier, dc) => {
      const d = rnd(20);
      const total = d + modifier;
      this.emit("roll_result", { who: ME_CHAR, label, dice: [d], modifier, total, target: dc, outcome: d === 20 ? "crit" : d === 1 ? "fumble" : total >= dc ? "success" : "failure" });
      return d !== 1 && (d === 20 || total >= dc);
    },
  });

  /** Pass to GameClient. */
  readonly factory: TransportFactory = (h) => this.connect(h);

  /** Dev helper: drop the current connection so the client's reconnect path runs. */
  simulateDisconnect(): void {
    const c = this.conn;
    if (!c) return;
    c.open = false;
    this.conn = null;
    c.h.onClose();
  }

  private connect(h: TransportHandlers): Transport {
    const c = { h, open: false };
    this.conn = c;
    this.authUser = null;
    this.later(() => { c.open = true; h.onOpen(); }, 120);
    return {
      send: (raw) => { if (c.open) this.later(() => this.receive(raw), LATENCY_MS); },
      close: () => { c.open = false; if (this.conn === c) this.conn = null; },
    };
  }

  // ---------- plumbing ----------

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  private emit(type: ServerMessageType, payload: unknown, ack?: string): void {
    const c = this.conn;
    if (!c?.open) return;
    const msg = { v: WS_VERSION, type, id: `s${++this.n}`, ts: Date.now(), payload, ...(ack ? { ack_id: ack } : {}) };
    this.later(() => { if (c.open) c.h.onMessage(JSON.stringify(msg)); }, 20);
  }

  private fail(code: string, message: string, ack?: string): void {
    this.emit("error", { code, message, ...(ack ? { ack_id: ack } : {}) }, ack);
  }

  private sys(text: string): void { this.emit("log", { kind: "system", text }); }
  private engine(text: string): void { this.emit("log", { kind: "engine", text }); }
  private chat(from_id: string, from_name: string, channel: "ic" | "ooc" | "system", text: string): void {
    this.emit("chat", { from_id, from_name, channel, text });
  }

  private lobbyState(): void {
    this.emit("lobby_state", {
      room_id: "room_mock", invite_code: this.code, host_player_id: this.hostId, phase: this.phase,
      settings: this.settings, players: this.players,
      ...(this.resume ? { resume_save: this.resume } : {}),
    });
  }

  private me(): MockPlayer | undefined { return this.players.find((p) => p.player_id === ME); }

  // ---------- inbound ----------

  private receive(raw: string): void {
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return; }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) { this.fail("bad_message", "The mock server could not parse that message."); return; }
    const m = parsed.data;
    const ack = m.id;
    const p = m.payload as Payload;
    switch (m.type) {
      case "create_room": return this.onCreate(String(p.display_name), ack);
      case "join_room": return this.onJoin(String(p.invite_code), String(p.display_name), ack);
      case "ping": return this.emit("pong", {}, ack);
      case "design_sprite": {
        // Offline keyword designer, the same one the server falls back to.
        const spec = designSpriteOffline(
          { concept: String(p.prompt), name: String(p.name ?? ""), role: String(p.role_hint), kind: p.role_hint as "pc" | "npc" | "enemy" | "prop" },
          typeof p.seed === "number" ? p.seed : rnd(0x7ffffffe),
        );
        return this.emit("sprite_designed", { spec, notes: [], source: "offline" }, ack);
      }
      case "list_sprite_assets": case "save_sprite_asset": case "delete_sprite_asset":
        return this.onWorkshop(m.type, p, ack);
      case "register": case "login": case "resume_session": case "logout": case "list_characters":
      case "save_character_template": case "delete_character_template": case "list_campaigns": case "resume_campaign":
        return this.onAccount(m.type, p, ack);
      default: break;
    }
    if (!this.joined) return this.fail("forbidden", "Join a room first.", ack);
    switch (m.type) {
      case "set_ready": return this.onReady(Boolean(p.ready), ack);
      case "update_settings": return this.onSettings(p, ack);
      case "offer_to_cast": return this.onOffer(String(p.asset_id), ack);
      case "cast_decision": return this.onCastDecision(String(p.asset_id), Boolean(p.approve), ack);
      case "start_game": return this.onStart(ack);
      case "claim_character": return this.onClaim(m.payload as { character_id: string; character?: CharacterCreate; template_id?: string }, ack);
      case "move_intent": return this.onMove(p, ack);
      case "act": return this.onAct(String(p.verb), String(p.target_id), ack);
      case "basic_attack": return this.onBasicAttack(String(p.target_id), ack);
      case "use_ability": return this.onAbility(String(p.ability_id), p.target as string | { x: number; y: number }, ack);
      case "container_action": return this.loot.containerAction(String(p.verb), String(p.container_id), p.item_id as string | undefined, ack);
      case "inventory_action": return this.loot.inventoryAction(String(p.verb), String(p.item_id), p.to_character_id as string | undefined, ack);
      case "use_item": return this.fail("not_found", "You have no such item.", ack);
      case "end_turn": return this.onEndTurn(ack);
      case "say": return this.onSay(String(p.text), p.channel as "ic" | "ooc", ack);
      case "vote_cast": return this.onVoteCast(String(p.choice), ack);
      case "level_up_choice": return this.onLevelUpChoice(p, ack);
      case "request_save": return this.onSave(String(p.name), ack);
      case "load_save": return this.onLoadSave(String(p.save_id), ack);
      default: return;
    }
  }

  // ---------- lobby ----------

  private onCreate(name: string, ack: string): void {
    this.code = "K7M2QD";
    this.myName = name;
    this.hostId = ME;
    this.hostIsFake = false;
    this.phase = "lobby";
    this.players = [];
    this.cast = [];
    this.joined = false;
    this.emit("room_created", { room_id: "room_mock", invite_code: this.code }, ack);
  }

  private onJoin(code: string, name: string, ack: string): void {
    const c = code.toUpperCase();
    if (c === "NOPE") return this.fail("not_found", "No room with that invite code.", ack);
    const resuming = this.joined && c === this.code;
    this.myName = name;
    if (!resuming) {
      if (!this.code || c !== this.code) {
        // joining somebody else's room: Mira hosts, Dov and Sable are in the lobby
        this.code = c;
        this.cast = [];
        this.hostId = FAKES.mira.id;
        this.hostIsFake = true;
        this.players = [
          this.fake(FAKES.mira, true, true),
          this.fake(FAKES.dov, false, false),
          this.fake(FAKES.sable, true, true),
        ];
        this.settings.campaign_pitch = "A drowned lighthouse, a village that sleepwalks, and a choir nobody remembers hiring.";
        this.later(() => { this.setFake("p_dov", { ready: true, character_id: FAKES.dov.char.id }); }, 5000);
      }
      this.players.push({ player_id: ME, display_name: name, status: "online", ready: false, character_id: null });
      this.joined = true;
    } else {
      const me = this.me();
      if (me) { me.status = "online"; me.display_name = name; }
    }
    this.emit("joined", { player_id: ME, auth_token: "mock-token-abc123", room_id: "room_mock" }, ack);
    this.lobbyState();
    if (this.phase === "playing") { this.sendSnapshot(); if (this.pend.score + this.pend.picks > 0) this.sendLevelUp(); }
    if (!this.hostIsFake && !resuming) this.scriptHostLobby();
  }

  private fake(f: { id: string; name: string; char: { id: string } }, ready: boolean, withChar: boolean): MockPlayer {
    return { player_id: f.id, display_name: f.name, status: "online", ready, character_id: withChar ? f.char.id : null };
  }

  private setFake(id: string, patch: Partial<MockPlayer>): void {
    const p = this.players.find((x) => x.player_id === id);
    if (!p || this.phase !== "lobby") return;
    Object.assign(p, patch);
    if (patch.character_id) this.emit("character_claimed", { character_id: patch.character_id, player_id: id });
    this.lobbyState();
  }

  /** Host flow: friends trickle in after the room is created. */
  private scriptHostLobby(): void {
    this.later(() => this.addFake(FAKES.mira), 1200);
    this.later(() => this.addFake(FAKES.dov), 2600);
    this.later(() => this.setFake("p_mira", { ready: true, character_id: FAKES.mira.char.id }), 4200);
    this.later(() => this.setFake("p_dov", { ready: true, character_id: FAKES.dov.char.id }), 6500);
  }

  private addFake(f: { id: string; name: string }): void {
    if (this.phase !== "lobby" || this.players.some((p) => p.player_id === f.id)) return;
    this.players.push({ player_id: f.id, display_name: f.name, status: "online", ready: false, character_id: null });
    this.sys(`${f.name} joined the lobby.`);
    this.lobbyState();
  }

  // ---------- accounts ----------

  private authOk(a: MockAccount, ack: string, token?: string): void {
    this.authUser = a;
    this.emit("auth_ok", {
      user: { id: a.id, username: a.username, display_name: a.display_name },
      ...(token ? { session_token: token } : {}),
      characters: a.templates.map(summaryOf),
    }, ack);
  }

  private newSession(a: MockAccount): string {
    const token = `mock-session-${a.username}-${Math.random().toString(36).slice(2, 12)}`;
    this.sessions.set(token, a.username);
    return token;
  }

  private onAccount(type: string, p: Payload, ack: string): void {
    const authErr = (code: string, message: string) => this.emit("auth_error", { code, message }, ack);
    switch (type) {
      case "register": {
        const input = { username: String(p.username), password: String(p.password), display_name: String(p.display_name) };
        const problem = validateRegistration(input);
        if (problem) return authErr("invalid", problem);
        const username = input.username.trim().toLowerCase();
        if (this.accounts.has(username)) return authErr("username_taken", "That username is taken.");
        const a: MockAccount = { id: `u_mock_${username}`, username, password: input.password, display_name: input.display_name.trim(), templates: [], campaigns: [], assets: [] };
        this.accounts.set(username, a);
        return this.authOk(a, ack, this.newSession(a));
      }
      case "login": {
        const a = this.accounts.get(String(p.username).trim().toLowerCase());
        if (!a || a.password !== p.password) return authErr("invalid_credentials", "Wrong username or password.");
        return this.authOk(a, ack, this.newSession(a));
      }
      case "resume_session": {
        const name = this.sessions.get(String(p.session_token));
        const a = name ? this.accounts.get(name) : undefined;
        if (!a) return authErr("invalid_credentials", "Your session has expired. Please log in again.");
        return this.authOk(a, ack);
      }
      case "logout":
        this.authUser = null;
        return this.emit("logged_out", {}, ack);
      default: break;
    }
    const a = this.authUser;
    if (!a) return this.fail("forbidden", "Log in to do that.", ack);
    switch (type) {
      case "list_characters":
        return this.emit("characters_list", { characters: a.templates.map(summaryOf) }, ack);
      case "save_character_template": {
        const character = p.character as CharacterCreate;
        const existing = a.templates.find((t) => t.character.name.toLowerCase() === character.name.toLowerCase());
        const tpl: MockTemplate = { id: existing?.id ?? `ch_mock_${a.templates.length + 1}_${this.n}`, character, forged: existing?.forged ?? false, saved_at: new Date().toISOString() };
        if (existing) a.templates[a.templates.indexOf(existing)] = tpl;
        else a.templates.push(tpl);
        return this.emit("characters_list", { characters: a.templates.map(summaryOf) }, ack);
      }
      case "delete_character_template": {
        const i = a.templates.findIndex((t) => t.id === p.id);
        if (i < 0) return this.fail("not_found", "No such saved character.", ack);
        a.templates.splice(i, 1);
        return this.emit("characters_list", { characters: a.templates.map(summaryOf) }, ack);
      }
      case "list_campaigns":
        return this.emit("campaigns_list", { campaigns: a.campaigns }, ack);
      case "resume_campaign": {
        const c = a.campaigns.find((x) => x.save_id === p.save_id);
        if (!c) return this.fail("not_found", "No such campaign.", ack);
        this.onCreate(a.display_name, ack);
        this.resume = { save_id: c.save_id, name: c.name };
        return;
      }
      default: return;
    }
  }

  private onSave(name: string, ack: string): void {
    const id = `sv_${this.n}`;
    const a = this.authUser;
    if (a) {
      a.campaigns = a.campaigns.filter((c) => c.kind !== "autosave");
      a.campaigns.unshift({
        save_id: id, room_id: "room_mock", kind: "named", name, campaign_title: "The Lantern Marsh",
        updated_at: new Date().toISOString(), players: this.players.map((x) => x.display_name).slice(0, 6), can_resume: true,
      });
    }
    this.emit("save_created", { save_id: id, name }, ack);
  }

  private onLoadSave(saveId: string, ack: string): void {
    if (this.hostId !== ME) return this.fail("not_host", "Only the host can load a save.", ack);
    if (!this.resume || this.resume.save_id !== saveId) return this.fail("not_found", "No such save.", ack);
    this.resume = null;
    if (!this.myChar) {
      this.myChar = { ...toView(fixtures.BRINDLE), id: ME_CHAR };
      const me = this.me();
      if (me) me.character_id = ME_CHAR;
    }
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    this.beginGame();
  }

  private onClaim(p: { character_id: string; character?: CharacterCreate; template_id?: string }, ack: string): void {
    if (this.phase !== "lobby") return this.fail("invalid_state", "The game has already started.", ack);
    if (p.character_id === "template") {
      const tpl = this.authUser?.templates.find((t) => t.id === p.template_id);
      if (!tpl) return this.fail("not_found", "No such saved character. Log in to use your saved characters.", ack);
      p = { character_id: "new", character: tpl.character };
      tpl.forged = true;
      this.emit("characters_list", { characters: this.authUser?.templates.map(summaryOf) ?? [] });
    }
    if (p.character_id !== "new" || !p.character) return this.fail("not_found", "No such character.", ack);
    this.myChar = mockCharacterFrom(p.character);
    const me = this.me();
    if (me) { me.character_id = ME_CHAR; me.ready = false; }
    this.emit("character_claimed", { character_id: ME_CHAR, player_id: ME }, ack);
    this.lobbyState();
    this.engine(`The forge shaped ${this.myChar.abilities.length} abilit${this.myChar.abilities.length === 1 ? "y" : "ies"} for ${this.myChar.name}.`);
  }

  private onReady(ready: boolean, ack: string): void {
    const me = this.me();
    if (!me) return;
    if (ready && !me.character_id) return this.fail("invalid_state", "Create your character before readying up.", ack);
    me.ready = ready;
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    this.lobbyState();
    if (this.hostIsFake && ready) this.later(() => { if (me.ready && this.phase === "lobby") this.beginGame(); }, 2200);
  }

  private onSettings(p: Payload, ack: string): void {
    if (this.hostId !== ME) return this.fail("not_host", "Only the host can change settings.", ack);
    Object.assign(this.settings, p);
    if (p.custom_cast === "open") for (const c of this.cast) c.status = "approved";
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    this.lobbyState();
    if (p.custom_cast !== undefined || p.custom_paintings !== undefined) this.castState();
  }

  // ---------- Workshop and campaign cast ----------

  private workshopList(a: MockAccount, ack?: string): void {
    const sorted = [...a.assets].sort((x, y) => (x.updated_at < y.updated_at ? 1 : -1));
    const used = a.assets.reduce((n, x) => n + JSON.stringify(x).length, 0);
    this.emit("sprite_assets_list", { assets: sorted, used_bytes: used, max_assets: WORKSHOP_MAX_ASSETS, max_bytes: WORKSHOP_MAX_BYTES }, ack);
  }

  private onWorkshop(type: string, p: Payload, ack: string): void {
    const a = this.authUser;
    if (!a) return this.fail("forbidden", "Log in to use your Workshop.", ack);
    if (type === "save_sprite_asset") {
      const now = new Date().toISOString();
      const existing = typeof p.id === "string" ? a.assets.find((x) => x.id === p.id) : undefined;
      if (typeof p.id === "string" && !existing) return this.fail("not_found", "No such Workshop sprite.", ack);
      if (!existing && a.assets.length >= WORKSHOP_MAX_ASSETS) return this.fail("invalid_state", `Your Workshop holds ${WORKSHOP_MAX_ASSETS} sprites. Delete one first.`, ack);
      const asset = {
        id: existing?.id ?? `as_mock_${++this.n}`, name: p.name, role_hint: p.role_hint, concept: p.concept, tags: p.tags ?? [],
        recipe: p.recipe, source: p.source, created_at: existing?.created_at ?? now, updated_at: now,
      } as WorkshopAsset;
      if (existing) a.assets[a.assets.indexOf(existing)] = asset;
      else a.assets.push(asset);
    } else if (type === "delete_sprite_asset") {
      const i = a.assets.findIndex((x) => x.id === p.id);
      if (i < 0) return this.fail("not_found", "No such Workshop sprite.", ack);
      a.assets.splice(i, 1);
    }
    this.workshopList(a, ack);
  }

  private castState(): void { this.emit("cast_state", { entries: this.cast }); }

  private onOffer(assetId: string, ack: string): void {
    const a = this.authUser;
    if (!a) return this.fail("forbidden", "Log in to offer a sprite from your Workshop.", ack);
    const mode = this.settings.custom_cast ?? "host_approval";
    if (mode === "off") return this.fail("forbidden", "The host has turned custom sprites off for this room.", ack);
    if (this.cast.some((c) => c.asset_id === assetId)) return this.emit("presence", { player_id: ME, status: "online" }, ack);
    const asset = a.assets.find((x) => x.id === assetId);
    if (!asset) return this.fail("not_found", "No such sprite in your Workshop.", ack);
    if (asset.role_hint !== "npc" && asset.role_hint !== "enemy") return this.fail("invalid_state", "Only NPC and enemy looks can join the cast.", ack);
    if (asset.recipe.kind === "pixel" && this.settings.custom_paintings === false) return this.fail("forbidden", "The host has turned painted sprites off for this room.", ack);
    this.cast.push({
      asset_id: asset.id, owner_player_id: ME, owner_name: this.myName.slice(0, 24) || "You", name: asset.name, role_hint: asset.role_hint,
      concept: asset.concept, recipe: asset.recipe, status: mode === "open" || this.hostId === ME ? "approved" : "pending",
    });
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    this.castState();
  }

  private onCastDecision(assetId: string, approve: boolean, ack: string): void {
    const entry = this.cast.find((c) => c.asset_id === assetId);
    if (!entry) return this.fail("not_found", "That sprite is not in the cast.", ack);
    const isHost = this.hostId === ME;
    if (!approve) {
      if (!isHost && entry.owner_player_id !== ME) return this.fail("not_host", "Only the host can remove a sprite from the cast.", ack);
      this.cast.splice(this.cast.indexOf(entry), 1);
    } else {
      if (!isHost) return this.fail("not_host", "Only the host can approve a sprite for the cast.", ack);
      entry.status = "approved";
    }
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    this.castState();
  }

  /** Dev helper: a fake player offers a look to the cast (shows the host's approval flow). */
  simulateOffer(): void {
    const owner = this.players.find((p) => p.player_id !== ME) ?? { player_id: FAKES.mira.id, display_name: FAKES.mira.name };
    if (!this.joined) return;
    const mode = this.settings.custom_cast ?? "host_approval";
    if (mode === "off") return;
    const n = this.cast.length + 1;
    this.cast.push({
      asset_id: `as_mock_fake_${n}`, owner_player_id: owner.player_id, owner_name: owner.display_name.slice(0, 24), name: `Fogwalker ${n}`, role_hint: "enemy",
      concept: "a gaunt figure in drowned-blue robes",
      recipe: designSpriteOffline({ concept: "a gaunt figure in drowned-blue robes", name: "Fogwalker", role: "standard", kind: "enemy" }, n),
      status: mode === "open" ? "approved" : "pending",
    });
    this.castState();
  }

  private onStart(ack: string): void {
    if (this.hostId !== ME) return this.fail("not_host", "Only the host can start the game.", ack);
    const ready = this.players.filter((x) => x.ready).length;
    if (ready < 2 && !this.settings.dev_solo) return this.fail("invalid_state", "At least two players must be ready.", ack);
    if (!this.me()?.character_id) return this.fail("invalid_state", "Create your character first.", ack);
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    this.beginGame();
  }

  // ---------- game start ----------

  /** Like the real server's autosave: one entry per campaign, replaced as play goes on. */
  private recordAutosave(): void {
    const a = this.authUser;
    if (!a) return;
    a.campaigns = a.campaigns.filter((c) => c.kind !== "autosave");
    a.campaigns.unshift({
      save_id: "autosave", room_id: "room_mock", kind: "autosave", name: "autosave", campaign_title: "The Lantern Marsh",
      updated_at: new Date().toISOString(), players: this.players.map((x) => x.display_name).slice(0, 6), can_resume: true,
    });
  }

  private beginGame(): void {
    this.phase = "playing";
    this.recordAutosave();
    this.scenes = buildScenes();
    this.scene = this.scenes[FIRST_SCENE]!;
    this.map = this.scene.map;
    this.ents = {};
    this.party = [];
    this.seq = 0;
    this.mode = "exploration";
    this.combat = null;
    const squad = this.settings.dev_solo ? [] : this.players.filter((p) => p.player_id !== ME && p.ready && p.character_id);
    const myChar = this.myChar!;
    this.party.push({ ...myChar, inventory: starterPack() });
    this.loot.reset();
    this.addPc(myChar, ME, { x: 13, y: 10 });
    for (const pl of squad) {
      const f = Object.values(FAKES).find((x) => x.id === pl.player_id);
      if (!f) continue;
      this.party.push({ ...toView(f.char), inventory: [] });
      this.addPc(toView(f.char), f.id, f.start);
    }
    for (const e of this.scene.entities) this.ents[e.id] = structuredClone(e);
    this.lobbyState();
    this.sendSnapshot();
    this.script();
  }

  private addPc(c: CharacterView, owner: string, at: { x: number; y: number }): void {
    this.ents[c.id] = {
      id: c.id, kind: "pc", name: c.name.split(" ")[0] ?? c.name, x: at.x, y: at.y, hp: c.hp, hp_max: c.hp_max,
      conditions: [], sprite: c.sprite_recipe, owner_player_id: owner,
    };
  }

  private sendSnapshot(): void {
    this.emit("state_snapshot", {
      seq: ++this.seq, mode: this.mode, map: this.map, entities: Object.values(this.ents), party: this.party,
      containers: this.loot.summaries(),
      quests: [{ id: "q_lantern", title: "The Drowned Lantern", status: "active", notes: ["Odalys says three villagers sleepwalk toward the marsh."] },
        { id: "q_choir", title: "Who hired the choir?", status: "new", notes: [] }],
      ...(this.combat ? { combat: this.combatState() } : {}),
    });
  }

  private script(): void {
    this.sys(`Campaign started: ${this.settings.campaign_pitch || "The Drowned Lantern"}.`);
    this.later(() => this.narrate(NARRATION_OPENING, () => {
      this.later(() => {
        this.emit("roll_result", { who: ME_CHAR, label: "Perception: scan the square", dice: [14], modifier: 2, total: 16, target: 12, outcome: "success" });
        this.engine("You notice the robed figures never blink.");
        this.emit("chips", { chips: ["Talk to Odalys", "Look around", "Go to the crypt", "Go to the snowy trail"] });
      }, 500);
    }), 700);
    this.later(() => this.chat(FAKES.mira.id, "Mira", "ooc", "ready when you are"), 5000);
    const wander = setInterval(() => this.wander(), 3500);
    this.intervals.add(wander);
  }

  private wander(): void {
    if (this.mode !== "exploration" || this.phase !== "playing") return;
    const fake = Object.values(this.ents).filter((e) => e.kind === "pc" && e.owner_player_id !== ME);
    const e = fake[rnd(fake.length) - 1];
    if (!e) return;
    const dx = rnd(3) - 2, dy = rnd(3) - 2;
    const nx = e.x + dx, ny = e.y + dy;
    if (this.free(nx, ny) && cheb({ x: nx, y: ny }, this.scene.start) <= 4) this.moveEntity(e, nx, ny);
  }

  // ---------- helpers ----------

  private occupant(x: number, y: number): EntityView | undefined {
    return Object.values(this.ents).find((e) => e.x === x && e.y === y && e.hp > 0);
  }

  private free(x: number, y: number): boolean {
    return !blockedAt(this.map, x, y) && !this.occupant(x, y);
  }

  private diff(changed: EntityView[], removed: string[] = [], extra: Payload = {}): void {
    this.emit("state_diff", { seq: ++this.seq, changed, removed, ...extra });
  }

  private moveEntity(e: EntityView, x: number, y: number): void {
    e.x = x; e.y = y;
    this.diff([{ ...e }]);
  }

  private narrate(text: string, done?: () => void): void {
    const id = `t${++this.turnN}`;
    const words = text.split(" ");
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += 5) chunks.push(`${words.slice(i, i + 5).join(" ")} `);
    chunks.forEach((c, i) => {
      this.later(() => {
        const last = i === chunks.length - 1;
        this.emit("narration_chunk", { turn_id: id, text: last ? c.trimEnd() : c, done: last });
        if (last) done?.();
      }, 160 * (i + 1));
    });
  }

  private pcs(): EntityView[] { return Object.values(this.ents).filter((e) => e.kind === "pc"); }
  private enemies(): EntityView[] { return Object.values(this.ents).filter((e) => e.kind === "enemy" && e.hp > 0); }

  private nearest(from: EntityView, list: EntityView[]): EntityView | undefined {
    return [...list].sort((a, b) => cheb(from, a) - cheb(from, b))[0];
  }

  // ---------- movement ----------

  private onMove(p: Payload, ack: string): void {
    const me = this.ents[ME_CHAR];
    if (!me || this.phase !== "playing") return this.fail("invalid_state", "The game has not started.", ack);
    if (this.combat && this.activeId() !== ME_CHAR) return this.fail("invalid_state", "It is not your turn.", ack);
    let dest: { x: number; y: number };
    if (typeof p.direction === "string") {
      const d = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[p.direction as "n"] ?? [0, 0];
      dest = { x: me.x + d[0]!, y: me.y + d[1]! };
    } else dest = { x: Number(p.x), y: Number(p.y) };
    if (blockedAt(this.map, dest.x, dest.y)) return this.fail("invalid_state", "Something blocks the way.", ack);
    const occ = this.occupant(dest.x, dest.y);
    if (occ && occ.id !== me.id) return this.fail("invalid_state", `${occ.name} is in the way.`, ack);
    const path = this.findPath(me, dest);
    if (!path) return this.fail("invalid_state", "You can't reach that tile.", ack);
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    const limit = this.combat ? 6 : 14;
    this.walk(me, path.slice(0, limit));
  }

  private findPath(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] | null {
    const W = this.map.width, H = this.map.height;
    const key = (x: number, y: number) => y * W + x;
    const prev = new Map<number, number>();
    const q: { x: number; y: number }[] = [from];
    prev.set(key(from.x, from.y), -1);
    while (q.length) {
      const cur = q.shift()!;
      if (cur.x === to.x && cur.y === to.y) {
        const out: { x: number; y: number }[] = [];
        for (let k = key(cur.x, cur.y); k !== key(from.x, from.y); k = prev.get(k)!) out.unshift({ x: k % W, y: Math.floor(k / W) });
        return out;
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cur.x + dx, ny = cur.y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || prev.has(key(nx, ny))) continue;
          if (!this.free(nx, ny)) continue;
          if (dx && dy && (blockedAt(this.map, cur.x + dx, cur.y) || blockedAt(this.map, cur.x, cur.y + dy))) continue;
          prev.set(key(nx, ny), key(cur.x, cur.y));
          q.push({ x: nx, y: ny });
        }
      }
    }
    return null;
  }

  private walk(e: EntityView, path: { x: number; y: number }[]): void {
    const token = ++this.walkToken;
    path.forEach((step, i) => {
      this.later(() => {
        if (token !== this.walkToken || !this.free(step.x, step.y)) return;
        this.moveEntity(e, step.x, step.y);
        const exit = e.id === ME_CHAR ? this.exitAt(step.x, step.y) : null;
        if (exit && !this.combat) { this.travel(exit); return; }
        if (!this.combat && this.enemies().some((en) => cheb(en, e) <= 4)) this.startCombat();
      }, 110 * i);
    });
  }

  private exitAt(x: number, y: number): string | null {
    for (const l of this.map.layers) {
      if (l.type !== "objectgroup") continue;
      for (const o of l.objects) if (o.type === "exit" && o.x === x && o.y === y && this.scenes[o.to]) return o.to;
    }
    return null;
  }

  private nearestFree(x: number, y: number, taken: Set<string>): { x: number; y: number } {
    for (let r = 0; r < 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (!blockedAt(this.map, nx, ny) && !taken.has(`${nx},${ny}`)) return { x: nx, y: ny };
        }
      }
    }
    return { x, y };
  }

  /** Move the party to another mock map: new snapshot, new cast, a line of narration. */
  private travel(id: string): void {
    const next = this.scenes[id];
    if (!next || this.phase !== "playing") return;
    if (this.combat) return this.engine("You cannot slip away in the middle of a fight.");
    if (next === this.scene) return this.engine("You are already here.");
    this.walkToken++;
    this.scene = next;
    this.map = next.map;
    const pcs = Object.values(this.ents).filter((e) => e.kind === "pc");
    this.ents = {};
    const taken = new Set<string>();
    pcs.sort((a, b) => (a.id === ME_CHAR ? -1 : b.id === ME_CHAR ? 1 : 0)).forEach((pc) => {
      const at = this.nearestFree(next.start.x, next.start.y, taken);
      taken.add(`${at.x},${at.y}`);
      this.ents[pc.id] = { ...pc, x: at.x, y: at.y };
    });
    for (const e of next.entities) this.ents[e.id] = structuredClone(e);
    this.sendSnapshot();
    this.sys(`The party arrives at ${next.title}.`);
    this.narrate(next.arrival, () => this.emit("chips", { chips: next.chips }));
  }

  // ---------- chat and acts ----------

  private onSay(text: string, channel: "ic" | "ooc", ack: string): void {
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    this.chat(ME, this.myName, channel, text);
    if (channel === "ooc") {
      if (/vote/i.test(text)) this.startVote();
      return;
    }
    if (this.phase !== "playing") return;
    if (/vote/i.test(text)) return this.startVote();
    const dest = /\b(go|travel|head|walk|descend|enter|return|take us|back)\b/i.test(text) ? sceneFromText(text) : null;
    if (dest) return this.travel(dest);
    if (/attack|fight|chorister|battle|strike/i.test(text)) {
      this.narrate("You step toward the grey-robed figures. Their heads turn in perfect unison, and the humming stops. Then it begins again, higher, and wrong.", () => this.startCombat());
    } else if (/odalys|inn|talk|ask/i.test(text)) {
      this.later(() => this.chat("npc_odalys", "Odalys", "ic", "Three of my regulars walked into the marsh last night, humming. Please, find out why."), 500);
      this.narrate("Odalys sets her broom against the porch rail and wipes her hands on her apron, glancing toward the reeds.");
    } else {
      this.narrate("The village holds its breath. A lantern swings though there is no wind, and the humming from the marsh swells, then settles.");
    }
    this.later(() => this.emit("chips", { chips: this.scene.id === FIRST_SCENE ? ["Talk to Odalys", "Check the chest", "Go to the crypt"] : this.scene.chips }), 1500);
  }

  private onAct(verb: string, target: string, ack: string): void {
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    if (this.loot.act(verb, target, ack)) return;
    const ent = this.ents[target];
    const obj = this.map.layers.flatMap((l) => (l.type === "objectgroup" ? l.objects : [])).find((o) => "id" in o && o.id === target);
    if (!ent && !obj) return this.fail("not_found", "There is nothing like that here.", ack);
    if (verb === "examine") {
      const text = ent
        ? ent.kind === "enemy" ? `${ent.name}: a grey-robed singer whose borrowed voice is not their own. ${ent.hp}/${ent.hp_max} HP.`
          : `${ent.name}: ${ent.kind === "npc" ? "weary but watchful" : "one of your party"}. ${ent.hp}/${ent.hp_max} HP.`
        : `You study the ${obj && "kind" in obj ? obj.kind : "thing"}.`;
      return this.engine(text);
    }
    if (verb === "talk" && ent) {
      if (ent.kind === "enemy") return this.chat(ent.id, ent.name, "ic", "...hhhmmmmm...");
      return this.chat(ent.id, ent.name, "ic", ent.kind === "npc" ? "Mind the marsh road after dark, friends." : "Hm?");
    }
    this.engine(`You ${verb} ${ent?.name ?? "it"}. Nothing obvious happens.`);
  }

  // ---------- combat ----------

  private activeId(): string | undefined {
    return this.combat ? this.combat.order[this.combat.idx] : undefined;
  }

  private combatState() {
    const c = this.combat!;
    return {
      round: c.round,
      order: c.order.map((id, i) => ({ entity_id: id, initiative: 20 - i * 2 })),
      active_id: c.order[c.idx]!,
    };
  }

  private startCombat(): void {
    if (this.combat) return;
    const en = this.enemies().map((e) => e.id);
    const allies = this.pcs().filter((e) => e.id !== ME_CHAR).map((e) => e.id);
    const order = [ME_CHAR, allies[1], en[0], allies[0], en[1], ...allies.slice(2)].filter((x): x is string => !!x);
    this.combat = { round: 1, order, idx: 0 };
    this.mode = "combat";
    this.actionUsed = false;
    this.walkToken++;
    this.engine("Combat begins. Initiative is rolled.");
    this.emit("roll_result", { who: ME_CHAR, label: "Initiative", dice: [15], modifier: 3, total: 18, target: 0, outcome: "success" });
    this.diff([], [], { mode: "combat", combat: this.combatState() });
    this.emit("combat_state", this.combatState());
    this.beginTurn();
  }

  private beginTurn(): void {
    clearInterval(this.turnTick);
    const id = this.activeId();
    if (!id || !this.combat) return;
    this.actionUsed = false;
    if (id === ME_CHAR) {
      let left = 30;
      this.emit("turn_timer", { entity_id: id, seconds_left: left });
      this.turnTick = setInterval(() => {
        left--;
        this.emit("turn_timer", { entity_id: id, seconds_left: Math.max(0, left) });
        if (left <= 0) { this.engine("Your turn timer ran out."); this.nextTurn(); }
      }, 1000);
      this.intervals.add(this.turnTick);
    } else {
      this.emit("turn_timer", { entity_id: id, seconds_left: 8 });
      this.later(() => this.npcTurn(id), 1100);
    }
  }

  private nextTurn(): void {
    clearInterval(this.turnTick);
    const c = this.combat;
    if (!c) return;
    do {
      c.idx = (c.idx + 1) % c.order.length;
      if (c.idx === 0) c.round++;
    } while (!this.ents[c.order[c.idx]!] || this.ents[c.order[c.idx]!]!.hp <= 0);
    this.emit("combat_state", this.combatState());
    this.beginTurn();
  }

  private npcTurn(id: string): void {
    const actor = this.ents[id];
    if (!this.combat || !actor || this.activeId() !== id) return;
    const foes = actor.kind === "enemy" ? this.pcs().filter((e) => e.hp > 0) : this.enemies();
    const foe = this.nearest(actor, foes);
    if (!foe) return this.nextTurn();
    if (cheb(actor, foe) > 1) {
      for (let i = 0; i < 3 && cheb(actor, foe) > 1; i++) {
        const opts: { x: number; y: number }[] = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && this.free(actor.x + dx, actor.y + dy)) opts.push({ x: actor.x + dx, y: actor.y + dy });
        opts.sort((a, b) => cheb(a, foe) - cheb(b, foe));
        const best = opts[0];
        if (!best || cheb(best, foe) >= cheb(actor, foe)) break;
        actor.x = best.x; actor.y = best.y;
      }
      this.diff([{ ...actor }]);
    }
    if (cheb(actor, foe) <= 1) this.resolveAttack(actor, foe, actor.kind === "enemy" ? 3 : 4, actor.kind === "enemy" ? 13 : 12);
    this.later(() => this.afterAction(), 900);
  }

  private resolveAttack(att: EntityView, tgt: EntityView, bonus: number, defense: number): boolean {
    const d = rnd(20);
    const total = d + bonus;
    const outcome = d === 20 ? "crit" : d === 1 ? "fumble" : total >= defense ? "success" : "failure";
    this.emit("roll_result", { who: att.id, label: `${att.name} attacks ${tgt.name}`, dice: [d], modifier: bonus, total, target: defense, outcome });
    if (outcome === "success" || outcome === "crit") {
      const dmg = (att.kind === "enemy" ? rnd(6) + 1 : rnd(8) + 2) * (outcome === "crit" ? 2 : 1);
      this.damage(tgt, dmg);
      return true;
    }
    return false;
  }

  private damage(tgt: EntityView, dmg: number): void {
    const floor = tgt.kind === "pc" ? 1 : 0; // the party is never wiped in the mock
    tgt.hp = Math.max(floor, tgt.hp - dmg);
    this.engine(`${tgt.name} takes ${dmg} damage (${tgt.hp}/${tgt.hp_max} HP).`);
    if (tgt.hp <= 0 && tgt.kind === "enemy") {
      this.engine(`${tgt.name} is down.`);
      const c = this.combat;
      if (c) {
        const idx = c.order.indexOf(tgt.id);
        if (idx >= 0) { c.order.splice(idx, 1); if (idx < c.idx) c.idx--; }
      }
      delete this.ents[tgt.id];
      this.diff([], [tgt.id], this.combat ? { combat: this.combatState() } : {});
    } else this.diff([{ ...tgt }]);
  }

  private afterAction(): void {
    if (!this.combat) return;
    if (this.enemies().length === 0) return this.endCombat();
    this.nextTurn();
  }

  private endCombat(): void {
    clearInterval(this.turnTick);
    this.combat = null;
    this.mode = "exploration";
    this.diff([], [], { mode: "exploration" });
    this.engine("Combat ends: victory.");
    this.narrate("The last chorister folds like wet paper, and the humming stops. In the silence, the marsh exhales. Odalys lets out a long, shaky breath from the porch.", () => {
      this.emit("chips", { chips: ["Search the robes", "Talk to Odalys", "Head for the marsh"] });
      this.grantLevelUps();
    });
  }

  // ---------- level-up (mock) ----------

  private pend = { score: 0, picks: 0 };
  private levelUpGranted = false;

  private budgetFor(level: number): { budget: number; cap: number } {
    const budget = 25 + 5 * level;
    return { budget, cap: Math.floor((budget * 45) / 100) };
  }

  private sendLevelUp(): void {
    const c = this.myChar;
    if (!c) return;
    const { budget, cap } = this.budgetFor(c.level);
    this.emit("level_up_state", {
      character_id: c.id, level: c.level, score_points: this.pend.score, ability_picks: this.pend.picks,
      budget, budget_used: c.abilities.reduce((n, a) => n + (a.cost ?? 0), 0), per_ability_cap: cap,
      caps: { max_avg: 5 + 2 * c.level, max_radius: c.level >= 5 ? 2 : 1, max_stun_turns: c.level >= 7 ? 2 : 1 },
      max_abilities: 6, abilities: c.abilities, scores: c.scores,
    });
  }

  /** Once, after the first victory: Brindle jumps to level 3 (1 score point, 2 ability picks). */
  /** Dev hook (also called after the first mock victory): `__mock.grantLevelUps()`. */
  grantLevelUps(): void {
    const c = this.myChar;
    if (!c || this.levelUpGranted) return;
    this.levelUpGranted = true;
    c.growth += 200;
    for (let lv = c.level + 1; lv <= 3; lv++) {
      c.level = lv;
      c.hp_max += 6 + Math.floor((c.scores.con - 10) / 2);
      this.pend.picks += 1;
      if (lv === 3) this.pend.score += 1;
      this.engine(`${c.name.split(" ")[0]} reaches level ${lv}.${lv === 3 ? " +1 ability score available." : ""}`);
    }
    c.hp = c.hp_max;
    const e = this.ents[c.id];
    if (e) { e.hp = c.hp_max; e.hp_max = c.hp_max; }
    this.sendSnapshot();
    this.sendLevelUp();
  }

  private onLevelUpChoice(p: Payload, ack: string): void {
    const c = this.myChar;
    if (!c || (this.pend.score === 0 && this.pend.picks === 0)) return this.fail("invalid_state", "You have no level-up choices pending.", ack);
    if (this.combat) return this.fail("invalid_state", "Finish the fight first.", ack);
    const result = (ok: boolean, message: string, ability?: Ability, notes: string[] = []) =>
      this.emit("level_up_result", { ok, message, forge_notes: notes, ...(ability ? { ability } : {}) }, ack);
    const first = c.name.split(" ")[0];
    const kind = String(p.kind);
    if (kind === "score") {
      const k = p.ability as keyof typeof c.scores;
      if (this.pend.score <= 0) return this.fail("invalid_state", "You have no ability score point to spend.", ack);
      if (c.scores[k] >= 20) return result(false, `${String(k).toUpperCase()} is already 20.`);
      c.scores[k] += 1;
      this.pend.score -= 1;
      this.sys(`${first} raised ${String(k).toUpperCase()} to ${c.scores[k]}.`);
      this.sendSnapshot();
      result(true, `${first} raised ${String(k).toUpperCase()} to ${c.scores[k]}.`);
    } else {
      if (this.pend.picks <= 0) return this.fail("invalid_state", "You have no ability pick to spend.", ack);
      if (kind === "skip_ability") {
        this.pend.picks -= 1;
        result(true, "You keep your abilities as they are.");
      } else {
        const replacing = kind === "reforge" ? String(p.ability_id) : null;
        const old = replacing ? c.abilities.find((a) => a.id === replacing) : undefined;
        if (replacing && !old) return result(false, "You do not have that ability.");
        if (!replacing && c.abilities.length >= 6) return result(false, "You already know as many abilities as you can. Reforge one instead.");
        const ab = mockAbilityFrom(String(p.text), `ab_me_${++this.n}`);
        const used = c.abilities.reduce((n, a) => n + (a === old ? 0 : (a.cost ?? 0)), 0);
        if (used + (ab.cost ?? 0) > this.budgetFor(c.level).budget) return result(false, "That does not fit your remaining power budget.");
        this.later(() => {
          if (old) c.abilities[c.abilities.indexOf(old)] = ab;
          else c.abilities.push(ab);
          this.pend.picks -= 1;
          this.sys(old ? `${first} reforged ${old.name} into ${ab.name}.` : `${first} learned ${ab.name}.`);
          this.sendSnapshot();
          result(true, old ? `${first} reforged ${old.name} into ${ab.name}.` : `${first} learned ${ab.name}.`, ab, [ab.forge_notes ?? ""].filter(Boolean));
          this.sendLevelUp();
        }, 900);
        return;
      }
    }
    this.sendLevelUp();
  }

  private onBasicAttack(target: string, ack: string): void {
    const me = this.ents[ME_CHAR];
    const tgt = this.ents[target];
    if (!me || !tgt) return this.fail("not_found", "That target is gone.", ack);
    if (!this.combat) { this.emit("presence", { player_id: ME, status: "online" }, ack); this.startCombat(); return; }
    if (this.activeId() !== ME_CHAR) return this.fail("invalid_state", "It is not your turn.", ack);
    if (tgt.kind !== "enemy") return this.fail("invalid_state", "That is not an enemy.", ack);
    if (this.actionUsed) return this.fail("invalid_state", "You already used your action this turn.", ack);
    if (cheb(me, tgt) > 1) return this.fail("invalid_state", "Too far away: move next to the target first.", ack);
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    this.actionUsed = true;
    this.resolveAttack(me, tgt, 4, 12);
    this.later(() => { if (this.enemies().length === 0) this.endCombat(); }, 400);
  }

  private onAbility(abilityId: string, target: string | { x: number; y: number }, ack: string): void {
    const me = this.ents[ME_CHAR];
    const ab = this.party.find((c) => c.id === ME_CHAR)?.abilities.find((a) => a.id === abilityId)
      ?? this.party.flatMap((c) => c.abilities).find((a) => a.id === abilityId);
    if (!me || !ab) return this.fail("not_found", "You don't know that ability.", ack);
    if (this.combat && this.activeId() !== ME_CHAR) return this.fail("invalid_state", "It is not your turn.", ack);
    if (this.combat && ab.action === "action" && this.actionUsed) return this.fail("invalid_state", "You already used your action this turn.", ack);
    const tgtEnt = typeof target === "string" ? this.ents[target] : undefined;
    const tilePos = typeof target === "string" ? tgtEnt : target;
    if (!tilePos) return this.fail("not_found", "That target is gone.", ack);
    if (cheb(me, tilePos) > Math.max(ab.range_tiles, 0)) return this.fail("invalid_state", `Out of range (${ab.range_tiles} tiles).`, ack);
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    if (this.combat && ab.action === "action") this.actionUsed = true;
    const fx = ab.effects[0];
    this.engine(`${me.name} uses ${ab.name}.`);
    if (fx?.type === "damage" && tgtEnt && tgtEnt.kind !== "pc") {
      const { count, sides } = parseDice(fx.dice);
      let total = 0;
      const dice: number[] = [];
      for (let i = 0; i < count; i++) { const d = rnd(sides); dice.push(d); total += d; }
      this.emit("roll_result", { who: ME_CHAR, label: `${ab.name} damage`, dice, modifier: 0, total, target: 0, outcome: "success" });
      this.damage(tgtEnt, total);
    } else if (fx?.type === "heal") {
      const { count, sides } = parseDice(fx.dice);
      const t = tgtEnt ?? me;
      const amount = Array.from({ length: count }, () => rnd(sides)).reduce((a, b) => a + b, 0);
      t.hp = Math.min(t.hp_max, t.hp + amount);
      this.engine(`${t.name} recovers ${amount} HP.`);
      this.diff([{ ...t }]);
    }
    if (this.combat) this.later(() => { if (this.enemies().length === 0) this.endCombat(); }, 400);
  }

  private onEndTurn(ack: string): void {
    if (!this.combat) return this.fail("invalid_state", "You are not in combat.", ack);
    if (this.activeId() !== ME_CHAR) return this.fail("invalid_state", "It is not your turn.", ack);
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    this.nextTurn();
  }

  // ---------- votes ----------

  private startVote(): void {
    const id = `vote_${++this.voteId}`;
    this.currentVote = { id, tally: { skip: 0, wait: 0, autopilot: 0 }, left: 20 };
    const other = this.pcs().find((e) => e.owner_player_id !== ME)?.name ?? "A player";
    this.currentVote.topic = `${other} is away from the table. What should the party do?`;
    this.sendVote();
    const tick = setInterval(() => {
      const v = this.currentVote;
      if (!v) { clearInterval(tick); return; }
      v.left--;
      if (v.left <= 0) this.closeVote();
      else this.sendVote();
    }, 1000);
    this.intervals.add(tick);
    this.later(() => { if (this.currentVote?.id === id) { this.currentVote.tally.autopilot = (this.currentVote.tally.autopilot ?? 0) + 1; this.sendVote(); } }, 3000);
  }

  private currentVote: { id: string; topic?: string; tally: Record<string, number>; left: number } | null = null;

  private sendVote(): void {
    const v = this.currentVote;
    if (!v) return;
    this.emit("vote_state", { vote_id: v.id, topic: v.topic ?? "Vote", options: ["skip", "wait", "autopilot"], tally: v.tally, seconds_left: v.left });
  }

  private onVoteCast(choice: string, ack: string): void {
    const v = this.currentVote;
    if (!v) return this.fail("not_found", "That vote is over.", ack);
    v.tally[choice] = (v.tally[choice] ?? 0) + 1;
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    this.sendVote();
    this.later(() => this.closeVote(), 1500);
  }

  private closeVote(): void {
    const v = this.currentVote;
    if (!v) return;
    this.currentVote = null;
    const winner = Object.entries(v.tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "wait";
    this.emit("vote_state", { vote_id: v.id, topic: v.topic ?? "Vote", options: ["skip", "wait", "autopilot"], tally: v.tally, seconds_left: 0 });
    this.sys(`Vote result: ${winner}.`);
  }
}
