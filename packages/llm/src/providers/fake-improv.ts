/**
 * Offline "improv" generators used by the fake provider. Deterministic: the same input always gives
 * the same output. They read the exact tagged formats our own context builders produce.
 */
import { PLOT_ARCS, PLOT_PATTERNS, type PlotArc, type PlotPattern } from "@aedm/schemas";
import { lanternMarshBible } from "../default-bible";
import type { ModelRequest } from "../provider";

// ---------- helpers ----------

export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const pick = <T>(xs: readonly T[], h: number, salt = 0): T => xs[((h + Math.imul(salt, 2654435761)) >>> 0) % xs.length] as T;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "creature";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const tag = (s: string, name: string): string => new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(s)?.[1]?.trim() ?? "";

/** Fit narration into 40 to 150 words without padding when already inside; pads only from the given filler. */
function fitNarration(sentences: string[], filler: string[], h: number): string {
  const out = [...sentences];
  let i = 0;
  while (words(out.join(" ")).length < 48 && i < filler.length) out.push(pick(filler, h, i++));
  let text = out.join(" ");
  const w = words(text);
  if (w.length > 140) text = w.slice(0, 140).join(" ").replace(/[,;:]?\s*\S*$/, ".");
  return text.replace(/[<>]/g, "");
}

// ---------- parsing the DM user message ----------

interface Ent { id: string; kind: string; name: string; x: number; y: number; disposition?: string }
interface Member { id: string; name: string; present: boolean }
interface Intent { characterId: string; name: string; text: string }

export interface ParsedDmContext {
  mapId: string;
  /** Free-text setting name from the <scene> tag. */
  setting: string;
  description: string;
  entities: Ent[];
  party: Member[];
  intents: Intent[];
  engine: string[];
  facts: string[];
  rating: string;
  /** Approved cast entries listed in the <cast> block. */
  cast: { assetRef: string; kind: string; name: string }[];
}

export function parseDmUser(user: string): ParsedDmContext {
  const scene = /<scene map_id="([^"]*)" setting="([^"]*)">([\s\S]*?)<\/scene>/.exec(user);
  const entities: Ent[] = [];
  // `- id "name" kind @x,y hp 3/12 disposition`; objects carry no coordinates, wounded things carry hp.
  for (const m of (scene?.[3] ?? "").matchAll(/^- (\S+) "([^"]*)" (\S+)(?: @(\d+),(\d+))?(?: hp \d+(?:\/\d+)?)?(?: (\S+))?$/gm)) {
    entities.push({ id: m[1]!, kind: m[3]!, name: m[2]!, x: m[4] ? Number(m[4]) : 4, y: m[5] ? Number(m[5]) : 4, ...(m[6] ? { disposition: m[6] } : {}) });
  }
  const party: Member[] = [];
  for (const m of tag(user, "party").matchAll(/^- (\S+) "([^"]*)".*?( \(away\))?$/gm)) {
    party.push({ id: m[1]!, name: m[2]!, present: !m[3] });
  }
  const intents: Intent[] = [];
  for (const m of user.matchAll(/<player_input character_id="([^"]*)" character="([^"]*)">\n?([\s\S]*?)\n?<\/player_input>/g)) {
    intents.push({ characterId: m[1]!, name: m[2]!, text: unescape(m[3]!) });
  }
  return {
    mapId: scene?.[1] ?? "m_start",
    setting: scene?.[2] ?? "town",
    description: (scene?.[3] ?? "").split("\n").find((l) => l.trim() !== "" && !l.startsWith("- ") && !l.startsWith("Exits:"))?.trim() ?? "",
    entities,
    party,
    intents,
    engine: tag(user, "engine_results").split("\n").filter((l) => l.startsWith("[engine")),
    facts: tag(user, "canonical_facts").split("\n").filter((l) => l.startsWith("- ")),
    rating: /Rating: (\w+)\./.exec(user)?.[1] ?? "family",
    cast: [...tag(user, "cast").matchAll(/^- asset_ref=(\S+) (npc|enemy) "([^"]*)"/gm)].map((m) => ({ assetRef: m[1]!, kind: m[2]!, name: m[3]! })),
  };
}

// ---------- DM improv ----------

type Category = "injection" | "empty" | "wellbeing" | "combat" | "travel" | "check" | "talk" | "other";

const RX = {
  injection: /ignore (all |your |the )?(previous|prior|above|rules)|ignore your rules|system\s*:|\bdm\s*:|(print|reveal|show|repeat) (me )?(your|the) (system |hidden |private )?(prompt|notes|instructions)|\binstructions?\b|"type"\s*:\s*"|\bgrant_item\b|\bset all\b.*\bhp\b|make us level|level \d+ right now|\bgive me \d+ gold|\blegendary\b/i,
  wellbeing: /\b(i (actually )?feel (awful|terrible|hopeless|empty)|want to (die|disappear)|can'?t cope|panic attack)\b/i,
  combat: /\b(attack|fight|kill|stab|slash|shoot|strike|punch|smash|ambush|charge|duel|slay)\b/i,
  travel: /\b(travel|enter|explore|follow|venture|head (to|into|out|for)|go (to|into|inside|down|up)|leave for|cross|descend|climb down|set out|walk (into|to))\b/i,
  talk: /\b(ask|say|tell|talk|speak|greet|question|chat|whisper|call out|inquire|hello|hail|\?)/i,
};

interface CheckRule { rx: RegExp; ability: string; tags: string[]; reason: string }
const CHECK_RULES: CheckRule[] = [
  { rx: /\b(sneak|creep|hide|tiptoe|shadow)\b/i, ability: "dex", tags: ["stealth"], reason: "Moving unseen" },
  { rx: /\b(pick|lockpick|unlock|jimmy)\b/i, ability: "dex", tags: ["lockpicking"], reason: "Working the lock" },
  { rx: /\b(persuade|convince|negotiate|plead|reason with|charm)\b/i, ability: "cha", tags: ["persuasion"], reason: "Making a case" },
  { rx: /\b(lie|bluff|deceive|trick|fool)\b/i, ability: "cha", tags: ["deception"], reason: "Selling a story" },
  { rx: /\b(threaten|intimidate|menace|scare)\b/i, ability: "cha", tags: ["intimidation"], reason: "Applying pressure" },
  { rx: /\b(blow up|explode|detonate|bomb|charge|fuse|demolish)\b/i, ability: "int", tags: ["explosives"], reason: "Handling a dangerous charge" },
  { rx: /\b(sprint|dash|run|race|hurry)\b/i, ability: "dex", tags: ["speed"], reason: "A burst of speed" },
  { rx: /\b(climb|jump|leap|swim|haul|lift|force|break down)\b/i, ability: "str", tags: ["athletics"], reason: "A test of strength" },
  { rx: /\b(heal|patch|bandage|treat|tend)\b/i, ability: "wis", tags: ["medicine"], reason: "Tending wounds" },
  { rx: /\b(track|forage|navigate|trail|herbs?)\b/i, ability: "wis", tags: ["survival"], reason: "Reading the land" },
  { rx: /\b(recall|study|decipher|translate|read)\b/i, ability: "int", tags: ["lore"], reason: "Drawing on knowledge" },
  { rx: /\b(craft|repair|build|tinker|rig|fix)\b/i, ability: "int", tags: ["crafting"], reason: "Making it work" },
  { rx: /\b(search|look|examine|inspect|spot|listen|check|scout|investigate|watch)\b/i, ability: "wis", tags: ["perception"], reason: "Searching carefully" },
];

type Layout = "rooms_and_corridors" | "cave" | "open_field" | "settlement" | "trail" | "arena" | "maze" | "islands";
type Environment = "indoor" | "outdoor" | "underground";
type Mood = "bright" | "neutral" | "dim" | "dark" | "eerie";

interface SettingRule {
  rx: RegExp;
  name: string;
  preset?: string;
  layout: Layout;
  environment: Environment;
  mood: Mood;
  /** Key into OPENERS for narration flavor. */
  flavor: string;
  materials?: Record<string, unknown[]>;
}

// First match wins, so specific words come before general ones.
const SETTING_RULES: SettingRule[] = [
  { rx: /\b(ship|deck|vessel|galleon|galley|sloop)\b/i, name: "Ship deck", preset: "ship_deck", layout: "arena", environment: "outdoor", mood: "bright", flavor: "town", materials: { floor: ["wooden_planks"], obstacle: ["crate", "barrel"] } },
  { rx: /\b(snow|ice|glacier|frozen|tundra|frost)\b/i, name: "Frozen rift", preset: "snowfield", layout: "open_field", environment: "outdoor", mood: "bright", flavor: "desert", materials: { floor: ["snow", { name: "Blue ice", role: "floor", color: "#9fd4f5", accent: "#4f9fe0", pattern: "cracks", tags: ["ice", "slippery"] }] } },
  { rx: /\b(volcano|volcanic|lava|magma)\b/i, name: "Ashen caldera", preset: "volcanic", layout: "cave", environment: "underground", mood: "dark", flavor: "dungeon", materials: { liquid: ["lava"] } },
  { rx: /\b(crypt|tomb|catacomb|graveyard)\b/i, name: "Old crypt", preset: "crypt", layout: "rooms_and_corridors", environment: "underground", mood: "eerie", flavor: "dungeon" },
  { rx: /\b(sewer|drain)\b/i, name: "Flooded sewer", preset: "sewer", layout: "rooms_and_corridors", environment: "underground", mood: "dim", flavor: "dungeon" },
  { rx: /\b(cave|cavern|grotto|mine)\b/i, name: "Deep cave", preset: "cave", layout: "cave", environment: "underground", mood: "dark", flavor: "dungeon" },
  { rx: /\b(maze|labyrinth)\b/i, name: "Hedge maze", layout: "maze", environment: "outdoor", mood: "eerie", flavor: "forest" },
  { rx: /\b(arena|pit|duel ring|colosseum)\b/i, name: "Fighting pit", layout: "arena", environment: "outdoor", mood: "bright", flavor: "desert" },
  { rx: /\b(island|archipelago|atoll)\b/i, name: "Scattered isles", layout: "islands", environment: "outdoor", mood: "bright", flavor: "desert" },
  { rx: /\b(temple|shrine|sanctum|cathedral)\b/i, name: "Quiet temple", preset: "temple", layout: "rooms_and_corridors", environment: "indoor", mood: "dim", flavor: "interior" },
  { rx: /\b(castle|fortress|keep|citadel)\b/i, name: "Stone keep", preset: "castle", layout: "rooms_and_corridors", environment: "indoor", mood: "dim", flavor: "interior" },
  { rx: /\b(library|archive|scriptorium)\b/i, name: "Dusty library", preset: "library", layout: "rooms_and_corridors", environment: "indoor", mood: "dim", flavor: "interior" },
  { rx: /\b(ruin|ruins|overgrown)\b/i, name: "Broken ruins", preset: "ruins", layout: "open_field", environment: "outdoor", mood: "neutral", flavor: "forest" },
  { rx: /\b(swamp|marsh|bog|fen)\b/i, name: "Misty marsh", preset: "swamp", layout: "trail", environment: "outdoor", mood: "eerie", flavor: "forest" },
  { rx: /\b(forest|wood|woods|grove|trail)\b/i, name: "Old forest", preset: "forest", layout: "trail", environment: "outdoor", mood: "neutral", flavor: "forest" },
  { rx: /\b(mountain|pass|cliff|ridge)\b/i, name: "Mountain pass", preset: "mountain_pass", layout: "trail", environment: "outdoor", mood: "neutral", flavor: "desert" },
  { rx: /\b(desert|dune|dunes|sand|oasis)\b/i, name: "Dune sea", preset: "desert", layout: "open_field", environment: "outdoor", mood: "bright", flavor: "desert" },
  { rx: /\b(beach|shore|coast|cove)\b/i, name: "Pebble beach", preset: "beach", layout: "open_field", environment: "outdoor", mood: "bright", flavor: "desert" },
  { rx: /\b(farm|barn|field|orchard)\b/i, name: "Quiet farmland", preset: "farmland", layout: "open_field", environment: "outdoor", mood: "bright", flavor: "forest" },
  { rx: /\b(market|bazaar|stalls?)\b/i, name: "Busy market", preset: "market", layout: "settlement", environment: "outdoor", mood: "bright", flavor: "town" },
  { rx: /\b(town|village|inn|square|street|harbor|harbour|quay)\b/i, name: "Harbor village", preset: "town", layout: "settlement", environment: "outdoor", mood: "neutral", flavor: "town" },
  { rx: /\b(dungeon|cellar|vault|dark corridors?)\b/i, name: "Old dungeon", preset: "dungeon", layout: "rooms_and_corridors", environment: "underground", mood: "dark", flavor: "dungeon" },
  { rx: /\b(lighthouse|tower|house|inside|hall|manor|study|desk|room)\b/i, name: "Old house", preset: "interior", layout: "rooms_and_corridors", environment: "indoor", mood: "dim", flavor: "interior" },
];

const STOP = new Set(["we", "i", "you", "the", "a", "an", "to", "into", "toward", "towards", "through", "and", "then", "follow", "go", "head", "travel", "enter", "explore", "venture", "set", "out", "for", "of", "in", "on", "it", "them", "our", "my", "us", "walk", "cross", "descend", "climb", "down", "up", "leave", "all", "is", "are"]);

/** Unknown places become an open outdoor field named from the intent's own words. */
function freeTextName(text: string): string {
  const w = text.replace(/[^A-Za-z' -]/g, " ").split(/\s+/).filter((x) => x.length > 2 && !STOP.has(x.toLowerCase())).slice(0, 3);
  return (w.map(cap).join(" ") || "Open country").slice(0, 40);
}

/** Words that set a place's mood whatever its kind: a sunken cathedral is eerie, a black keep is dark. */
const EERIE_WORDS = /\b(sunken|drowned|haunted|cursed|forsaken|ghostly|spectral|eerie|undead|flooded|whispering)\b/i;
const DARK_WORDS = /\b(dark|black|abyssal|shadowy|gloomy|midnight|lightless)\b/i;

function settingFromText(text: string, current: string): SettingRule {
  for (const r of SETTING_RULES) {
    const hit = r.rx.exec(text);
    if (!hit) continue;
    const eerie = EERIE_WORDS.exec(text)?.[0];
    const dark = DARK_WORDS.test(text);
    if (!eerie && !dark) return r;
    // keep the player's own nouns ("Sunken cathedral") and let the mood words decide the mood
    const noun = (hit[1] ?? hit[0]).toLowerCase();
    const name = eerie ? `${cap(eerie.toLowerCase())} ${noun}` : r.name;
    return { ...r, name: name.slice(0, 40), mood: dark && !eerie ? "dark" : eerie ? "eerie" : r.mood };
  }
  const named = freeTextName(text);
  const stay = SETTING_RULES.find((r) => r.rx.test(current));
  return {
    rx: /$^/, name: named === "Open country" && stay ? stay.name : named, layout: "open_field", environment: "outdoor",
    mood: "neutral", flavor: stay?.flavor ?? "town",
  };
}

function flavorOf(setting: string): string {
  return SETTING_RULES.find((r) => r.rx.test(setting))?.flavor ?? "town";
}

const OPENERS: Record<string, string[]> = {
  town: ["Smoke from a dozen chimneys threads into the cooling air above the rooftops.", "Shutters bang somewhere nearby, and the street smells of tar, fish and wet rope."],
  forest: ["Mist coils between the trunks, and every drip of water sounds like a footstep.", "The undergrowth is thick and quiet, and the light comes down in tired green shafts."],
  dungeon: ["Cold stone sweats around you, and your torchlight shivers on the damp walls.", "Somewhere deep in the dark, water drips in a slow and patient rhythm."],
  desert: ["Heat shimmers over the dunes, and the wind hisses sand across your boots.", "A hard white sun sits overhead, and the horizon wobbles like a held breath."],
  interior: ["Dust hangs in the still air, and old timbers creak as the place settles around you.", "Lamplight pools on worn boards while shadows gather in the corners."],
};

const AMBIENT = [
  "A gull cries somewhere out of sight, then falls silent as if it had thought better of it.",
  "The air carries a faint salt chill that settles into your sleeves.",
  "Nothing here is hurrying, and that quiet feels oddly deliberate.",
  "Far off, a bell tolls once and the sound thins away into the fog.",
  "Every small noise seems to land a little too loud, and then a little too late.",
];

const REACTIONS: Record<Category, string[]> = {
  injection: [
    "{n} says something so strange that a nearby stranger squints, shrugs, and goes back to what they were doing. The world has no idea what that was meant to accomplish, and it carries on.",
    "{n} mutters a string of nonsense, and a passing dog looks more interested than anyone else. Nothing answers, nothing changes, and the evening goes on exactly as before.",
  ],
  empty: [
    "For a moment nobody does anything, and the place seems to wait politely for someone to choose. Perhaps one of you could say what you would like to try.",
  ],
  wellbeing: [
    "{n}, stepping outside the story for a moment: that sounded heavy, and it matters more than any scene. We can pause the game whenever you like, or keep things quiet and gentle while you decide.",
  ],
  combat: [
    "{n} moves first, and the quiet breaks like thin ice. Boots scrape, breath catches, and whoever stands in the way turns to meet the trouble head on.",
    "{n} commits to the blow, and the moment snaps taut. Steel, fear and fog all arrive together, and there is no walking back from it now.",
  ],
  travel: [
    "{n} sets off, and the others fall in behind with a murmur of boots on wet ground. The way ahead narrows and changes character with every few steps.",
    "{n} leads the way, and the path bends out of sight. What waits there is unfamiliar, and the light seems to change in welcome or warning.",
  ],
  check: [
    "{n} tries it carefully, and everything hangs on a steady hand and a little luck. The outcome is not settled yet, and the others lean in to watch.",
    "{n} gives it their full attention, and the moment stretches thin. Whatever comes of it will not be quite what anyone expects.",
  ],
  talk: [
    "{n} speaks up, and heads turn toward the sound. The answer is slow to come, and measured when it does.",
    "{n} raises the matter plainly, and a thoughtful pause follows. People here choose their words with care.",
  ],
  other: [
    "{n} takes the moment as it comes, and the scene shifts a little in response. Small details come into focus that nobody noticed before.",
    "{n} acts, and the world answers in its own quiet way. Something changes, though not yet anything you could name.",
  ],
};

const NPC_LINES = [
  "Mind how you go out there. The fog plays tricks, and not all of them are the fog's doing.",
  "I've said all I mean to say on that, but ask me something else and I might surprise you.",
  "You're new here, so I'll tell you plainly: folk talk less after dark, and for good reason.",
  "Aye, I saw something odd, though I'm not sure it was the sort of thing a sane person repeats.",
  "Take a seat, take your time. Whatever it is you're after, it will still be there in the morning.",
];

const CHIPS: Record<Category, string[]> = {
  injection: ["Look around", "Ask a local", "Check the road", "Rest a moment"],
  empty: ["Look around", "Talk to someone", "Explore ahead"],
  wellbeing: ["Take a break", "Keep it gentle", "Carry on"],
  combat: ["Press the attack", "Fall back", "Use an ability", "Look for cover"],
  travel: ["Look around", "Proceed carefully", "Call a halt", "Check the map"],
  check: ["Try another way", "Ask for help", "Look around"],
  talk: ["Ask another question", "Look around", "Move on"],
  other: ["Look around", "Talk to someone", "Search nearby", "Move on"],
};

function categorize(text: string): Category {
  const t = text.trim();
  if (t === "") return "empty";
  if (RX.wellbeing.test(t)) return "wellbeing";
  if (RX.injection.test(t)) return "injection";
  if (RX.combat.test(t)) return "combat";
  if (RX.travel.test(t)) return "travel";
  if (CHECK_RULES.some((r) => r.rx.test(t))) return "check";
  if (RX.talk.test(t)) return "talk";
  return "other";
}

function engineSentence(lines: string[]): string {
  if (!lines.length) return "";
  const l = lines.join(" ").toLowerCase();
  if (/fail|miss|resists?/.test(l) && !/success|hit/.test(l)) return "The attempt falls short, and the moment turns awkward and costly.";
  if (/success|hit|heals?|down/.test(l)) return "The attempt lands cleanly, and the moment tilts in your favour.";
  return "The dice have spoken, and the scene bends around the result.";
}

export function improvDm(user: string): string {
  const ctx = parseDmUser(user);
  const h = hash32(ctx.intents.map((i) => `${i.characterId}:${i.text}`).join("|") + ctx.mapId + ctx.engine.join("|"));
  const present = ctx.party.filter((p) => p.present);
  const intents = ctx.intents.length ? ctx.intents : [{ characterId: present[0]?.id ?? ctx.party[0]?.id ?? "party", name: present[0]?.name ?? "The party", text: "" }];
  const cats = intents.map((i) => categorize(i.text));
  const priority: Category[] = ["wellbeing", "injection", "combat", "travel", "check", "talk", "other", "empty"];
  const primary = priority.find((c) => cats.includes(c)) ?? "other";
  const lead = intents[cats.indexOf(primary)] ?? intents[0]!;

  const actions: Record<string, unknown>[] = [];
  const quiet = primary === "injection" || primary === "empty" || primary === "wellbeing";

  if (!quiet) {
    // Checks: only when the engine has not just answered one.
    const checkIntent = intents.find((i, k) => cats[k] === "check" && primary !== "combat");
    if (checkIntent && ctx.engine.length === 0) {
      const rule = CHECK_RULES.find((r) => r.rx.test(checkIntent.text))!;
      actions.push({
        type: "request_check", target: checkIntent.characterId, ability: rule.ability,
        dc: 10 + (h % 7), tags: rule.tags, advantage: "none", reason: rule.reason,
      });
    }

    // Talking to an NPC who is in the scene and not known dead.
    const dead = new Set(ctx.facts.filter((f) => /\| is_alive \| false/.test(f)).map((f) => f.slice(2).split(" | ")[0]!.toLowerCase()));
    const npcs = ctx.entities.filter((e) => e.kind === "npc" && !dead.has(e.name.toLowerCase()));
    const spoken = intents.map((i) => i.text.toLowerCase()).join(" ");
    const target =
      npcs.find((n) => spoken.includes(n.name.toLowerCase().split(" ")[0]!)) ??
      (cats.some((c) => c === "talk") || /\b(innkeeper|merchant|stranger|guard|villager|keeper|barkeep)\b/.test(spoken) ? npcs[0] : undefined);
    if (target && primary !== "combat") {
      actions.push({ type: "npc_say", entity_id: target.id, text: pick(NPC_LINES, h, 3) });
    }
    // With a cast look on offer and nobody to talk to, a new face turns up wearing it.
    const castNpc = ctx.cast.find((c) => c.kind === "npc" && !dead.has(c.name.toLowerCase()) && !ctx.entities.some((e) => e.name.toLowerCase() === c.name.toLowerCase()));
    if (castNpc && !target && primary !== "combat" && ctx.engine.length === 0) {
      const at = ctx.entities.find((e) => e.kind === "character") ?? { x: 4, y: 4 };
      actions.push({
        type: "create_npc", name: castNpc.name.slice(0, 40), concept: `A local met in ${ctx.setting}, curious about the newcomers`.slice(0, 200), role: "bystander",
        map_id: ctx.mapId, x: Math.min(255, at.x + 2), y: Math.min(255, at.y), sprite_tags: [], asset_ref: castNpc.assetRef,
      });
    }
  }

  if (primary === "combat") {
    const concept = (lead.text.match(/\b(?:the |a |an )?([a-z]+(?: [a-z]+)?) (?:before|who|that)\b/i)?.[1] ?? "").trim();
    const foe = ctx.entities.find((e) => e.kind === "enemy");
    const name = foe ? foe.name : pick(["marsh brigand", "hollow-eyed cultist", "fog-wreathed lurker", "rusted guardian"], h, 5);
    const archetype = `en_${slug(concept && !foe ? concept : name)}`.slice(0, 40);
    const anchor = ctx.entities.find((e) => e.kind === "character") ?? ctx.entities[0] ?? { x: 4, y: 4 };
    const ids = (present.length ? present : ctx.party).map((p) => p.id);
    const castEnemy = ctx.cast.find((c) => c.kind === "enemy");
    if (!foe) {
      actions.push({
        type: "create_enemy", concept: `A ${name} met in ${ctx.setting}, hostile and quick to strike`, // a lone hero's encounter budget (10 + 3 x level) is smaller than a standard enemy's threat, so a solo party gets a minion
        role: ids.length >= 5 ? "elite" : ids.length === 1 ? "minion" : "standard",
        setting_notes: ctx.description.slice(0, 120), ref: archetype,
        ...(castEnemy ? { asset_ref: castEnemy.assetRef } : {}),
        appearance: `${pick(["wiry", "hulking", "gaunt", "bristling"], h, 6)} ${name} in ${pick(["mud-brown", "ash-grey", "dark-red", "pale-blue"], h, 7)} rags, ${pick(["glowing eyes", "a notched blade", "bone trinkets", "a patched hood"], h, 8)}`.slice(0, 160),
      });
    }
    const archId = foe ? foe.id : archetype;
    if (!foe) {
      actions.push({ type: "spawn_entity", archetype_id: archId, map_id: ctx.mapId, x: Math.min(255, anchor.x + 3), y: Math.min(255, anchor.y), count: 1 });
    }
    actions.push({
      type: "start_combat", participants: [...ids.slice(0, 6), archId].slice(0, 24).length >= 2 ? [...ids.slice(0, 6), archId] : [lead.characterId, archId],
      difficulty: "standard",
    });
  } else if (primary === "travel") {
    const text = intents.map((i) => i.text).join(" ");
    const place = settingFromText(text, ctx.setting);
    const roomType = place.environment === "outdoor" ? (place.preset === "ship_deck" ? "deck" : "outdoor") : place.layout === "cave" ? "cave" : "chamber";
    actions.push({
      type: "generate_map",
      brief: {
        setting: {
          name: place.name,
          ...(place.preset ? { preset: place.preset } : {}),
          layout: place.layout, environment: place.environment, mood: place.mood,
          ...(place.materials ? { materials: place.materials } : {}),
        },
        theme_tags: [place.flavor, pick(["quiet", "damp", "ancient", "overgrown"], h, 2)], size_class: "small",
        rooms: [
          { id: "r1", type: roomType, size: "medium", connects_to: ["r2"] },
          { id: "r2", type: roomType === "chamber" ? "hall" : roomType, size: "small", connects_to: ["r1"] },
        ],
        points_of_interest: [{ kind: pick(["chest", "altar", "sign"], h, 4), room_id: "r2" }],
        entity_slots: [{ role: "npc", room_id: "r1", count: 1 }],
        exits: [{ side: "south", label: "The way you came" }],
      },
    });
  }

  actions.push({ type: "suggest_actions", chips: CHIPS[primary].slice(0, 3 + (h % 2 === 0 ? 0 : 1)).slice(0, 4) });

  // Narration, built from phrase banks. Never echoes the player's words.
  const opener = pick(OPENERS[flavorOf(ctx.setting)] ?? OPENERS.town!, h);
  const sentences = [opener];
  if (ctx.description && primary !== "injection") sentences.push(ctx.description.split(/(?<=[.!?])\s/)[0]!.slice(0, 160));
  intents.slice(0, 3).forEach((i, k) => sentences.push(pick(REACTIONS[cats[k]!], h, k + 1).replace("{n}", i.name || "Someone")));
  const eng = engineSentence(ctx.engine);
  if (eng) sentences.push(eng);
  const narration = fitNarration(sentences, AMBIENT, h);

  return JSON.stringify({
    v: 1,
    narration,
    actions,
    dm_notes: "Offline improv narrator: keep it moving and keep it fair.",
    importance: primary === "combat" ? 3 : primary === "travel" ? 3 : 2,
    high_stakes: false,
  });
}

// ---------- ability forge ----------

interface Effect { [k: string]: unknown }

const IMPOSSIBLE = /\b(unwrite|erase|delete .* from existence|from existence|time travel|resurrect|raise the dead|mind control|control (their|his|her) mind|summon|infinite|unlimited|invincib|kill (them )?all|instakill|wish)\b/i;
const REACTION = /\b(riposte|counter ?attack|reaction|parry|turned back on)\b/i;

function nameOf(abilityText: string): { name: string; desc: string } {
  const m = /^\s*\*{0,2}([^:*\n]{2,40}?)\*{0,2}\s*:\s*\*{0,2}\s*([\s\S]+)$/.exec(abilityText);
  const name = (m?.[1] ?? words(abilityText).slice(0, 3).map(cap).join(" ")).trim().slice(0, 40) || "Improvised Technique";
  const desc = (m?.[2] ?? abilityText).trim().replace(/\s+/g, " ").slice(0, 200) || name;
  return { name, desc };
}

export function improvAbility(abilityText: string, level: number, allowedTags: string[], offline = true): Record<string, unknown> {
  const t = abilityText.toLowerCase();
  const { name, desc } = nameOf(abilityText);
  const dmgDice = `${Math.min(4, 1 + Math.floor((level - 1) / 3))}d6`;
  const healDice = `${Math.min(4, 1 + Math.floor((level - 1) / 3))}d4`;
  const effects: Effect[] = [];
  let target = "enemy";
  let range: number;
  let usesPerRest: number | undefined;
  let cooldown: number | undefined = 2;
  const tags: string[] = [];
  const addTag = (x: string) => { if (allowedTags.includes(x) && tags.length < 2 && !tags.includes(x)) tags.push(x); };
  const notes: string[] = [];
  const area = /\b(area|blast|burst|everything|all|wide|cloud|radius)\b/.test(t);
  const save = { ability: "con", dc: "caster_dc" };

  if (/\b(heal|restore|mend|patch|poultice|bandage|hit points)\b/.test(t)) {
    const burst = /\b(party|everyone|all allies|burst)\b/.test(t);
    effects.push(burst ? { type: "heal", shape: "burst", radius_tiles: 1, dice: healDice } : { type: "heal", shape: "single", dice: healDice });
    target = burst ? "tile" : "ally"; range = burst ? 4 : 1; addTag("medicine"); addTag("nature");
    if (burst) { usesPerRest = 1; cooldown = undefined; notes.push("Scaled to a small burst, once per rest."); }
  } else if (/\b(smoke|fog|mist)\b/.test(t) && /\b(block|hide|screen|obscure|cover|sight)\b/.test(t)) {
    effects.push({ type: "terrain", kind: "smoke", shape: "burst", radius_tiles: 1, duration_turns: 2 });
    target = "tile"; range = 6; addTag("stealth");
  } else if (/\b(trip ?wire|trap|snare)\b/.test(t) && !/\b(root|hold)\b/.test(t)) {
    effects.push({ type: "terrain", kind: "trap", shape: "tile", duration_turns: 3, dice: dmgDice, damage_type: "sharp" });
    target = "tile"; range = 4; addTag("crafting");
  } else if (/\b(reveal|lantern|see hidden|detect)\b/.test(t)) {
    effects.push({ type: "reveal", radius_tiles: 2 });
    target = "self"; range = 0; addTag("perception");
  } else if (/\b(dash|rush|blink|charge forward|lunge)\b/.test(t)) {
    effects.push({ type: "dash", tiles: 4, with_attack: true });
    target = "enemy"; range = 4; addTag("speed");
  } else if (/\b(haste|speed|burst of speed|faster|quicken)\b/.test(t)) {
    effects.push({ type: "condition", condition: "hasted", duration_turns: 2, on: "always" });
    target = "ally"; range = 4; addTag("speed");
  } else if (/\b(root|hold|snare|entangle|bind)\b/.test(t)) {
    effects.push({ type: "condition", condition: "rooted", duration_turns: 2, on: "hit" });
    target = "enemy"; range = 6; addTag("nature");
  } else if (/\b(evasive|slip away|fade|dodge)\b/.test(t) || REACTION.test(t)) {
    effects.push({ type: "condition", condition: "evasive", duration_turns: 1, on: "always" });
    target = "self"; range = 0; addTag("stealth"); addTag("speed");
    if (REACTION.test(t)) notes.push("Reactions are unsupported, so this grants evasion for one turn instead.");
  } else if (/\bmark\b/.test(t)) {
    effects.push({ type: "mark", duration_turns: 2 });
    target = "enemy"; range = 8; addTag("perception");
  } else if (/\b(shield|ward|absorb|barrier)\b/.test(t)) {
    effects.push({ type: "shield", absorb: 4 + 2 * level, duration_turns: 2 });
    target = "ally"; range = 4;
  } else if (/\b(push|shove|knock back)\b/.test(t)) {
    effects.push({ type: "push", tiles: 2 });
    target = "enemy"; range = 2; addTag("athletics");
  } else if (/\bpull\b/.test(t)) {
    effects.push({ type: "pull", tiles: 2 });
    target = "enemy"; range = 6;
  } else {
    const dtype = /\b(fire|burn|flame|blast|detonate|charge|explo)/.test(t) ? "fire"
      : /\b(cut|slash|blade|slice|stab|bleed)/.test(t) ? "sharp"
      : /\b(frost|cold|ice)/.test(t) ? "cold"
      : /\b(shock|lightning|spark)/.test(t) ? "lightning"
      : /\b(acid|corrod)/.test(t) ? "acid"
      : /\b(chord|song|mind|psychic|erase|unwrite)/.test(t) ? "psychic"
      : "blunt";
    if (area) {
      effects.push({ type: "damage", shape: "burst", radius_tiles: 1, dice: dmgDice, damage_type: dtype, save, on_save: "half" });
      target = "tile"; range = 6;
    } else {
      effects.push({ type: "damage", shape: "single", dice: dmgDice, damage_type: dtype });
      range = 6;
    }
    if (/explosiv|charge|detonat|bomb/.test(t)) addTag("explosives");
    if (/\b(cut|blade|strike|slash)\b/.test(t)) addTag("speed");
  }

  if (/\bstun/.test(t) && effects.length < 4 && !effects.some((e) => e.condition === "stunned")) {
    effects.push({ type: "condition", condition: "stunned", duration_turns: 1, on: area ? "failed_save" : "hit", ...(area ? { save } : {}) });
  }
  if (/\bbleed/.test(t) && !effects.some((e) => e.condition === "bleeding")) {
    effects.push({ type: "condition", condition: "bleeding", duration_turns: 3, on: "hit" });
  }
  if (/\b(once per rest|whole party|reality|everything within)\b/.test(t)) { usesPerRest = 1; cooldown = undefined; }
  if (usesPerRest === undefined && /(\bstun|damage|detonate|blast)/.test(t) && cooldown === undefined) cooldown = 2;

  const out: Record<string, unknown> = {
    v: 1, name, description: desc, tags, action: "action", target, range_tiles: range, effects,
    ...(usesPerRest !== undefined ? { uses_per_rest: usesPerRest } : { cooldown_turns: cooldown ?? 2 }),
  };
  if (notes.length) out.forge_notes = notes.join(" ").slice(0, 200);
  else if (offline) out.forge_notes = "Built offline from keywords; the engine sets the cost.";
  return out;
}

export function improvForge(user: string, system: string): string {
  const concept = tag(user, "character_concept");
  const text = unescape(tag(user, "ability_text"));
  const level = Number(/caps for level (\d+)/.exec(system)?.[1] ?? 1);
  const allowed = (/only from this list: ([^\n]*?)\.?\s*(?:\n|$)/.exec(system)?.[1] ?? "").split(/,\s*/).filter(Boolean);
  void concept;
  const ability = improvAbility(text, level, allowed);
  if (IMPOSSIBLE.test(text)) {
    const alt = improvAbility("Mind Lash: A focused psychic blow strikes a single enemy.", level, allowed, false);
    alt.forge_notes = "Closest allowed version: single-target psychic damage.";
    return JSON.stringify({
      rejected: true,
      reason: "The engine cannot erase, control or summon without limit. Here is the closest allowed ability.",
      alternative: alt,
    });
  }
  return JSON.stringify(ability);
}

// ---------- enemy builder ----------

function rangeOf(system: string, label: string, fallback: [number, number]): [number, number] {
  const m = new RegExp(`${label} (\\d+) to (\\d+)`).exec(system);
  return m ? [Number(m[1]), Number(m[2])] : fallback;
}

const DICE_AVG: [string, number][] = [["1d4", 2.5], ["1d6", 3.5], ["1d8", 4.5], ["1d10", 5.5], ["1d12", 6.5], ["2d6", 7], ["2d8", 9], ["2d10", 11], ["3d8", 13.5], ["4d8", 18]];

export function improvEnemy(user: string, system: string): string {
  const concept = unescape(tag(user, "enemy_concept"));
  const role = (tag(user, "role") || "standard") as "minion" | "standard" | "elite" | "boss";
  const hp = rangeOf(system, "HP", [10, 20]);
  const def = rangeOf(system, "Defense", [11, 14]);
  const atk = rangeOf(system, "attack bonus", [2, 4]);
  const dmg = rangeOf(system, "damage per round", [4, 7]);
  const level = Number(/party level (\d+)/.exec(system)?.[1] ?? 1);
  const lerp = (r: [number, number], f: number) => Math.round(r[0] + (r[1] - r[0]) * f);
  const f = { minion: 0, standard: 0.5, elite: 1, boss: 1 }[role] ?? 0.5;
  const dmgTarget = lerp(dmg, f);
  const dice = DICE_AVG.reduce((best, d) => (Math.abs(d[1] - dmgTarget) < Math.abs(best[1] - dmgTarget) ? d : best))[0];
  const nameWords = words(concept.replace(/^(an?|the)\s+/i, "").replace(/[^A-Za-z' -]/g, " ")).slice(0, 3);
  const name = (nameWords.map(cap).join(" ") || "Nameless Foe").slice(0, 40);
  const abilityCount = { minion: 0, standard: 1, elite: 2, boss: 2 }[role] ?? 1;
  const abilities: Record<string, unknown>[] = [];
  if (abilityCount > 0) {
    abilities.push(improvAbility(`${cap(nameWords[0] ?? "Savage")} Strike: ${concept.slice(0, 120)} strikes a single enemy.`, level, [], false));
  }
  if (abilityCount > 1) {
    abilities.push(improvAbility(`Dread Presence: the foe slows the target with fear.`.replace("slows", "hold and root"), level, [], false));
  }
  const weak = /\b(fire|burn|flame)/i.test(concept) ? "cold" : /\b(ghost|spirit|drowned|choir|voice)/i.test(concept) ? "radiant" : "fire";
  return JSON.stringify({
    v: 1, name, concept: concept.slice(0, 200) || name, role,
    stats: {
      hp: role === "boss" ? Math.round(hp[1] * 2.5) : lerp(hp, f),
      defense: Math.min(30, role === "boss" ? def[1] + 1 : lerp(def, f)),
      attack_bonus: role === "boss" ? atk[1] + 1 : lerp(atk, f),
      speed: 5, damage_dice: dice,
    },
    weakness: weak, resistance: null,
    behavior: ["targets the weakest-looking ally", "retreats at 30% HP"],
    loot_hint: "A few coins and a trinket.",
    sprite_tags: nameWords.map((w) => w.toLowerCase()).slice(0, 3),
    appearance: concept.slice(0, 160),
    abilities,
  });
}

// ---------- sprite designer ----------

/** Small keyword table (the llm package must not import the engine). Hash picks the colors and fills gaps. */
const FAKE_BODIES: [RegExp, string][] = [
  [/\b(wolf|wolves|bear|hound|dog|boar|fox|rat|stag|cat)s?\b/, "beast"],
  [/\b(bird|harpy|bat|crow|raven|owl|hawk|eagle)s?\b/, "avian"],
  [/\b(snake|eel|wyrm|serpent|worm|viper)s?\b/, "serpent"],
  [/\b(spider|beetle|scorpion|mantis|crab|wasp)s?\b/, "insectoid"],
  [/\b(slime|ooze|jelly|blob)s?\b/, "amorphous"],
  [/\b(golem|automaton|clockwork|construct)s?\b/, "construct"],
  [/\b(ghost|wraith|spirit|specter|phantom|shade|choir)s?\b/, "spirit"],
  [/\b(treant|vine|fungus|mushroom|bramble)s?\b/, "plant"],
  [/\b(statue|chest|totem|mimic|idol)s?\b/, "object"],
];
const FAKE_PARTS: [RegExp, string][] = [
  [/\b(robed|robe|priest|chorister|mage|wizard)\b/, "robe"],
  [/\b(hooded|hood|cultist)\b/, "hood"],
  [/\b(knight|armored|guard|soldier)\b/, "armor"],
  [/\b(sword|blade|knight)\b/, "sword"],
  [/\b(staff|wizard|mage)\b/, "staff"],
  [/\b(horned|horns?|demon)\b/, "horns"],
  [/\b(glowing|eyes|ghost|wraith)\b/, "glowing_eyes"],
  [/\b(drowned|dripping|wet)\b/, "drips"],
  [/\b(fire|flame|burning)\b/, "flames"],
  [/\b(winged|wings|harpy|bat)\b/, "wings"],
];
const FAKE_COLORS: [RegExp, string[]][] = [
  [/\b(drowned|sea|water|river|ice|frost)\b/, ["#2f6bb5", "#5c6380", "#9fd4f5"]],
  [/\b(fire|flame|burning|demon|ember)\b/, ["#c0392b", "#3b3f55", "#f5a65b"]],
  [/\b(undead|ghost|wraith|spirit|choir|lich)\b/, ["#5c6380", "#6a45a8", "#cbb0f0"]],
  [/\b(forest|vine|moss|fungus|druid|wolf)\b/, ["#4f8a3c", "#70472f", "#e8c95a"]],
];

export function improvSprite(user: string): string {
  const concept = unescape(tag(user, "concept")).toLowerCase();
  const appearance = unescape(tag(user, "appearance")).toLowerCase();
  const role = tag(user, "role").toLowerCase();
  const text = `${concept} ${appearance}`;
  const h = hash32(text);
  const body = FAKE_BODIES.find(([re]) => re.test(text))?.[1] ?? "humanoid";
  const parts = FAKE_PARTS.filter(([re]) => re.test(text)).map(([, p]) => p);
  const fill = ["cloak", "tool", "lantern"];
  for (let i = 0; parts.length < 2 && i < 3; i++) {
    const p = pick(fill, h, i);
    if (!parts.includes(p)) parts.push(p);
  }
  const palette = FAKE_COLORS.find(([re]) => re.test(text))?.[1] ??
    pick([["#9a6a3f", "#4f8a3c", "#e8c95a"], ["#2f6bb5", "#70472f", "#f6e8a0"], ["#9b72d8", "#3b3f55", "#f5a65b"]], h);
  const size = role === "boss" ? "large" : role === "minion" ? "small" : "medium";
  return JSON.stringify({
    body, size,
    palette: { primary: palette[0], secondary: palette[1], accent: palette[2], detail: "#1b1626" },
    parts: parts.slice(0, 4).map((part, i) => ({ part, color: (["primary", "secondary", "accent", "detail"] as const)[i] })),
    traits: (appearance || concept).slice(0, 160),
  });
}

// ---------- bible / summary ----------

/** The offline bible: the Lantern Marsh, with a plot of the pattern and arc named in the request's <plot_plan> (if any). */
export function improvBible(user = ""): string {
  const plan = /<plot_plan>([\s\S]*?)<\/plot_plan>/.exec(user)?.[1] ?? "";
  const pattern = /^pattern: (\w+)/m.exec(plan)?.[1];
  const arc = /^arc: (\w+)/m.exec(plan)?.[1];
  const p = (PLOT_PATTERNS as readonly string[]).includes(pattern ?? "") ? (pattern as PlotPattern) : undefined;
  const a = (PLOT_ARCS as readonly string[]).includes(arc ?? "") ? (arc as PlotArc) : undefined;
  return JSON.stringify(lanternMarshBible(p, a));
}

export function improvSummary(user: string): string {
  const prev = tag(user, "previous_summary");
  const turns = tag(user, "turns").split("\n").filter(Boolean);
  const recent = turns.slice(-6).map((l) => l.replace(/\s+/g, " ").slice(0, 120));
  const s = [prev && prev !== "(none)" ? prev : "", ...recent].filter(Boolean).join(" ");
  return words(s).slice(0, 140).join(" ");
}

// ---------- dispatch ----------

export function improvFor(req: ModelRequest): string {
  const first = req.messages[0]?.content ?? "";
  if (first.includes("<player_input") || first.includes("<scene ")) return improvDm(first);
  if (first.includes("<ability_text>")) return improvForge(first, req.system);
  if (first.includes("<enemy_concept>")) return improvEnemy(first, req.system);
  if (req.purpose === "sprite" || (first.includes("<concept>") && first.includes("<appearance>"))) return improvSprite(first);
  if (first.includes("<story_pitch>")) return improvBible(first);
  if (first.includes("<turns>")) return improvSummary(first);
  return improvDm(first);
}
