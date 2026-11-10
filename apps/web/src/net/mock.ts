import {
  ClientMessageSchema, WS_VERSION, fixtures, parseDice, validateRegistration,
  type CampaignInfo, type CharacterCreate, type CharacterSummary, type CharacterView, type EntityView, type GameMap,
  type ServerMessageType,
} from "@aedm/schemas";
import type { Transport, TransportFactory, TransportHandlers } from "./transport";
import { MOCK_H, MOCK_W, NARRATION_OPENING, NPC_ODALYS, buildMockMap, choristerEntities, wallAt } from "./mock-world";

type Payload = Record<string, unknown>;
type PlayerStatus = "online" | "away" | "offline" | "autopilot";
interface MockPlayer { player_id: string; display_name: string; status: PlayerStatus; ready: boolean; character_id: string | null }
interface Settings { content_rating: "family" | "teen" | "mature"; campaign_pitch: string; dev_solo: boolean }

const ME = "p_me";
const ME_CHAR = "ch_me";
const LATENCY_MS = 45;

const rnd = (n: number) => 1 + Math.floor(Math.random() * n);
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function toView(c: (typeof fixtures)["BRINDLE"]): CharacterView {
  return {
    v: 1, id: c.id, name: c.name, title: c.title, description: c.description, key_ability: c.key_ability, scores: c.scores,
    trait_tags: c.trait_tags, abilities: c.abilities, weapon_tier: c.weapon_tier, armor_bonus: c.armor_bonus,
    level: c.level, growth: c.growth, hp: c.hp, hp_max: c.hp_max, sprite_recipe: c.sprite_recipe,
  };
}

const FAKES = {
  mira: { id: "p_mira", name: "Mira", char: fixtures.BRINDLE, start: { x: 12, y: 11 } },
  dov: { id: "p_dov", name: "Dov", char: fixtures.TAMSIN, start: { x: 14, y: 11 } },
  sable: { id: "p_sable", name: "Sable", char: fixtures.ORRIN, start: { x: 13, y: 12 } },
};

/** Build the character a real server would produce from a creator submission (the forge is faked). */
export function mockCharacterFrom(c: CharacterCreate): CharacterView {
  const con = c.scores.con;
  const hp = 8 + Math.floor((con - 10) / 2) + 2;
  const texts = c.ability_texts ?? (c.abilities ?? []).map((a) => `${a.name}: ${a.description}`);
  return {
    v: 1, id: ME_CHAR, name: c.name, title: c.title, description: c.description, key_ability: c.key_ability,
    scores: { ...c.scores }, trait_tags: c.trait_tags,
    abilities: texts.map((t, i) => {
      const [head, ...rest] = t.split(":");
      const name = (rest.length ? head! : t.split(/\s+/).slice(0, 3).join(" ")).trim().slice(0, 40) || `Ability ${i + 1}`;
      const desc = (rest.length ? rest.join(":") : t).trim().slice(0, 200) || name;
      return {
        v: 1 as const, id: `ab_me_${i + 1}`, name, description: desc, tags: [], action: "action" as const,
        target: "enemy" as const, range_tiles: 4, cooldown_turns: 2,
        effects: [{ type: "damage" as const, shape: "single" as const, dice: "2d6", damage_type: "sharp" as const }],
        forge_notes: "Mock forge: turned into 2d6 single-target damage.", cost: 4,
      };
    }),
    weapon_tier: 1, armor_bonus: 2, level: 1, growth: 0, hp, hp_max: hp, sprite_recipe: c.sprite_recipe,
  };
}

interface MockTemplate { id: string; character: CharacterCreate; forged: boolean; saved_at: string }
interface MockAccount { id: string; username: string; password: string; display_name: string; templates: MockTemplate[]; campaigns: CampaignInfo[] }

function mockAbilityNames(c: CharacterCreate): string[] {
  const texts = c.ability_texts ?? (c.abilities ?? []).map((a) => `${a.name}: ${a.description}`);
  return texts.map((t) => {
    const head = t.split(":")[0] ?? t;
    return (head.length < t.length && head.length <= 40 ? head : t.split(/\s+/).slice(0, 3).join(" ")).trim().slice(0, 60);
  }).filter(Boolean).slice(0, 3);
}

const summaryOf = (t: MockTemplate): CharacterSummary => ({
  id: t.id, name: t.character.name, title: t.character.title, key_ability: t.character.key_ability,
  sprite_recipe: t.character.sprite_recipe, ability_names: mockAbilityNames(t.character), forged: t.forged, saved_at: t.saved_at,
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
  private settings: Settings = { content_rating: "teen", campaign_pitch: "", dev_solo: false };
  private players: MockPlayer[] = [];
  private myName = "Player";
  private myChar: CharacterView | null = null;
  private resume: { save_id: string; name: string } | null = null;

  // accounts (in memory for the page's lifetime; the login itself belongs to the connection, as on the real server)
  private accounts = new Map<string, MockAccount>();
  private sessions = new Map<string, string>();
  private authUser: MockAccount | null = null;

  // game
  private map: GameMap = buildMockMap();
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
      case "register": case "login": case "resume_session": case "logout": case "list_characters":
      case "save_character_template": case "delete_character_template": case "list_campaigns": case "resume_campaign":
        return this.onAccount(m.type, p, ack);
      default: break;
    }
    if (!this.joined) return this.fail("forbidden", "Join a room first.", ack);
    switch (m.type) {
      case "set_ready": return this.onReady(Boolean(p.ready), ack);
      case "update_settings": return this.onSettings(p, ack);
      case "start_game": return this.onStart(ack);
      case "claim_character": return this.onClaim(m.payload as { character_id: string; character?: CharacterCreate; template_id?: string }, ack);
      case "move_intent": return this.onMove(p, ack);
      case "act": return this.onAct(String(p.verb), String(p.target_id), ack);
      case "basic_attack": return this.onBasicAttack(String(p.target_id), ack);
      case "use_ability": return this.onAbility(String(p.ability_id), p.target as string | { x: number; y: number }, ack);
      case "use_item": return this.fail("not_found", "You have no such item.", ack);
      case "end_turn": return this.onEndTurn(ack);
      case "say": return this.onSay(String(p.text), p.channel as "ic" | "ooc", ack);
      case "vote_cast": return this.onVoteCast(String(p.choice), ack);
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
    if (this.phase === "playing") this.sendSnapshot();
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
        const a: MockAccount = { id: `u_mock_${username}`, username, password: input.password, display_name: input.display_name.trim(), templates: [], campaigns: [] };
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
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    this.lobbyState();
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
    this.map = buildMockMap();
    this.ents = {};
    this.party = [];
    this.seq = 0;
    this.mode = "exploration";
    this.combat = null;
    const squad = this.settings.dev_solo ? [] : this.players.filter((p) => p.player_id !== ME && p.ready && p.character_id);
    const myChar = this.myChar!;
    this.party.push(myChar);
    this.addPc(myChar, ME, { x: 13, y: 10 });
    for (const pl of squad) {
      const f = Object.values(FAKES).find((x) => x.id === pl.player_id);
      if (!f) continue;
      this.party.push(toView(f.char));
      this.addPc(toView(f.char), f.id, f.start);
    }
    this.ents[NPC_ODALYS.id] = { ...NPC_ODALYS };
    for (const e of choristerEntities()) this.ents[e.id] = e;
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
        this.emit("chips", { chips: ["Talk to Odalys", "Look around", "Attack the chorister"] });
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
    if (this.free(nx, ny) && cheb({ x: nx, y: ny }, { x: 13, y: 10 }) <= 4) this.moveEntity(e, nx, ny);
  }

  // ---------- helpers ----------

  private occupant(x: number, y: number): EntityView | undefined {
    return Object.values(this.ents).find((e) => e.x === x && e.y === y && e.hp > 0);
  }

  private free(x: number, y: number): boolean {
    return !wallAt(this.map, x, y) && !this.occupant(x, y);
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
    if (wallAt(this.map, dest.x, dest.y)) return this.fail("invalid_state", "A wall blocks the way.", ack);
    const occ = this.occupant(dest.x, dest.y);
    if (occ && occ.id !== me.id) return this.fail("invalid_state", `${occ.name} is in the way.`, ack);
    const path = this.findPath(me, dest);
    if (!path) return this.fail("invalid_state", "You can't reach that tile.", ack);
    this.emit("presence", { player_id: ME, status: "online" }, ack);
    const limit = this.combat ? 6 : 14;
    this.walk(me, path.slice(0, limit));
  }

  private findPath(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] | null {
    const key = (x: number, y: number) => y * MOCK_W + x;
    const prev = new Map<number, number>();
    const q: { x: number; y: number }[] = [from];
    prev.set(key(from.x, from.y), -1);
    while (q.length) {
      const cur = q.shift()!;
      if (cur.x === to.x && cur.y === to.y) {
        const out: { x: number; y: number }[] = [];
        for (let k = key(cur.x, cur.y); k !== key(from.x, from.y); k = prev.get(k)!) out.unshift({ x: k % MOCK_W, y: Math.floor(k / MOCK_W) });
        return out;
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cur.x + dx, ny = cur.y + dy;
          if (nx < 0 || ny < 0 || nx >= MOCK_W || ny >= MOCK_H || prev.has(key(nx, ny))) continue;
          if (!this.free(nx, ny)) continue;
          if (dx && dy && (wallAt(this.map, cur.x + dx, cur.y) || wallAt(this.map, cur.x, cur.y + dy))) continue;
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
        if (!this.combat && this.enemies().some((en) => cheb(en, e) <= 4)) this.startCombat();
      }, 110 * i);
    });
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
    if (/attack|fight|chorister|battle|strike/i.test(text)) {
      this.narrate("You step toward the grey-robed figures. Their heads turn in perfect unison, and the humming stops. Then it begins again, higher, and wrong.", () => this.startCombat());
    } else if (/odalys|inn|talk|ask/i.test(text)) {
      this.later(() => this.chat(NPC_ODALYS.id, "Odalys", "ic", "Three of my regulars walked into the marsh last night, humming. Please, find out why."), 500);
      this.narrate("Odalys sets her broom against the porch rail and wipes her hands on her apron, glancing toward the reeds.");
    } else {
      this.narrate("The village holds its breath. A lantern swings though there is no wind, and the humming from the marsh swells, then settles.");
    }
    this.later(() => this.emit("chips", { chips: ["Talk to Odalys", "Check the chest", "Attack the chorister"] }), 1500);
  }

  private onAct(verb: string, target: string, ack: string): void {
    this.emit("presence", { player_id: ME, status: "online" }, ack);
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
    if (verb === "interact" && obj && "kind" in obj && obj.kind === "chest") {
      const d = rnd(20);
      const total = d + 3;
      this.emit("roll_result", { who: ME_CHAR, label: "Lockpicking: the plaza chest", dice: [d], modifier: 3, total, target: 13, outcome: d === 20 ? "crit" : d === 1 ? "fumble" : total >= 13 ? "success" : "failure" });
      return;
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
    });
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
