import {
  addAbilityToCharacter, addCharacter, addGrowth, addMap, advanceBeat, applyDmActions, basicAttack, clampEnemy, cloneState, combatOutcome,
  computePartyLevel, createGameState, currentMap, describeEvent, endCombat, endTurn, enemyRangesForLevel,
  enemyTakeTurn, entitiesOnMap, findFreeTileNear, findPath, generateMap, inferPreset, isWalkable, levelUpView, moveEntity, occupiedTiles,
  placePartyOnMap, registerArchetype, remainingBudget, replaceAbility, resolveCheck, rest, rngFromState, setAbsent,
  skipAbilityPick, spendScorePoint, STARTER_BRIEFS, toCharacterView,
  toEntityView, toSnapshot, toWsCombat, useAbility, useItem,
  type CheckRequest, type CreateEnemyAction, type EngineEvent, type Entity, type GameState,
} from "@aedm/engine";
import {
  buildEnemy, generateStoryBible, LANTERN_MARSH_BIBLE, LANTERN_MARSH_FACTS, LlmError, runDmTurn, summarizeTurns,
  type DmTurnResult,
} from "@aedm/llm";
import type { Ability, DmAction, DmResponse, EntityView, GameMap, LevelUpChoice, PlayerStatus, SettingPreset, SpriteSpec } from "@aedm/schemas";
import { ForgeError, forgeOneAbility } from "./forge";
import { buildContextPack, presentCharacterIds, type RecentTurn } from "./context";
import type { Player, Room } from "./rooms";
import { isSafeId, writeSave, type SaveFile, SAVE_VERSION } from "./saves";
import type { Deps } from "./types";

interface Intent { characterId: string; characterName: string; text: string }
interface Beat { intents: Intent[]; speakers: Set<string>; timer: unknown }
interface Vote {
  id: string;
  entityId: string;
  ownerId: string;
  votes: Map<string, "skip" | "wait" | "autopilot">;
  eligible: Set<string>;
  timer: unknown;
}

type Choice = "skip" | "wait" | "autopilot";
export type Reply = (kind: "ok" | "error", code?: string, message?: string) => void;

const MAX_PENDING_LINES = 30;
const MAX_RECENT = 60;
const SUMMARIZE_AT = 36;
const SUMMARIZE_COUNT = 20;
const DM_PAUSE_LINE = "The DM pauses to gather their thoughts…";

/** Events the players never need as a log line. */
const SILENT_EVENTS = new Set<EngineEvent["type"]>([
  "moved", "map_added", "map_requested", "check_requested", "chips", "action_rejected", "turn_started", "turn_ended",
  "round_started", "fact_set", "roll", "npc_said", "entity_spawned",
]);
/** Events the DM does not need to hear about. */
const DM_SKIP_EVENTS = new Set<EngineEvent["type"]>([
  "moved", "map_added", "map_requested", "check_requested", "chips", "turn_ended", "round_started", "fact_set", "npc_said",
]);

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function humanLine(e: EngineEvent): string {
  if (e.type === "combat_started") return "Combat begins. Initiative is rolled.";
  if (e.type === "combat_ended") return `Combat ends (${e.reason}).`;
  return cap(describeEvent(e).replace(/^\[engine: /, "").replace(/\]$/, ""));
}

const DIRS: Record<"n" | "s" | "e" | "w", [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

export class GameSession {
  state!: GameState;
  /** Broadcast sequence number shared by every state_snapshot and state_diff. */
  seq = 0;

  private chain: Promise<void> = Promise.resolve();
  private saveChain: Promise<void> = Promise.resolve();
  private beat: Beat | null = null;
  private recent: RecentTurn[] = [];
  private summaries: string[] = [];
  private dmNotes: string[] = [];
  private pendingLines: string[] = [];
  private sceneNote = "";
  private highStakes = false;
  private turnN = 0;
  private saveN = 0;
  private walkEpoch = 0;
  private walks = new Map<string, number>();
  private turn: { entityId: string; deadline: number; handle: unknown } | null = null;
  private vote: Vote | null = null;
  private voteN = 0;
  private lastNarratedRound = 1;
  private closed = false;
  private handles = new Set<unknown>();

  constructor(private readonly room: Room, private readonly deps: Deps) {}

  // ---------- plumbing ----------

  private get cfg() { return this.deps.config; }

  /** Serialized async work (DM calls, AI turns, timeouts). Never rejects. */
  enqueue(fn: () => Promise<void> | void): Promise<void> {
    const p = this.chain.then(async () => {
      if (this.closed) return;
      await fn();
    }).catch((err) => this.deps.logger.error("[game] task failed:", err instanceof Error ? err.message : String(err)));
    this.chain = p;
    return p;
  }

  /** Resolves when the queue and pending file writes are empty. */
  async idle(): Promise<void> {
    let last: Promise<void>;
    do {
      last = this.chain;
      await last;
      await this.saveChain;
    } while (last !== this.chain);
  }

  private later(fn: () => void, ms: number): unknown {
    const h = this.deps.timers.setTimeout(() => {
      this.handles.delete(h);
      if (!this.closed) fn();
    }, ms);
    this.handles.add(h);
    return h;
  }

  private clearLater(h: unknown): void {
    if (h === null || h === undefined) return;
    this.handles.delete(h);
    this.deps.timers.clearTimeout(h);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { this.later(resolve, ms); });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const h of this.handles) this.deps.timers.clearTimeout(h);
    this.handles.clear();
    await this.saveChain;
  }

  private sys(text: string): void { this.room.broadcast("log", { kind: "system", text: text.slice(0, 4000) }); }
  private sysTo(playerId: string, text: string): void { this.room.send(playerId, "log", { kind: "system", text: text.slice(0, 4000) }); }

  private rng() { return rngFromState(this.state); }

  private ownerOf(entityId: string): Player | undefined {
    return this.room.player(this.state.characters[entityId]?.user_id);
  }

  private isAi(e: Entity): boolean {
    if (e.kind !== "pc") return true;
    const owner = this.ownerOf(e.id);
    return !owner || owner.status === "autopilot";
  }

  private playersMap(): Record<string, { name: string; present: boolean }> {
    const out: Record<string, { name: string; present: boolean }> = {};
    for (const c of Object.values(this.state.characters)) {
      const p = this.room.player(c.user_id);
      out[c.id] = { name: p?.name ?? "unknown", present: p?.status === "online" };
    }
    return out;
  }

  private presentIds(): string[] { return presentCharacterIds(this.state, this.playersMap()); }

  /** Characters of players who are not online are protected from dropping below 1 HP (engine setAbsent). */
  refreshAbsent(): void {
    const ids = Object.values(this.state.characters)
      .filter((c) => this.room.player(c.user_id)?.status !== "online")
      .map((c) => c.id);
    const cur = this.state.absentEntityIds;
    if (ids.length === cur.length && ids.every((i) => cur.includes(i))) return;
    this.state = setAbsent(this.state, ids);
  }

  // ---------- start / restore ----------

  /** Builds the world for the participants. Throws on failure; the room stays in the lobby. */
  async initialize(participants: Player[]): Promise<void> {
    const { room, deps } = this;
    const briefs = participants.map((p) => {
      const c = room.scratch.characters[p.characterId ?? ""];
      return c ? `${c.name}, ${c.title}: ${c.description}`.slice(0, 280) : p.name;
    });
    const pitch = room.settings.campaign_pitch.trim() || "An open-ended fantasy adventure in a mysterious region.";
    const bible = await generateStoryBible(deps.provider, { pitch, partyBriefs: briefs, contentRating: room.settings.content_rating });
    const facts = bible.digest === LANTERN_MARSH_BIBLE.digest ? LANTERN_MARSH_FACTS.map((f) => ({ ...f })) : [];
    const seed = Math.floor(deps.random() * 0x7fffffff);
    let state = createGameState({ seed, bible, facts, contentRating: room.settings.content_rating, campaignId: `cmp_${room.id}` });
    state.nextId = room.scratch.nextId;
    for (const p of participants) {
      const ch = room.scratch.characters[p.characterId ?? ""];
      if (!ch) continue;
      const r = addCharacter(state, ch, p.id);
      if (!r.ok) throw new Error(`character ${ch.name} was refused: ${r.errors.join("; ")}`);
      state = r.state;
    }
    const preset = pickSetting(pitch);
    const startBrief = STARTER_BRIEFS[preset];
    const rng = rngFromState(state);
    const map = generateMap(startBrief, { seed: rng.int(1, 0x7ffffffe), id: "m_start", generatedAt: new Date(deps.clock()).toISOString() }).map;
    state = addMap(state, map).state;
    state = placePartyOnMap(state, map.id, "party_start").state;
    this.state = state;
    this.sceneNote = startingNote(bible.digest, startBrief.setting.name);
    this.refreshAbsent();
  }

  /** Begin play: snapshot, then the opening DM turn. */
  begin(): void {
    this.broadcastSnapshot();
    this.enqueue(() => this.dmTurn({
      intents: [], engineLines: [], allowFollowup: true, tick: false,
      note: "The session is just beginning: set the scene for the party and invite them to act.",
    }));
  }

  /** Restore from a save file (host action). Characters are re-bound to the players now in the room. */
  restore(save: SaveFile): void {
    this.cancelTimers();
    this.state = save.state;
    this.recent = save.turns ?? [];
    this.summaries = save.summaries ?? [];
    this.sceneNote = save.scene_note ?? "";
    this.dmNotes = save.dm_notes ?? [];
    this.pendingLines = [];
    this.beat = null;
    this.rebindOwners(save.room.player_user_ids);
    this.refreshAbsent();
    if (this.state.combat) this.lastNarratedRound = this.state.combat.round;
    this.broadcastSnapshot();
    if (this.state.combat) {
      this.room.broadcast("combat_state", toWsCombat(this.state.combat));
      this.enqueue(() => this.advanceCombat());
    }
  }

  /** `savedAccounts` maps the saving room's player ids to account ids, so logged-in players get their own characters back. */
  private rebindOwners(savedAccounts: Record<string, string> = {}): void {
    const s = cloneState(this.state);
    const players = this.room.players;
    for (const p of players) p.characterId = null;
    const unclaimed: string[] = [];
    for (const c of Object.values(s.characters)) {
      const owner = players.find((p) => p.id === c.user_id && p.characterId === null);
      if (owner) owner.characterId = c.id;
      else unclaimed.push(c.id);
    }
    for (const id of [...unclaimed]) {
      const account = savedAccounts[(s.characters[id] as { user_id: string }).user_id];
      const owner = account ? players.find((p) => p.userId === account && p.characterId === null) : undefined;
      if (!owner) continue;
      owner.characterId = id;
      (s.characters[id] as { user_id: string }).user_id = owner.id;
      unclaimed.splice(unclaimed.indexOf(id), 1);
    }
    for (const p of players) {
      if (p.characterId !== null) continue;
      const id = unclaimed.shift();
      if (!id) break;
      p.characterId = id;
      (s.characters[id] as { user_id: string }).user_id = p.id;
    }
    this.state = s;
    for (const p of players) if (p.characterId) this.room.broadcast("character_claimed", { character_id: p.characterId, player_id: p.id });
  }

  private cancelTimers(): void {
    this.walkEpoch++;
    this.clearTurnTimer();
    if (this.vote) { this.clearLater(this.vote.timer); this.vote = null; }
    if (this.beat) { this.clearLater(this.beat.timer); this.beat = null; }
  }

  // ---------- views and broadcasting ----------

  private viewMap(state: GameState): Map<string, { view: EntityView; json: string }> {
    const out = new Map<string, { view: EntityView; json: string }>();
    const map = currentMap(state);
    if (!map) return out;
    for (const e of entitiesOnMap(state, map.id)) {
      const view = toEntityView(state, e);
      out.set(e.id, { view, json: JSON.stringify(view) });
    }
    return out;
  }

  private partyKey(state: GameState): string {
    return JSON.stringify([
      Object.values(state.characters).map((c) => ({ ...toCharacterView(c), hp: 0 })),
      state.bible.quests,
    ]);
  }

  private snapshotPayload(seq: number) {
    const snap = toSnapshot(this.state);
    return snap ? { ...snap, seq } : null;
  }

  /** Full snapshot to everyone (bumps seq) or to one player (current seq). */
  broadcastSnapshot(playerId?: string): void {
    if (playerId) {
      const payload = this.snapshotPayload(this.seq);
      if (payload) this.room.send(playerId, "state_snapshot", payload);
      return;
    }
    const payload = this.snapshotPayload(++this.seq);
    if (payload) this.room.broadcast("state_snapshot", payload);
  }

  /** Everything a (re)connecting player needs to be current. */
  sendFullState(playerId: string): void {
    this.broadcastSnapshot(playerId);
    const c = this.state.combat;
    if (c) {
      this.room.send(playerId, "combat_state", toWsCombat(c));
      if (this.turn) this.room.send(playerId, "turn_timer", { entity_id: this.turn.entityId, seconds_left: Math.max(0, (this.turn.deadline - this.deps.clock()) / 1000) });
    }
    if (this.vote) this.room.send(playerId, "vote_state", this.votePayload(this.vote));
    const mine = this.room.player(playerId)?.characterId;
    if (mine) this.sendLevelUpState(mine, true);
  }

  private broadcastDelta(prev: GameState, next: GameState): void {
    if (prev.currentMapId !== next.currentMapId || this.partyKey(prev) !== this.partyKey(next)) {
      this.broadcastSnapshot();
      return;
    }
    const a = this.viewMap(prev);
    const b = this.viewMap(next);
    const changed: EntityView[] = [];
    for (const [id, v] of b) if (a.get(id)?.json !== v.json) changed.push(v.view);
    const removed = [...a.keys()].filter((id) => !b.has(id));
    const pc = prev.combat ? JSON.stringify(toWsCombat(prev.combat)) : "";
    const nc = next.combat ? JSON.stringify(toWsCombat(next.combat)) : "";
    const combatChanged = pc !== nc;
    if (changed.length === 0 && removed.length === 0 && !combatChanged) return;
    this.room.broadcast("state_diff", {
      seq: ++this.seq,
      changed,
      removed,
      ...(combatChanged ? { mode: next.combat ? "combat" : "exploration", ...(next.combat ? { combat: toWsCombat(next.combat) } : {}) } : {}),
    });
  }

  /** Swap in a new state, tell everyone what changed, and react to combat starting or ending. */
  private commit(next: GameState): void {
    const prev = this.state;
    this.state = next;
    this.broadcastDelta(prev, next);
    if (!prev.combat && next.combat) {
      this.walkEpoch++;
      this.lastNarratedRound = next.combat.round;
      this.room.broadcast("combat_state", toWsCombat(next.combat));
    } else if (prev.combat && !next.combat) {
      this.clearTurnTimer();
      if (this.vote) { this.finishVoteUi(this.vote, 0); this.clearLater(this.vote.timer); this.vote = null; }
    } else if (prev.combat && next.combat && (prev.combat.active_id !== next.combat.active_id || prev.combat.round !== next.combat.round)) {
      this.room.broadcast("combat_state", toWsCombat(next.combat));
    }
  }

  /** Send engine events to the players and remember them for the DM's next turn. */
  private publish(events: EngineEvent[], opts: { toDm?: boolean } = {}): string[] {
    const lines: string[] = [];
    for (const e of events) {
      switch (e.type) {
        case "roll":
          if (e.dice.length > 0) {
            this.room.broadcast("roll_result", {
              who: e.who, label: (e.label || e.kind).slice(0, 120), dice: e.dice.slice(0, 16), modifier: e.modifier,
              total: e.total, target: e.target, outcome: e.outcome,
            });
          }
          break;
        case "chips":
          if (e.chips.length >= 2 && e.chips.length <= 4) this.room.broadcast("chips", { chips: e.chips });
          break;
        case "npc_said":
          this.room.broadcast("chat", { from_id: e.entityId, from_name: e.name.slice(0, 40), channel: "ic", text: e.text });
          this.recent.push({ speaker: e.name, text: e.text, kind: "dm" });
          break;
        case "level_up":
          this.sendLevelUpState(e.characterId);
          break;
        case "action_rejected":
          if (this.cfg.devLog) this.deps.logger.info(`[dm] rejected ${e.action}: ${e.reason}`);
          break;
        default:
          break;
      }
      // a rest that healed nobody is noise for the players; the DM still sees it
      const quiet = SILENT_EVENTS.has(e.type) || (e.type === "rest" && e.hpRestored === 0);
      if (!quiet) this.room.broadcast("log", { kind: "engine", text: humanLine(e).slice(0, 4000) });
      if (!DM_SKIP_EVENTS.has(e.type)) lines.push(describeEvent(e));
    }
    if (opts.toDm !== false) {
      this.pendingLines.push(...lines);
      if (this.pendingLines.length > MAX_PENDING_LINES) this.pendingLines.splice(0, this.pendingLines.length - MAX_PENDING_LINES);
    }
    return lines;
  }

  // ---------- presence ----------

  onPresenceChanged(p: Player): void {
    this.refreshAbsent();
    if (this.beat) this.checkBeatComplete();
    const c = this.state.combat;
    if (c && p.status === "autopilot" && this.state.characters[c.active_id]?.user_id === p.id) {
      this.enqueue(() => this.advanceCombat());
    }
  }

  // ---------- player input: speech and acts ----------

  private characterOf(player: Player) {
    return player.characterId ? this.state.characters[player.characterId] : undefined;
  }

  handleSay(player: Player, text: string, channel: "ic" | "ooc"): void {
    if (channel === "ooc" && /^\/dev(\s|$)/.test(text)) {
      this.handleDevCommand(player, text);
      return;
    }
    const ch = this.characterOf(player);
    this.room.broadcast("chat", {
      from_id: player.id,
      from_name: (channel === "ic" && ch ? ch.name : player.name).slice(0, 40),
      channel,
      text,
    });
    if (channel === "ooc" || !ch) return; // OOC never reaches the DM
    this.recordIntent(player, text);
  }

  private recordIntent(player: Player, text: string): void {
    const ch = this.characterOf(player);
    if (!ch) return;
    if (this.state.combat) {
      this.recent.push({ speaker: ch.name, text, kind: "player", channel: "ic" });
      this.trimRecent();
      return;
    }
    if (!this.beat) this.beat = { intents: [], speakers: new Set(), timer: null };
    this.beat.intents.push({ characterId: ch.id, characterName: ch.name, text });
    this.beat.speakers.add(ch.id);
    if (!this.beat.timer) this.beat.timer = this.later(() => this.closeBeat(), this.cfg.beatWindowMs);
    this.checkBeatComplete();
  }

  handleAct(player: Player, verb: "interact" | "examine" | "talk", targetId: string, reply: Reply): void {
    const ch = this.characterOf(player);
    if (!ch) return reply("error", "forbidden", "You have no character in this game.");
    if (this.state.combat) return reply("error", "invalid_state", "Actions like that wait until the fight is over.");
    const map = currentMap(this.state);
    const ent = this.state.entities[targetId];
    let name = ent?.name;
    if (!name && map) {
      const obj = map.layers.flatMap((l) => (l.type === "objectgroup" ? l.objects : []))
        .find((o) => "id" in o && o.id === targetId);
      if (obj && "kind" in obj) name = `the ${obj.kind}`;
    }
    if (!name) return reply("error", "not_found", "There is nothing like that here.");
    const phrase = verb === "talk" ? `I talk to ${name}` : verb === "examine" ? `I examine ${name}` : `I interact with ${name}`;
    reply("ok");
    this.recordIntent(player, `${phrase} (${targetId}).`);
  }

  /** basic_attack outside combat is just an intent: the DM decides whether a fight starts. */
  handleAttackIntent(player: Player, targetId: string, reply: Reply): void {
    const ch = this.characterOf(player);
    if (!ch) return reply("error", "forbidden", "You have no character in this game.");
    const name = this.state.entities[targetId]?.name;
    if (!name) return reply("error", "not_found", "That target is gone.");
    reply("ok");
    this.recordIntent(player, `I attack ${name} (${targetId}).`);
  }

  private trimRecent(): void {
    if (this.recent.length > MAX_RECENT) this.recent.splice(0, this.recent.length - MAX_RECENT);
  }

  private checkBeatComplete(): void {
    const b = this.beat;
    if (!b) return;
    const waiting = this.room.players.filter(
      (p) => p.status === "online" && p.conn?.open && p.characterId && this.state.characters[p.characterId] && !b.speakers.has(p.characterId),
    );
    if (waiting.length === 0) this.closeBeat();
  }

  private closeBeat(): void {
    const b = this.beat;
    if (!b) return;
    this.beat = null;
    this.clearLater(b.timer);
    this.enqueue(async () => {
      if (this.state.combat) {
        for (const i of b.intents) this.recent.push({ speaker: i.characterName, text: i.text, kind: "player", channel: "ic" });
        return;
      }
      await this.dmTurn({ intents: b.intents, engineLines: [], allowFollowup: true, tick: true });
      if (this.state.combat) await this.advanceCombat();
    });
  }

  // ---------- movement ----------

  handleMove(player: Player, payload: { x: number; y: number } | { direction: "n" | "s" | "e" | "w" }, reply: Reply): void {
    const ch = this.characterOf(player);
    const ent = ch ? this.state.entities[ch.id] : undefined;
    if (!ch || !ent) return reply("error", "forbidden", "You have no character on the map.");
    const combat = this.state.combat;
    if (combat && combat.active_id !== ent.id) return reply("error", "invalid_state", "It is not your turn.");
    const map = currentMap(this.state);
    if (!map) return reply("error", "invalid_state", "The game has not started.");

    if ("direction" in payload) {
      const [dx, dy] = DIRS[payload.direction];
      this.walks.delete(ent.id);
      const r = moveEntity(this.state, this.rng(), ent.id, { x: ent.x + dx, y: ent.y + dy });
      if (!r.ok) return reply("error", "invalid_state", cap(r.error ?? "You can't go that way."));
      this.commit(r.state);
      this.publish(r.events, { toDm: false });
      reply("ok");
      return;
    }

    if (combat) {
      const r = moveEntity(this.state, this.rng(), ent.id, payload);
      if (!r.ok) return reply("error", "invalid_state", cap(r.error ?? "You can't reach that tile."));
      this.commit(r.state);
      this.publish(r.events, { toDm: false });
      reply("ok");
      return;
    }

    if (!isWalkable(map, payload.x, payload.y)) return reply("error", "invalid_state", "A wall blocks the way.");
    const path = findPath(map, { x: ent.x, y: ent.y }, payload, occupiedTiles(this.state, map.id, { exceptId: ent.id }));
    if (!path || path.length === 0) return reply("error", "invalid_state", "You can't reach that tile.");
    reply("ok");
    this.startWalk(ent.id, path.slice(0, 60));
  }

  private startWalk(entityId: string, path: { x: number; y: number }[]): void {
    const token = ++this.walkEpoch;
    this.walks.set(entityId, token);
    const step = (i: number): void => {
      if (this.walks.get(entityId) !== token || this.state.combat || i >= path.length) return;
      const next = path[i] as { x: number; y: number };
      const r = moveEntity(this.state, this.rng(), entityId, next);
      if (!r.ok) { this.walks.delete(entityId); return; }
      this.commit(r.state);
      this.publish(r.events, { toDm: false });
      if (i + 1 < path.length) this.later(() => step(i + 1), this.cfg.moveStepMs);
      else this.walks.delete(entityId);
    };
    step(0);
  }

  // ---------- combat commands from players ----------

  private activeOwned(player: Player): { ent: Entity } | { error: string; code: string } {
    const c = this.state.combat;
    const ch = this.characterOf(player);
    if (!ch) return { error: "You have no character in this game.", code: "forbidden" };
    if (!c) return { error: "You are not in combat.", code: "invalid_state" };
    if (c.active_id !== ch.id) return { error: "It is not your turn.", code: "invalid_state" };
    const ent = this.state.entities[ch.id];
    if (!ent) return { error: "Your character is not on the map.", code: "invalid_state" };
    return { ent };
  }

  /** Run an engine action for the active player's character, then react to the outcome. */
  private combatAction(player: Player, reply: Reply, fn: (ent: Entity) => { state: GameState; events: EngineEvent[]; ok: boolean; error?: string }, opts: { endsTurn?: boolean } = {}): void {
    const a = this.activeOwned(player);
    if ("error" in a) return reply("error", a.code, a.error);
    const r = fn(a.ent);
    if (!r.ok) return reply("error", "invalid_state", cap(r.error ?? "That did not work."));
    this.commit(r.state);
    this.publish(r.events);
    reply("ok");
    if (opts.endsTurn || combatOutcome(this.state) !== null) this.enqueue(() => this.advanceCombat());
  }

  handleBasicAttack(player: Player, targetId: string, reply: Reply): void {
    if (!this.state.combat) return this.handleAttackIntent(player, targetId, reply);
    this.combatAction(player, reply, (ent) => basicAttack(this.state, this.rng(), ent.id, targetId));
  }

  handleUseAbility(player: Player, abilityId: string, target: string | { x: number; y: number }, reply: Reply): void {
    if (this.state.combat) {
      this.combatAction(player, reply, (ent) => useAbility(this.state, this.rng(), ent.id, abilityId, target));
      return;
    }
    const ch = this.characterOf(player);
    if (!ch) return reply("error", "forbidden", "You have no character in this game.");
    const r = useAbility(this.state, this.rng(), ch.id, abilityId, target);
    if (!r.ok) return reply("error", "invalid_state", cap(r.error ?? "That did not work."));
    this.commit(r.state);
    this.publish(r.events);
    reply("ok");
  }

  handleUseItem(player: Player, itemId: string, target: string | { x: number; y: number } | undefined, reply: Reply): void {
    if (typeof target === "object") return reply("error", "bad_message", "Items target a creature, not a tile.");
    if (this.state.combat) {
      this.combatAction(player, reply, (ent) => useItem(this.state, this.rng(), ent.id, itemId, target));
      return;
    }
    const ch = this.characterOf(player);
    if (!ch) return reply("error", "forbidden", "You have no character in this game.");
    const r = useItem(this.state, this.rng(), ch.id, itemId, target);
    if (!r.ok) return reply("error", "invalid_state", cap(r.error ?? "That did not work."));
    this.commit(r.state);
    this.publish(r.events);
    reply("ok");
  }

  handleEndTurn(player: Player, reply: Reply): void {
    this.combatAction(player, reply, (ent) => endTurn(this.state, this.rng(), ent.id), { endsTurn: true });
  }

  // ---------- level-up ----------

  /** The level_up_state payload for a character (zero picks closes the screen), or null if unknown. */
  private levelUpPayload(charId: string) {
    const v = levelUpView(this.state, charId);
    if (!v) return null;
    return {
      character_id: v.characterId,
      level: v.level,
      score_points: v.scorePoints,
      ability_picks: v.abilityPicks,
      budget: v.budget,
      budget_used: v.budgetUsed,
      per_ability_cap: v.perAbilityCap,
      caps: { max_avg: v.caps.maxAvg, max_radius: v.caps.maxRadius, max_stun_turns: v.caps.maxStunTurns },
      max_abilities: v.maxAbilities,
      abilities: v.abilities,
      scores: v.scores,
    };
  }

  /** Owner only. `onlyIfPending` skips the message when there is nothing to choose (reconnects). */
  private sendLevelUpState(charId: string, onlyIfPending = false): void {
    const owner = this.ownerOf(charId);
    const payload = this.levelUpPayload(charId);
    if (!owner || !payload) return;
    if (onlyIfPending && payload.score_points + payload.ability_picks === 0) return;
    this.room.send(owner.id, "level_up_state", payload);
  }

  private levelUpBusy = new Set<string>();

  /** Apply one level-up choice for the sender's own character. Forging runs on the serialized queue. */
  handleLevelUpChoice(
    player: Player, choice: LevelUpChoice, reply: Reply,
    sendResult: (p: { ok: boolean; message: string; forge_notes: string[]; ability?: Ability }) => void,
  ): void {
    const ch = this.characterOf(player);
    if (!ch) return reply("error", "forbidden", "You have no character in this game.");
    if (this.state.combat) return reply("error", "invalid_state", "Finish the fight first.");
    const v0 = levelUpView(this.state, ch.id);
    if (!v0 || v0.scorePoints + v0.abilityPicks === 0) return reply("error", "invalid_state", "You have no level-up choices pending.");
    if (this.levelUpBusy.has(ch.id)) return reply("error", "invalid_state", "Your last choice is still being forged.");
    const forges = choice.kind === "new_ability" || choice.kind === "reforge";
    if (choice.kind === "score" && v0.scorePoints <= 0) return reply("error", "invalid_state", "You have no ability score point to spend.");
    if (!(choice.kind === "score") && v0.abilityPicks <= 0) return reply("error", "invalid_state", "You have no ability pick to spend.");
    if (forges) this.levelUpBusy.add(ch.id);

    void this.enqueue(async () => {
      try {
        await this.applyLevelUpChoice(ch.id, choice, reply, sendResult);
      } finally {
        this.levelUpBusy.delete(ch.id);
      }
    });
  }

  private async applyLevelUpChoice(
    charId: string, choice: LevelUpChoice, reply: Reply,
    sendResult: (p: { ok: boolean; message: string; forge_notes: string[]; ability?: Ability }) => void,
  ): Promise<void> {
    const cur = () => this.state.characters[charId];
    if (!cur()) return reply("error", "forbidden", "You have no character in this game.");
    if (this.state.combat) return reply("error", "invalid_state", "Finish the fight first.");
    const name = cur()!.name;
    const refuse = (message: string, notes: string[] = []) => sendResult({ ok: false, message: message.slice(0, 500), forge_notes: notes });

    let result: ReturnType<typeof spendScorePoint> | undefined;
    let notes: string[] = [];
    let line = "";

    if (choice.kind === "score") {
      result = spendScorePoint(this.state, charId, choice.ability);
      line = `${name} raised ${choice.ability.toUpperCase()} to ${(cur()!.scores[choice.ability]) + 1}.`;
    } else if (choice.kind === "skip_ability") {
      result = skipAbilityPick(this.state, charId);
    } else {
      const replacing = choice.kind === "reforge" ? choice.ability_id : undefined;
      const old = replacing === undefined ? undefined : cur()!.abilities.find((a) => a.id === replacing);
      if (replacing !== undefined && !old) return refuse("You do not have that ability.");
      const level = cur()!.level;
      const left = remainingBudget(this.state, charId, replacing);
      const maxCost = Math.min(levelUpView(this.state, charId)!.perAbilityCap, left);
      if (maxCost < 1) return refuse(`No power budget is left (${left}). Reforge an existing ability instead.`);
      if (replacing === undefined && cur()!.abilities.length >= (levelUpView(this.state, charId)!.maxAbilities)) {
        return refuse("You already know as many abilities as you can. Reforge one instead.");
      }
      const concept = `${name}, ${cur()!.title}. ${cur()!.description}${old ? ` Upgrading the ability "${old.name}": ${old.description}` : ""}`;
      let forged: { ability: Ability; notes: string[] };
      try {
        forged = await forgeOneAbility(this.deps.provider, { concept, text: choice.text, level, maxCost }, {
          sleep: (ms) => this.sleep(ms), retryBackoffMs: this.cfg.retryBackoffMs,
        });
      } catch (err) {
        if (!(err instanceof ForgeError)) this.deps.logger.error("[level-up] forge failed:", err instanceof Error ? err.message : String(err));
        return refuse(err instanceof ForgeError ? err.message : "The forge hit a problem. Try again.");
      }
      if (this.state.combat) return reply("error", "invalid_state", "Finish the fight first.");
      result = old
        ? replaceAbility(this.state, charId, old.id as string, forged.ability)
        : addAbilityToCharacter(this.state, charId, forged.ability);
      notes = forged.notes;
      line = result.ok && result.ability
        ? (old ? `${name} reforged ${old.name} into ${result.ability.name}.` : `${name} learned ${result.ability.name}.`)
        : "";
    }

    if (!result.ok) return refuse(result.error, notes);
    this.commit(result.state);
    this.publish(result.events, { toDm: false });
    if (line) this.sys(line);
    const ability = "ability" in result ? result.ability : undefined;
    sendResult({
      ok: true,
      message: line || "You keep your abilities as they are.",
      forge_notes: notes.map((n) => n.slice(0, 1000)).slice(0, 20),
      ...(ability ? { ability } : {}),
    });
    this.sendLevelUpState(charId);
    this.autosave();
  }

  /** `/dev grow <n>` in OOC chat. Only when the room setting dev_solo is on; otherwise it does nothing. */
  private handleDevCommand(player: Player, text: string): void {
    if (!this.room.settings.dev_solo) {
      this.sysTo(player.id, "Dev commands are disabled in this room.");
      return;
    }
    const m = /^\/dev\s+grow\s+(\d{1,4})\s*$/.exec(text.trim());
    const ch = this.characterOf(player);
    if (!m || !ch) {
      this.sysTo(player.id, "Usage: /dev grow <1-1000> (needs a character).");
      return;
    }
    const n = Number(m[1]);
    if (n < 1 || n > 1000) { this.sysTo(player.id, "Usage: /dev grow <1-1000>."); return; }
    void this.enqueue(() => {
      const r = addGrowth(this.state, ch.id, n);
      if (!r.ok) { this.sysTo(player.id, r.error ?? "That did not work."); return; }
      this.commit(r.state);
      this.sysTo(player.id, `[dev] ${ch.name} gains ${n} growth.`);
      this.publish(r.events, { toDm: false });
    });
  }

  // ---------- combat loop ----------

  private clearTurnTimer(): void {
    if (this.turn) this.clearLater(this.turn.handle);
    this.turn = null;
  }

  private startTurnTimer(entityId: string): void {
    this.clearTurnTimer();
    const deadline = this.deps.clock() + this.cfg.turnMs;
    const t = { entityId, deadline, handle: null as unknown };
    this.turn = t;
    const tick = (): void => {
      if (this.turn !== t) return;
      const left = Math.max(0, deadline - this.deps.clock());
      this.room.broadcast("turn_timer", { entity_id: entityId, seconds_left: Math.round(left / 100) / 10 });
      if (left <= 0) {
        t.handle = null;
        this.enqueue(() => this.onTurnTimeout(entityId));
        return;
      }
      t.handle = this.later(tick, Math.min(this.cfg.turnTickMs, left));
    };
    tick();
  }

  /** Runs AI turns, round narration and the end of combat until a player has to act. */
  private async advanceCombat(): Promise<void> {
    for (let guard = 0; guard < 400; guard++) {
      if (this.closed) return;
      const st = this.state;
      const c = st.combat;
      if (!c) { this.clearTurnTimer(); return; }
      const outcome = combatOutcome(st);
      if (outcome) { await this.finishCombat(outcome); continue; }
      if (c.round > this.lastNarratedRound && this.pendingLines.length > 0) {
        this.lastNarratedRound = c.round;
        await this.dmTurn({ intents: [], engineLines: [], allowFollowup: false, tick: false });
        continue;
      }
      const active = st.entities[c.active_id];
      if (!active) {
        const r = endTurn(st, this.rng());
        if (!r.ok) return;
        this.commit(r.state);
        this.publish(r.events);
        continue;
      }
      if (this.isAi(active)) {
        this.clearTurnTimer();
        await this.sleep(this.cfg.aiStepMs);
        if (this.state.combat?.active_id !== active.id || this.closed) continue;
        const r = enemyTakeTurn(this.state, this.rng(), active.id);
        if (r.ok) {
          this.commit(r.state);
          this.publish(r.events);
        } else {
          const e = endTurn(this.state, this.rng(), active.id);
          if (!e.ok) return;
          this.commit(e.state);
          this.publish(e.events);
        }
        continue;
      }
      if (this.turn?.entityId !== active.id) this.startTurnTimer(active.id);
      return;
    }
  }

  private async finishCombat(outcome: "victory" | "defeat"): Promise<void> {
    this.clearTurnTimer();
    const r = endCombat(this.state, this.rng(), outcome);
    if (!r.ok) return;
    this.commit(r.state);
    this.publish(r.events);
    await this.dmTurn({ intents: [], engineLines: [], allowFollowup: true, tick: false });
  }

  private async onTurnTimeout(entityId: string): Promise<void> {
    const c = this.state.combat;
    if (!c || c.active_id !== entityId) return;
    this.turn = null;
    const owner = this.ownerOf(entityId);
    const name = this.state.entities[entityId]?.name ?? "A hero";
    if (owner && owner.status === "online" && owner.conn?.open) {
      this.sys(`${name} ran out of time.`);
      const r = endTurn(this.state, this.rng(), entityId);
      if (r.ok) {
        this.commit(r.state);
        this.publish(r.events);
      }
      await this.advanceCombat();
      return;
    }
    this.startVote(entityId, owner);
  }

  // ---------- votes ----------

  private votePayload(v: Vote, secondsLeft?: number) {
    const tally: Record<string, number> = { skip: 0, wait: 0, autopilot: 0 };
    for (const c of v.votes.values()) tally[c] = (tally[c] ?? 0) + 1;
    const name = this.state.entities[v.entityId]?.name ?? "A player";
    return {
      vote_id: v.id,
      topic: `${name}'s player is away. What should the party do?`,
      options: ["skip", "wait", "autopilot"],
      tally,
      seconds_left: secondsLeft ?? this.cfg.voteMs / 1000,
    };
  }

  private finishVoteUi(v: Vote, secondsLeft: number): void {
    this.room.broadcast("vote_state", this.votePayload(v, secondsLeft));
  }

  private startVote(entityId: string, owner: Player | undefined): void {
    const eligible = new Set(
      this.room.players.filter((p) => p.status === "online" && p.conn?.open && p.id !== owner?.id).map((p) => p.id),
    );
    if (!owner || eligible.size === 0) {
      void this.applyVoteResult(entityId, owner?.id ?? null, "autopilot");
      return;
    }
    const v: Vote = { id: `vote_${++this.voteN}`, entityId, ownerId: owner.id, votes: new Map(), eligible, timer: null };
    this.vote = v;
    v.timer = this.later(() => this.enqueue(() => this.resolveVote(v)), this.cfg.voteMs);
    this.room.broadcast("vote_state", this.votePayload(v));
  }

  handleVote(player: Player, voteId: string, choice: Choice, reply: Reply): void {
    const v = this.vote;
    if (!v || v.id !== voteId) return reply("error", "not_found", "That vote is over.");
    if (!v.eligible.has(player.id)) return reply("error", "forbidden", "You cannot vote on this.");
    v.votes.set(player.id, choice);
    reply("ok");
    this.room.broadcast("vote_state", this.votePayload(v));
    const counts = { skip: 0, wait: 0, autopilot: 0 };
    for (const c of v.votes.values()) counts[c]++;
    const majority = Math.floor(v.eligible.size / 2) + 1;
    if (Object.values(counts).some((n) => n >= majority) || v.votes.size === v.eligible.size) {
      this.enqueue(() => this.resolveVote(v));
    }
  }

  private async resolveVote(v: Vote): Promise<void> {
    if (this.vote !== v) return;
    this.vote = null;
    this.clearLater(v.timer);
    const counts: Record<Choice, number> = { skip: 0, wait: 0, autopilot: 0 };
    for (const c of v.votes.values()) counts[c]++;
    const order: Choice[] = ["skip", "wait", "autopilot"];
    const best = order.reduce((a, b) => (counts[b] > counts[a] ? b : a), "skip" as Choice);
    this.finishVoteUi(v, 0);
    await this.applyVoteResult(v.entityId, v.ownerId, best);
  }

  private async applyVoteResult(entityId: string, ownerId: string | null, choice: Choice): Promise<void> {
    const c = this.state.combat;
    if (!c || c.active_id !== entityId) return;
    const name = this.state.entities[entityId]?.name ?? "A hero";
    if (choice === "wait") {
      this.sys(`The party waits for ${name}.`);
      this.startTurnTimer(entityId);
      return;
    }
    if (choice === "autopilot") {
      const owner = this.room.player(ownerId);
      this.sys(`${name} is on autopilot until their player returns.`);
      if (owner) this.room.setStatus(owner, "autopilot");
      await this.advanceCombat();
      return;
    }
    this.sys(`${name}'s turn is skipped.`);
    const r = endTurn(this.state, this.rng(), entityId);
    if (r.ok) {
      this.commit(r.state);
      this.publish(r.events);
    }
    await this.advanceCombat();
  }

  // ---------- the DM turn ----------

  private async callDm(pack: ReturnType<typeof buildContextPack>): Promise<{ result: DmTurnResult; turnId: string } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const turnId = `t${++this.turnN}`;
      let streamed = false;
      try {
        const result = await runDmTurn(this.deps.provider, pack, {
          highStakes: this.highStakes,
          onNarration: (delta) => {
            streamed = true;
            this.room.broadcast("narration_chunk", { turn_id: turnId, text: delta, done: false });
          },
        });
        this.highStakes = result.response.high_stakes;
        return { result, turnId };
      } catch (err) {
        if (streamed) this.room.broadcast("narration_chunk", { turn_id: turnId, text: "", done: true });
        const retryable = !(err instanceof LlmError) || err.retryable;
        this.deps.logger.warn(`[dm] call failed (attempt ${attempt + 1}):`, err instanceof LlmError ? `${err.kind} ${err.status ?? ""}` : (err as Error)?.name);
        if (attempt === 0 && retryable) {
          await this.sleep(this.cfg.retryBackoffMs);
          continue;
        }
        this.sys(DM_PAUSE_LINE);
        return null;
      }
    }
    return null;
  }

  private async dmTurn(opts: { intents: Intent[]; engineLines: string[]; allowFollowup: boolean; tick: boolean; note?: string }): Promise<void> {
    const lines = [...this.pendingLines.splice(0), ...opts.engineLines];
    const pack = buildContextPack({
      state: this.state,
      players: this.playersMap(),
      intents: opts.intents,
      engineLines: lines,
      recentTurns: this.recent,
      summaries: opts.note ? [...this.summaries, opts.note] : this.summaries,
      sceneNote: this.sceneNote,
      recentLimit: this.cfg.recentTurnLimit,
    });
    for (const i of opts.intents) this.recent.push({ speaker: i.characterName, text: i.text, kind: "player", channel: "ic" });

    const out = await this.callDm(pack);
    if (!out) {
      this.trimRecent();
      return;
    }
    const { result, turnId } = out;
    const narration = result.response.narration;

    // Finish the stream: send whatever the player has not seen yet.
    const seen = result.streamedNarration;
    const rest = narration.startsWith(seen) ? narration.slice(seen.length) : seen === "" ? narration : "";
    this.room.broadcast("narration_chunk", { turn_id: turnId, text: rest, done: true });
    this.recent.push({ speaker: "DM", text: narration, kind: "dm" });
    this.trimRecent();
    if (result.response.dm_notes) this.dmNotes.push(result.response.dm_notes);
    if (this.dmNotes.length > 40) this.dmNotes.shift();

    const checkLines = await this.applyResponse(result.response);

    if (opts.tick && !this.state.combat) {
      const r = advanceBeat(this.state, this.rng());
      if (r.ok) {
        this.commit(r.state);
        this.publish(r.events);
      }
    }

    if (checkLines.length > 0 && opts.allowFollowup) {
      await this.dmTurn({ intents: [], engineLines: checkLines, allowFollowup: false, tick: false });
      return;
    }
    this.autosave();
    void this.maybeSummarize();
  }

  // ---------- applying the DM's response ----------

  private async applyResponse(resp: DmResponse): Promise<string[]> {
    const checks: CheckRequest[] = [];
    const unreferenced: string[] = [];
    let newMapId: string | null = null;
    let sceneChanged = false;

    for (const action of resp.actions) {
      try {
        if (action.type === "create_enemy") {
          const id = await this.createEnemy(action);
          if (id && !action.ref) unreferenced.push(id);
          continue;
        }
        if (action.type === "generate_map") {
          const id = this.addGeneratedMap(action.brief);
          if (id) newMapId = id;
          continue;
        }
        let a: DmAction = action;
        let sprites: Record<string, SpriteSpec> | undefined;
        if (a.type === "create_npc") sprites = await this.designNpcSprite(a);
        if (a.type === "spawn_entity") a = this.prepareSpawn(a, unreferenced);
        if (a.type === "start_combat") a = this.prepareCombat(a);
        const ctx = { ...this.dmContext(), ...(sprites ? { sprites } : {}) };
        const r = applyDmActions(this.state, this.rng(), [a], ctx);
        this.commit(r.state);
        this.publish(r.events);
        checks.push(...r.pendingChecks);
        if (a.type === "change_scene" && r.applied.length > 0) sceneChanged = true;
        for (const rej of r.rejected) if (this.cfg.devLog) this.deps.logger.info(`[dm] ${rej.action.type} refused: ${rej.reason}`);
      } catch (err) {
        this.deps.logger.error(`[dm] action ${action.type} failed:`, err instanceof Error ? err.message : String(err));
      }
    }

    if (newMapId && !sceneChanged && !this.state.combat) this.moveToMap(newMapId);
    else if (sceneChanged) this.afterSceneChange();

    const lines: string[] = [];
    for (const req of checks) {
      const r = resolveCheck(this.state, this.rng(), req, { presentCharacterIds: this.presentIds() });
      this.commit(r.state);
      lines.push(...this.publish(r.events, { toDm: false }));
      if (r.result) {
        const outcome = r.result.success ? "success" : "failure";
        lines.push(`[engine: check "${req.reason}" (${req.ability.toUpperCase()} DC ${r.result.dc}) overall result: ${outcome}]`);
      }
    }
    return lines;
  }

  private dmContext() {
    const present = this.presentIds();
    return { presentCharacterIds: present, partyLevel: computePartyLevel(this.state, present) };
  }

  /** Server pre-pass for create_npc: the engine stays pure, the server hands it the designed look. */
  private async designNpcSprite(a: Extract<DmAction, { type: "create_npc" }>): Promise<Record<string, SpriteSpec> | undefined> {
    try {
      const r = await this.deps.sprites.getOrCreateSprite({
        concept: a.concept, ...(a.appearance ? { appearance: a.appearance } : {}), name: a.name, role: a.role, kind: "npc",
      });
      return { [a.name.trim().toLowerCase()]: r.spec };
    } catch (err) {
      this.deps.logger.warn("[sprite] npc design failed:", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  private async createEnemy(a: CreateEnemyAction): Promise<string | null> {
    if (a.ref && this.state.archetypes[a.ref]) return a.ref;
    const level = this.dmContext().partyLevel;
    const r = enemyRangesForLevel(level, a.role);
    const ranges = {
      hp: [r.hp.min, r.hp.max] as [number, number],
      defense: [r.defense.min, r.defense.max] as [number, number],
      attackBonus: [r.attack.min, r.attack.max] as [number, number],
      damagePerRound: [r.damageHundredths.min / 100, r.damageHundredths.max / 100] as [number, number],
    };
    try {
      const built = await buildEnemy(this.deps.provider, { concept: a.concept, role: a.role, settingNotes: a.setting_notes, partyLevel: level, ranges }, {
        finalize: (draft) => {
          try {
            const c = clampEnemy(draft, level);
            return { ok: true as const, enemy: c.enemy, notes: c.notes };
          } catch (err) {
            return { ok: false as const, errors: [err instanceof Error ? err.message : "invalid enemy"] };
          }
        },
      });
      const enemy = { ...built.enemy };
      try {
        const look = await this.deps.sprites.getOrCreateSprite({
          concept: a.concept, ...(a.appearance ?? enemy.appearance ? { appearance: (a.appearance ?? enemy.appearance) as string } : {}),
          name: enemy.name, role: a.role, kind: "enemy",
        });
        enemy.sprite = look.spec;
        if (a.appearance) enemy.appearance = a.appearance;
      } catch (err) {
        this.deps.logger.warn("[sprite] enemy design failed:", err instanceof Error ? err.message : String(err));
      }
      if (a.ref && !this.state.archetypes[a.ref]) enemy.id = a.ref;
      else delete enemy.id;
      const reg = registerArchetype(this.state, enemy, level);
      if (!reg.ok) {
        this.pendingLines.push(`[engine: create_enemy was refused: ${reg.errors.join("; ")}]`);
        return null;
      }
      this.commit(reg.state);
      const id = reg.archetype.id as string;
      if (!a.ref) this.pendingLines.push(`[engine: enemy ${reg.archetype.name} is ready as archetype ${id}]`);
      return id;
    } catch (err) {
      this.deps.logger.warn("[dm] enemy builder failed:", err instanceof LlmError ? err.kind : (err as Error)?.name);
      this.pendingLines.push("[engine: create_enemy failed; no enemy was made]");
      return null;
    }
  }

  private addGeneratedMap(brief: Parameters<typeof generateMap>[0]): string | null {
    const st = this.state;
    let n = Object.keys(st.maps).length;
    while (st.maps[`m_gen_${n}`]) n++;
    const id = `m_gen_${n}`;
    const s = cloneState(st);
    const rng = rngFromState(s);
    const seed = rng.int(1, 0x7ffffffe);
    s.rngState = rng.state();
    try {
      const { map } = generateMap(brief, { seed, id, generatedAt: new Date(this.deps.clock()).toISOString() });
      const added = addMap(s, map);
      this.commit(added.state);
      this.publish(added.events);
      this.room.broadcast("log", { kind: "system", text: `The way ahead takes shape: ${map.meta.setting.name}.` });
      return id;
    } catch (err) {
      this.deps.logger.warn("[dm] map generation failed:", err instanceof Error ? err.message : String(err));
      this.pendingLines.push("[engine: generate_map failed; no new map was made]");
      return null;
    }
  }

  private moveToMap(mapId: string): void {
    const r = placePartyOnMap(this.state, mapId, "party_start");
    if (!r.value) return;
    this.commit(r.state);
    this.publish(r.events);
    this.afterSceneChange();
  }

  /** A scene change is a safe break: the engine's rest restores HP and abilities. Also refreshes the scene note. */
  private afterSceneChange(): void {
    const map = currentMap(this.state);
    if (map) this.sceneNote = `The party has just reached ${map.meta.setting.name}${map.meta.theme_tags.length ? ` (${map.meta.theme_tags.join(", ")})` : ""}.`;
    if (this.state.combat) return;
    const r = rest(this.state, this.rng());
    if (r.ok) {
      this.commit(r.state);
      this.publish(r.events);
    }
    this.pendingLines.push(`[engine: the party arrives at a new area, ${map?.meta.setting.name ?? "unknown"} (map ${map?.id ?? "?"})]`);
  }

  /** Spawn positions are a placement detail, not a rules number: snap a blocked tile to the nearest free one. */
  private prepareSpawn(a: Extract<DmAction, { type: "spawn_entity" }>, unreferenced: string[]): DmAction {
    let out = a;
    if (!this.state.archetypes[a.archetype_id] && unreferenced.length > 0) out = { ...out, archetype_id: unreferenced.shift() as string };
    const map = this.state.maps[out.map_id];
    if (map && out.x !== undefined && out.y !== undefined && out.slot_id === undefined && !isWalkable(map, out.x, out.y)) {
      const p = findFreeTileNear(map, out.x, out.y, occupiedTiles(this.state, map.id));
      if (p) out = { ...out, x: p.x, y: p.y };
    }
    return out;
  }

  /** The DM names archetypes it just spawned; combat needs the spawned entity ids. */
  private prepareCombat(a: Extract<DmAction, { type: "start_combat" }>): DmAction {
    const ids: string[] = [];
    const unknown: string[] = [];
    const add = (id: string) => { if (!ids.includes(id)) ids.push(id); };
    for (const id of a.participants) {
      if (this.state.entities[id]) { add(id); continue; }
      const spawned = Object.values(this.state.entities).filter((e) => e.kind === "enemy" && e.refId === id && e.hp > 0);
      if (spawned.length > 0) spawned.forEach((e) => add(e.id));
      else unknown.push(id);
    }
    if (ids.length < 2) return { ...a, participants: [...ids, ...unknown].slice(0, 24) };
    return { ...a, participants: ids.slice(0, 24) };
  }

  // ---------- memory and saves ----------

  private async maybeSummarize(): Promise<void> {
    if (this.recent.length < SUMMARIZE_AT) return;
    const old = this.recent.splice(0, SUMMARIZE_COUNT);
    try {
      const text = await summarizeTurns(this.deps.provider, {
        previousSummary: this.summaries[this.summaries.length - 1] ?? "",
        turns: old.map((t) => ({ speaker: t.speaker, text: t.text })),
      });
      if (text) {
        this.summaries.push(text);
        if (this.summaries.length > 6) this.summaries.splice(0, this.summaries.length - 6);
      }
    } catch {
      this.recent.unshift(...old);
    }
  }

  private toSaveFile(name: string): SaveFile {
    return {
      v: SAVE_VERSION,
      name,
      saved_at: new Date(this.deps.clock()).toISOString(),
      room: {
        room_id: this.room.id,
        invite_code: this.room.code,
        settings: { ...this.room.settings },
        players: this.room.players.map((p) => ({ player_id: p.id, display_name: p.name, character_id: p.characterId })),
        player_user_ids: Object.fromEntries(this.room.players.filter((p) => p.userId).map((p) => [p.id, p.userId as string])),
      },
      owner_user_id: this.room.ownerUserId ?? this.room.player(this.room.hostId)?.userId ?? null,
      campaign_title: this.state.bible.title,
      state: this.state,
      turns: this.recent,
      summaries: this.summaries,
      scene_note: this.sceneNote,
      dm_notes: this.dmNotes,
    };
  }

  private autosave(): void {
    const data = this.toSaveFile("autosave");
    this.saveChain = this.saveChain
      .then(() => writeSave(this.deps.saveDir, this.room.id, "autosave", data).then(() => undefined))
      .catch((err) => this.deps.logger.warn("[save] autosave failed:", err instanceof Error ? err.message : String(err)));
  }

  /** Writes a named save and returns its id. */
  async saveNamed(name: string): Promise<string> {
    const id = `sv_${++this.saveN}_${Math.floor(this.deps.random() * 36 ** 5).toString(36)}`;
    if (!isSafeId(id)) throw new Error("unsafe save id");
    const data = this.toSaveFile(name);
    const job = this.saveChain.then(() => writeSave(this.deps.saveDir, this.room.id, id, data).then(() => undefined));
    this.saveChain = job.catch((err) => this.deps.logger.warn("[save] failed:", err instanceof Error ? err.message : String(err)));
    await job;
    return id;
  }

  // ---------- test and debug helpers ----------

  get pendingEngineLines(): readonly string[] { return this.pendingLines; }
  get dmNotesPrivate(): readonly string[] { return this.dmNotes; }
  get status(): PlayerStatus[] { return this.room.players.map((p) => p.status); }
}

/** The starting setting preset for a campaign pitch: the engine's keyword match, else a town. */
function pickSetting(pitch: string): SettingPreset {
  return inferPreset(pitch) ?? "town";
}

function startingNote(digest: string, settingName: string): string {
  const sentences = digest.split(/(?<=[.!?])\s+/);
  const start = sentences.find((s) => /\bstarts?\b/i.test(s));
  return (start ?? `The party's adventure begins at ${settingName.toLowerCase()}.`).slice(0, 200);
}

export type { GameMap };
