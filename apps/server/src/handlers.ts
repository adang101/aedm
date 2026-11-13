import { addCharacter, cloneState, validatePixelSprite, validatePointBuy } from "@aedm/engine";
import { MAX_CAST_ENTRIES, type CharacterCreate, type ClientMessage } from "@aedm/schemas";
import { AccountHandlers } from "./accounts/handlers";
import { WorkshopHandlers } from "./accounts/workshop-handlers";
import { forgeCharacterAbilities, ForgeError, partyAbilities, pitchCampaign } from "./forge";
import { GameSession, type Reply } from "./game";
import { RateLimiter, type Conn } from "./net";
import { newToken, Room, RoomRegistry, type Player } from "./rooms";
import type { Deps } from "./types";

type Msg<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

/** One player cannot fill the whole cast. */
const MAX_CAST_PER_PLAYER = 10;

/** Everything that happens when a validated client message arrives. */
export class Handlers {
  readonly registry: RoomRegistry;
  private readonly accounts: AccountHandlers;
  private readonly workshop: WorkshopHandlers;
  /** Keyed per account (or per connection for guests), shared across that account's connections. */
  private readonly designLimiter = new RateLimiter();

  constructor(private readonly deps: Deps) {
    this.registry = new RoomRegistry(deps);
    this.workshop = new WorkshopHandlers(deps);
    this.accounts = new AccountHandlers(deps, this.registry, { onRoomCreated: (room) => this.scheduleIdleCheck(room) });
  }

  private get cfg() { return this.deps.config; }

  // ---------- entry ----------

  async dispatch(conn: Conn, msg: ClientMessage): Promise<void> {
    const ack = msg.id;
    switch (msg.type) {
      case "ping": conn.send("pong", {}, ack); return;
      case "create_room": return this.createRoom(conn, msg as Msg<"create_room">);
      case "join_room": return this.joinRoom(conn, msg as Msg<"join_room">);
      case "design_sprite": return this.designSprite(conn, msg as Msg<"design_sprite">);
      default: break;
    }
    if (this.accounts.handles(msg.type)) return this.accounts.dispatch(conn, msg);
    if (this.workshop.handles(msg.type)) return this.workshop.dispatch(conn, msg);
    const room = conn.roomId ? this.registry.get(conn.roomId) : undefined;
    const player = room?.player(conn.playerId);
    if (!room || !player) return conn.error("forbidden", "Join a room first.", ack);

    const reply: Reply = (kind, code, message) => {
      if (kind === "ok") conn.send("presence", { player_id: player.id, status: player.status }, ack);
      else conn.error(code ?? "invalid_state", message ?? "That did not work.", ack);
    };

    switch (msg.type) {
      case "set_ready": return this.setReady(room, player, msg as Msg<"set_ready">, reply);
      case "update_settings": return this.updateSettings(room, player, msg as Msg<"update_settings">, reply);
      case "start_game": return this.startGame(room, player, reply);
      case "claim_character": return this.claimCharacter(room, player, conn, msg as Msg<"claim_character">, reply);
      case "offer_to_cast": return this.offerToCast(room, player, msg as Msg<"offer_to_cast">, reply);
      case "cast_decision": return this.castDecision(room, player, msg as Msg<"cast_decision">, reply);
      case "say": return this.say(room, player, msg as Msg<"say">, reply);
      case "request_save": return this.requestSave(room, player, conn, msg as Msg<"request_save">, reply);
      case "load_save": return this.loadSave(room, player, msg as Msg<"load_save">, reply);
      default: break;
    }

    const game = room.game;
    if (!game) return reply("error", "invalid_state", "The game has not started.");
    switch (msg.type) {
      case "move_intent": game.handleMove(player, (msg as Msg<"move_intent">).payload, reply); return;
      case "act": {
        const p = (msg as Msg<"act">).payload;
        game.handleAct(player, p.verb, p.target_id, reply);
        return;
      }
      case "basic_attack": game.handleBasicAttack(player, (msg as Msg<"basic_attack">).payload.target_id, reply); return;
      case "use_ability": {
        const p = (msg as Msg<"use_ability">).payload;
        game.handleUseAbility(player, p.ability_id, p.target, reply);
        return;
      }
      case "use_item": {
        const p = (msg as Msg<"use_item">).payload;
        game.handleUseItem(player, p.item_id, p.target, reply);
        return;
      }
      case "end_turn": game.handleEndTurn(player, reply); return;
      case "level_up_choice":
        game.handleLevelUpChoice(player, (msg as Msg<"level_up_choice">).payload, reply, (p) => conn.send("level_up_result", p, ack));
        return;
      case "vote_cast": {
        const p = (msg as Msg<"vote_cast">).payload;
        game.handleVote(player, p.vote_id, p.choice, reply);
        return;
      }
      default: return;
    }
  }

  // ---------- sprite designer ----------

  /** "Describe your look": the prompt goes through the same designer as the DM's NPCs, but is never cached, so a re-roll differs. */
  private async designSprite(conn: Conn, msg: Msg<"design_sprite">): Promise<void> {
    const { prompt, role_hint, name } = msg.payload;
    const lim = this.cfg.limits.spriteDesign;
    const key = conn.userId ? `u:${conn.userId}` : `c:${conn.id}`;
    if (!this.designLimiter.allow(key, this.deps.clock(), lim.max, lim.windowMs)) {
      return conn.error("rate_limited", "You are designing too many looks. Wait a minute and try again.", msg.id);
    }
    const seed = msg.payload.seed ?? Math.floor(this.deps.random() * 0x7fffffff);
    const r = await this.deps.sprites.designFresh(
      { concept: prompt, name: name ?? "", role: role_hint, kind: role_hint }, seed,
    );
    conn.send("sprite_designed", { spec: r.spec, notes: r.notes.slice(0, 20), source: r.source }, msg.id);
  }

  // ---------- rooms ----------

  private createRoom(conn: Conn, msg: Msg<"create_room">): void {
    if (conn.roomId) return conn.error("invalid_state", "You are already in a room.", msg.id);
    const room = this.registry.create(conn);
    this.scheduleIdleCheck(room);
    conn.send("room_created", { room_id: room.id, invite_code: room.code }, msg.id);
  }

  private joinRoom(conn: Conn, msg: Msg<"join_room">): void {
    const { invite_code, display_name, auth_token } = msg.payload;
    const room = this.registry.findByCode(invite_code);
    if (!room) return conn.error("not_found", "No room with that invite code.", msg.id);
    if (conn.roomId && conn.roomId !== room.id) return conn.error("invalid_state", "You are already in another room.", msg.id);

    let player = auth_token ? room.playerByToken(auth_token) : undefined;
    if (!player && conn.playerId) player = room.player(conn.playerId); // same connection asking for a fresh state
    if (!player) player = room.playerByUser(conn.userId); // a logged-in user is rebound without the room token
    if (player) {
      // reconnect (or resync) with the same seat
      if (player.conn && player.conn !== conn) {
        player.conn.playerId = null;
        player.conn.roomId = null;
        player.conn.close();
      }
      this.deps.timers.clearTimeout(player.graceTimer);
      player.graceTimer = null;
      player.userId ??= conn.userId;
      player.conn = conn;
      conn.playerId = player.id;
      conn.roomId = room.id;
    } else {
      if (room.players.length === 0 && conn.id !== room.creatorConnId) {
        return conn.error("not_found", "No room with that invite code.", msg.id);
      }
      if (room.phase !== "lobby") return conn.error("invalid_state", "That game has already started.", msg.id);
      if (room.players.length >= this.cfg.maxPlayers) return conn.error("invalid_state", "That room is full.", msg.id);
      player = {
        id: `p_${room.players.length + 1}_${Math.floor(this.deps.random() * 36 ** 4).toString(36)}`,
        name: this.uniqueName(room, display_name),
        token: newToken(),
        userId: conn.userId,
        conn,
        status: "online",
        ready: false,
        characterId: null,
        forging: false,
        graceTimer: null,
      };
      room.players.push(player);
      if (room.hostId === null) room.hostId = player.id;
      conn.playerId = player.id;
      conn.roomId = room.id;
    }

    this.deps.timers.clearTimeout(room.idleTimer);
    room.idleTimer = null;
    conn.send("joined", { player_id: player.id, auth_token: player.token, room_id: room.id }, msg.id);
    if (player.status !== "online") room.setStatus(player, "online");
    room.broadcastLobby();
    if (room.cast.length > 0) conn.send("cast_state", room.castPayload());
    room.game?.sendFullState(player.id);
  }

  private uniqueName(room: Room, wanted: string): string {
    const taken = new Set(room.players.map((p) => p.name.toLowerCase()));
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; n < 20; n++) {
      const candidate = `${wanted.slice(0, 24 - String(n).length - 1)} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return wanted;
  }

  onClose(conn: Conn): void {
    const room = conn.roomId ? this.registry.get(conn.roomId) : undefined;
    const player = room?.player(conn.playerId);
    if (!room || !player || player.conn !== conn) return;
    player.conn = null;
    this.deps.timers.clearTimeout(player.graceTimer);
    player.graceTimer = this.deps.timers.setTimeout(() => {
      player.graceTimer = null;
      if (player.conn) return;
      if (player.status !== "autopilot") room.setStatus(player, "offline");
      if (!room.anyConnected()) this.scheduleIdleCheck(room);
    }, this.cfg.disconnectGraceMs);
    // keep the seat; the grace timer marks it offline
  }

  private scheduleIdleCheck(room: Room): void {
    this.deps.timers.clearTimeout(room.idleTimer);
    room.idleTimer = this.deps.timers.setTimeout(() => {
      if (room.anyConnected()) return;
      void room.game?.close();
      this.registry.remove(room);
    }, this.cfg.roomIdleMs);
  }

  async shutdown(): Promise<void> {
    for (const room of this.registry.all()) {
      this.deps.timers.clearTimeout(room.idleTimer);
      for (const p of room.players) this.deps.timers.clearTimeout(p.graceTimer);
      await room.game?.close();
    }
  }

  // ---------- lobby ----------

  private setReady(room: Room, player: Player, msg: Msg<"set_ready">, reply: Reply): void {
    if (room.phase !== "lobby") return reply("error", "invalid_state", "The game has already started.");
    if (player.forging) return reply("error", "invalid_state", "Your character is still being forged.");
    if (msg.payload.ready && !player.characterId) return reply("error", "invalid_state", "Create your character before readying up.");
    player.ready = msg.payload.ready;
    reply("ok");
    room.broadcastLobby();
  }

  private updateSettings(room: Room, player: Player, msg: Msg<"update_settings">, reply: Reply): void {
    if (player.id !== room.hostId) return reply("error", "not_host", "Only the host can change settings.");
    // once playing, only the sprite safety switches stay in the host's hands
    const midGame = Object.keys(msg.payload).every((k) => k === "custom_cast" || k === "custom_paintings");
    if (room.phase !== "lobby" && !midGame) return reply("error", "invalid_state", "The game has already started.");
    room.settings = { ...room.settings, ...msg.payload };
    if (msg.payload.custom_cast === "open") {
      for (const c of room.cast) c.status = "approved"; // open means no approval step: what was waiting is in
    }
    reply("ok");
    room.broadcastLobby();
    if (msg.payload.custom_cast !== undefined || msg.payload.custom_paintings !== undefined) room.broadcastCast();
  }

  // ---------- campaign cast ----------

  private async offerToCast(room: Room, player: Player, msg: Msg<"offer_to_cast">, reply: Reply): Promise<void> {
    if (!player.userId) return reply("error", "forbidden", "Log in to offer a sprite from your Workshop.");
    const mode = room.settings.custom_cast ?? "host_approval";
    if (mode === "off") return reply("error", "forbidden", "The host has turned custom sprites off for this room.");
    const existing = room.cast.find((c) => c.assetId === msg.payload.asset_id);
    if (existing) {
      if (existing.ownerPlayerId !== player.id) return reply("error", "invalid_state", "That sprite is already in the cast.");
      return reply("ok"); // idempotent: the entry is already there
    }
    const asset = await this.deps.workshop.get(player.userId, msg.payload.asset_id);
    if (!asset) return reply("error", "not_found", "No such sprite in your Workshop.");
    if (asset.role_hint !== "npc" && asset.role_hint !== "enemy") return reply("error", "invalid_state", "Only NPC and enemy looks can join the cast.");
    if (asset.recipe.kind === "pixel" && room.settings.custom_paintings === false) return reply("error", "forbidden", "The host has turned painted sprites off for this room.");
    if (room.cast.length >= MAX_CAST_ENTRIES) return reply("error", "invalid_state", "The cast is full.");
    if (room.cast.filter((c) => c.ownerPlayerId === player.id).length >= MAX_CAST_PER_PLAYER) {
      return reply("error", "invalid_state", `You can offer at most ${MAX_CAST_PER_PLAYER} sprites to one campaign.`);
    }
    if (room.cast.some((c) => c.assetId === asset.id)) return reply("ok"); // raced with another offer of the same asset
    room.cast.push({
      assetId: asset.id, ownerPlayerId: player.id, name: asset.name, roleHint: asset.role_hint, concept: asset.concept, recipe: asset.recipe,
      status: mode === "open" || player.id === room.hostId ? "approved" : "pending",
    });
    reply("ok");
    room.broadcastCast();
  }

  private castDecision(room: Room, player: Player, msg: Msg<"cast_decision">, reply: Reply): void {
    const entry = room.cast.find((c) => c.assetId === msg.payload.asset_id);
    if (!entry) return reply("error", "not_found", "That sprite is not in the cast.");
    const isHost = player.id === room.hostId;
    if (!msg.payload.approve) {
      // the host denies or removes; the owner may withdraw their own offer
      if (!isHost && entry.ownerPlayerId !== player.id) return reply("error", "not_host", "Only the host can remove a sprite from the cast.");
      room.cast.splice(room.cast.indexOf(entry), 1);
    } else {
      if (!isHost) return reply("error", "not_host", "Only the host can approve a sprite for the cast.");
      if ((room.settings.custom_cast ?? "host_approval") === "off") return reply("error", "invalid_state", "Custom sprites are turned off for this room.");
      entry.status = "approved";
    }
    reply("ok");
    room.broadcastCast();
  }

  private say(room: Room, player: Player, msg: Msg<"say">, reply: Reply): void {
    const { text, channel } = msg.payload;
    if (room.game) {
      room.game.handleSay(player, text, channel);
    } else {
      room.broadcast("chat", { from_id: player.id, from_name: player.name, channel, text });
    }
    reply("ok");
  }

  private async claimCharacter(room: Room, player: Player, conn: Conn, msg: Msg<"claim_character">, reply: Reply): Promise<void> {
    if (room.phase !== "lobby") return reply("error", "invalid_state", "The game has already started.");
    if (player.forging) return reply("error", "invalid_state", "Your character is already being forged.");
    const p = msg.payload;

    if (p.character_id !== "new" && p.character_id !== "template") {
      const ch = room.scratch.characters[p.character_id];
      const owner = room.playerByCharacter(p.character_id);
      if (!ch) return reply("error", "not_found", "No such character.");
      if (owner && owner.id !== player.id) return reply("error", "forbidden", "Another player has that character.");
      player.characterId = ch.id;
      player.ready = false;
      conn.send("character_claimed", { character_id: ch.id, player_id: player.id }, msg.id);
      room.broadcast("character_claimed", { character_id: ch.id, player_id: player.id });
      room.broadcastLobby();
      return;
    }

    let create: CharacterCreate;
    let templateId: string | undefined;
    if (p.character_id === "template" && "template_id" in p) {
      const tpl = await this.accounts.loadTemplate(conn, p.template_id);
      if (!tpl) return reply("error", "not_found", "No such saved character. Log in to use your saved characters.");
      create = tpl.character;
      templateId = tpl.id;
    } else {
      if (!("character" in p)) return reply("error", "bad_message", "Missing character.");
      create = p.character;
    }
    if (create.sprite_recipe?.kind === "pixel") {
      if (room.settings.custom_paintings === false) return reply("error", "forbidden", "The host has turned painted sprites off for this room.");
      const px = validatePixelSprite(create.sprite_recipe);
      if (!px.ok) return reply("error", "invalid_sprite", `That painted sprite was refused: ${px.errors.map((e) => e.message).join(" ")}`);
    }
    const pb = validatePointBuy(create.scores);
    if (!pb.ok) return reply("error", "invalid_state", pb.errors.join(" "));
    const lowerName = create.name.toLowerCase();
    const clash = room.players.some((o) => o.id !== player.id && o.characterId && room.scratch.characters[o.characterId]?.name.toLowerCase() === lowerName);
    if (clash) return reply("error", "invalid_state", "Another character at this table already has that name.");

    player.forging = true;
    player.ready = false;
    room.broadcastLobby();
    try {
      const forged = await forgeCharacterAbilities(this.deps.provider, create, {
        context: {
          campaign: pitchCampaign(room.settings.campaign_pitch),
          party: partyAbilities(Object.values(room.scratch.characters), player.characterId ?? undefined),
        },
        sleep: (ms) => new Promise((r) => { this.deps.timers.setTimeout(() => r(), ms); }),
        retryBackoffMs: this.cfg.retryBackoffMs,
        onModelError: (err) => this.deps.logger.warn("[forge] model call failed:", err instanceof Error ? err.message : String(err)),
      });
      const { ability_texts: _t, abilities: _a, ...rest0 } = create;
      // A character without a usable look gets one designed from its title and description (shape recipes are kept as they are).
      let rest = rest0;
      if (!rest.sprite_recipe) {
        const look = await this.deps.sprites.getOrCreateSprite({
          concept: `${create.title} ${create.description}`.trim() || create.name, name: create.name, role: "pc", kind: "pc",
        });
        rest = { ...rest, sprite_recipe: look.spec };
      }
      const scratch = cloneState(room.scratch);
      if (player.characterId) delete scratch.characters[player.characterId];
      const added = addCharacter(scratch, { ...rest, abilities: forged.abilities }, player.id);
      if (!added.ok) {
        reply("error", "invalid_state", `The character was refused: ${added.errors.join("; ")}`);
        return;
      }
      room.scratch = added.state;
      player.characterId = added.character.id;
      await this.accounts.afterForge(conn, create, forged.abilities, templateId);
      conn.send("character_claimed", { character_id: added.character.id, player_id: player.id }, msg.id);
      room.broadcast("character_claimed", { character_id: added.character.id, player_id: player.id });
      for (const line of forged.notices) conn.send("log", { kind: "system", text: line });
    } catch (err) {
      reply("error", "invalid_state", err instanceof ForgeError ? err.message : "Something went wrong forging your character.");
      if (!(err instanceof ForgeError)) this.deps.logger.error("[claim] failed:", err instanceof Error ? err.message : String(err));
    } finally {
      player.forging = false;
      room.broadcastLobby();
    }
  }

  private async startGame(room: Room, player: Player, reply: Reply): Promise<void> {
    if (player.id !== room.hostId) return reply("error", "not_host", "Only the host can start the game.");
    if (room.phase !== "lobby" || room.starting) return reply("error", "invalid_state", "The game has already started.");
    if (room.players.some((p) => p.forging)) return reply("error", "invalid_state", "Wait for every character to finish forging.");
    if (!player.characterId) return reply("error", "invalid_state", "Create your character first.");
    const solo = room.settings.dev_solo;
    const participants = room.players.filter((p) => p.characterId && (solo || p.ready || p.id === room.hostId));
    if (!solo && participants.length < 2) return reply("error", "invalid_state", "At least two players must be ready.");

    room.starting = true;
    reply("ok");
    room.broadcast("log", { kind: "system", text: "The DM is preparing the campaign…" });
    const game = new GameSession(room, this.deps);
    try {
      await game.initialize(participants);
    } catch (err) {
      room.starting = false;
      await game.close();
      this.deps.logger.error("[start] failed:", err instanceof Error ? err.message : String(err));
      room.send(player.id, "error", { code: "invalid_state", message: "The DM could not prepare the campaign. Try again." });
      return;
    }
    for (const p of room.players) {
      if (!participants.includes(p)) { p.characterId = null; p.ready = false; }
    }
    room.game = game;
    room.phase = "playing";
    room.starting = false;
    room.broadcastLobby();
    game.begin();
  }

  // ---------- saves ----------

  private async requestSave(room: Room, player: Player, conn: Conn, msg: Msg<"request_save">, reply: Reply): Promise<void> {
    const game = room.game;
    if (!game) return reply("error", "invalid_state", "There is nothing to save yet.");
    try {
      const id = await game.saveNamed(msg.payload.name);
      room.broadcast("save_created", { save_id: id, name: msg.payload.name });
      conn.send("presence", { player_id: player.id, status: player.status }, msg.id);
    } catch (err) {
      this.deps.logger.error("[save] failed:", err instanceof Error ? err.message : String(err));
      reply("error", "invalid_state", "The save could not be written.");
    }
  }

  private async loadSave(room: Room, player: Player, msg: Msg<"load_save">, reply: Reply): Promise<void> {
    if (player.id !== room.hostId) return reply("error", "not_host", "Only the host can load a save.");
    const from = room.resume && room.resume.saveId === msg.payload.save_id ? room.resume : null;
    const save = from
      ? await this.deps.saves.readExact(from.roomId, from.saveId)
      : await this.deps.saves.read(room.id, msg.payload.save_id);
    if (!save) return reply("error", "not_found", "No such save.");
    // a campaign saved by an account can only be loaded by that account
    if (save.owner_user_id && save.owner_user_id !== player.userId) return reply("error", "not_found", "No such save.");
    room.resume = null;
    reply("ok");
    let game = room.game;
    if (!game) {
      game = new GameSession(room, this.deps);
      room.game = game;
      room.phase = "playing";
    }
    const g = game;
    await g.enqueue(() => {
      g.restore(save);
      room.broadcastLobby();
    });
  }
}
