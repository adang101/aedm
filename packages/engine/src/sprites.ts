import {
  MAX_SPRITE_PARTS, OUTLINE_HEX, PALETTE, PART_GROUPS, RAMP_NAMES, SPRITE_SIZES, SpriteSpecSchema, isHex, isPart, snapToPalette,
  type BodyPlan, type Part, type PartColor, type PartSide, type RampName, type SpritePose, type SpriteSize, type SpriteSpec, type SpriteSpecDraft,
} from "@aedm/schemas";
import { createRng, type Rng } from "./rng.ts";

// ---------- finalizer ----------

export interface SpriteFinalizeContext {
  /** npc role (merchant, villain...), enemy role (minion, standard, elite, boss), or "pc" / "prop". */
  role?: string | undefined;
  /** Free-text mood ("hostile", "frightened"...). Only picks a default pose. */
  mood?: string | undefined;
  /** Used for a missing glyph. */
  name?: string | undefined;
}

/** Near-match names the designer model tends to write, mapped to catalog parts. Exact catalog names need no entry. */
const PART_ALIASES: Record<string, Part> = {
  horn: "horns", antler: "antlers", wizard_hat: "hat", witch_hat: "hat", pointed_hat: "hat", cap: "hat", helm: "helmet", helmed: "helmet",
  cape: "cloak", mantle: "cloak", cloaked: "cloak", robes: "robe", robed: "robe", hooded: "hood", cowl: "hood", crowned: "crown",
  masked: "mask", glowing_eye: "glowing_eyes", glowing: "glowing_eyes", eyes: "glowing_eyes", eye: "extra_eyes", many_eyes: "extra_eyes",
  eyestalks: "extra_eyes", ear: "ears_pointed", pointed_ears: "ears_pointed", elf_ears: "ears_pointed", hair: "long_hair", long_hairs: "long_hair",
  bearded: "beard", armour: "armor", plate: "armor", mail: "armor", chainmail: "armor", scale: "scales", scaled: "scales", pelt: "fur", furry: "fur",
  carapace: "shell", chitin: "shell", spike: "spikes", spines: "spikes", thorns: "spikes", tentacle: "tentacles", wing: "wings", fin: "fins",
  root: "roots", leaf: "leaves", foliage: "leaves", gear: "gears", cogs: "gears", crystal: "crystals", gem: "crystals",
  blade: "sword", longsword: "sword", dagger: "sword", saber: "sword", rapier: "sword", hatchet: "axe", battleaxe: "axe", greataxe: "axe",
  pike: "spear", lance: "spear", trident: "spear", harpoon: "spear", longbow: "bow", crossbow: "bow", rod: "staff", crook: "staff", cane: "staff",
  buckler: "shield", lamp: "lantern", torch: "lantern", tome: "book", grimoire: "book", scroll: "book", hammer: "tool", pickaxe: "tool",
  shovel: "tool", wrench: "tool", sphere: "orb", crystal_ball: "orb", halo_light: "halo", flame: "flames", fire: "flames", burning: "flames",
  glow: "aura", sparkle: "sparkles", glitter: "sparkles", drip: "drips", dripping: "drips", mist: "smoke", ash: "smoke",
};

const sizeIdx = (s: SpriteSize): number => SPRITE_SIZES.indexOf(s);

/** hex to [rampName, step] when it is a master palette ramp color. */
function rampStep(hex: string): [RampName, number] | undefined {
  for (const r of RAMP_NAMES) {
    const i = PALETTE[r].indexOf(hex.toLowerCase());
    if (i >= 0) return [r, i];
  }
  return undefined;
}

/** Franchise and real-name blocklist: a short, simple pattern list. Matches are removed from traits. */
const NAME_BLOCKLIST =
  /\b(pok[eé]mon|zelda|mario|sonic|dungeons\s*(?:&|and)\s*dragons|d&d|warhammer|star\s*wars|star\s*trek|harry\s*potter|gandalf|tolkien|hobbit|disney|marvel|minecraft|diablo|skyrim|elder\s*scrolls|final\s*fantasy|dark\s*souls|witcher|game\s*of\s*thrones|pixar|ghibli|lovecraft|batman|superman|spider-?man|darth\s*vader)\b/gi;
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/gi;

export function cleanTraits(raw: string, notes: string[] = []): string {
  let t = raw.replace(URL_PATTERN, " ").replace(NAME_BLOCKLIST, () => { notes.push("removed a franchise name from traits"); return " "; });
  t = t.replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
  if (t.length > 160) t = t.slice(0, 160).replace(/\s+\S*$/, "").trim() || t.slice(0, 160);
  return t;
}

/** One or two characters for a badge: initials of the first two words, or the first letter. */
export function glyphFromName(name: string): string {
  const ws = name.trim().split(/[\s_-]+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  if (ws.length === 0) return "?";
  const first = [...(ws[0] as string)][0] as string;
  const second = ws.length > 1 ? [...(ws[1] as string)][0] : undefined;
  return (first + (second ?? "")).toUpperCase().slice(0, 2);
}

function normPartName(raw: string): Part | undefined {
  const k = raw.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z_]/g, "");
  if (isPart(k)) return k;
  const a = PART_ALIASES[k];
  if (a) return a;
  // plural / singular drift: "horns"<->"horn", "swords"->"sword"
  if (k.endsWith("s") && isPart(k.slice(0, -1))) return k.slice(0, -1) as Part;
  if (isPart(`${k}s`)) return `${k}s` as Part;
  return undefined;
}

const HELD = new Set<string>(PART_GROUPS.held);
/** Default hand for a held item without a side. Shields and lanterns sit in the left hand, everything else in the right. */
const LEFT_HANDED = new Set<string>(["shield", "lantern", "book", "orb"]);
/** Part sets of which at most one may be worn (the first one listed in the draft wins). */
const EXCLUSIVE_SETS: { label: string; parts: readonly Part[] }[] = [
  { label: "head cover", parts: ["hood", "hat", "helmet"] },
  { label: "crown vs hat or helmet", parts: ["crown", "hat", "helmet"] },
  { label: "head growth", parts: ["horns", "antlers"] },
  { label: "outfit", parts: ["robe", "armor"] },
  { label: "skin", parts: ["fur", "scales", "shell"] },
];

function hands(part: Part, side: PartSide | undefined): ("left" | "right")[] {
  if (side === "both") return ["left", "right"];
  if (side) return [side];
  return [LEFT_HANDED.has(part) ? "left" : "right"];
}

/**
 * Turn a model's draft into a valid `SpriteSpec`. Rules, in order:
 * - palette colors are snapped to the master palette; if primary and secondary snap to the same color the
 *   secondary moves two steps along its ramp; an accent equal to primary moves to the ramp's light end;
 * - part names are normalized (aliases such as "horn", "wizard hat", "cape"); unknown names are dropped;
 * - duplicates drop (first wins);
 * - contradictions drop the later part: at most one of hood/hat/helmet, crown never with hat or helmet (crown
 *   with hood is allowed), one of horns/antlers, one of robe/armor (cloak goes with either), one of fur/scales/shell,
 *   and one held item per hand (`side` or the default hand; "both" takes both hands);
 * - at most 6 parts, in draft order, so put the important ones first;
 * - size is clamped by role and body plan (minions at most medium, non-boss humanoids at most large, bosses at least medium);
 * - glyph defaults to the name's initials, pose to the role/body/mood, traits are cleaned (no URLs or franchise names, at most 160).
 */
export function finalizeSpriteSpec(draft: SpriteSpecDraft, ctx: SpriteFinalizeContext = {}): { spec: SpriteSpec; notes: string[] } {
  const notes: string[] = [];
  const role = (ctx.role ?? "").toLowerCase();

  // palette
  const snap = (hex: string, fallback: string): string => (isHex(hex) ? snapToPalette(hex) : fallback);
  const primary = snap(draft.palette.primary, PALETTE.earth[2]);
  let secondary = snap(draft.palette.secondary, PALETTE.stone[1]);
  let accent = snap(draft.palette.accent, PALETTE.sand[2]);
  const detail = snap(draft.palette.detail, OUTLINE_HEX);
  if (secondary === primary) {
    const rs = rampStep(primary);
    secondary = rs ? PALETTE[rs[0]][rs[1] >= 2 ? rs[1] - 2 : rs[1] + 2] as string : OUTLINE_HEX;
    notes.push("secondary color shifted to contrast with primary");
  }
  if (accent === primary) {
    const rs = rampStep(primary);
    accent = rs ? PALETTE[rs[0]][rs[1] >= 3 ? 1 : 3] as string : PALETTE.sand[3];
    notes.push("accent color shifted to contrast with primary");
  }

  // parts
  const kept: { part: Part; color?: PartColor | undefined; side?: PartSide | undefined }[] = [];
  const dropped: string[] = [];
  for (const p of draft.parts) {
    const name = normPartName(p.part);
    if (!name) { dropped.push(p.part); continue; }
    if (kept.some((k) => k.part === name)) continue;
    const clash = EXCLUSIVE_SETS.find((set) => set.parts.includes(name) && kept.some((k) => set.parts.includes(k.part)));
    if (clash) { notes.push(`dropped ${name}: conflicts with another part (${clash.label})`); continue; }
    if (HELD.has(name)) {
      const used = new Set(kept.filter((k) => HELD.has(k.part)).flatMap((k) => hands(k.part, k.side)));
      if (hands(name, p.side).some((h) => used.has(h))) { notes.push(`dropped ${name}: that hand already holds something`); continue; }
    }
    kept.push({ part: name, ...(p.color ? { color: p.color } : {}), ...(p.side ? { side: p.side } : {}) });
  }
  if (dropped.length) notes.push(`dropped unknown parts: ${dropped.slice(0, 6).join(", ")}`);
  if (kept.length > MAX_SPRITE_PARTS) {
    notes.push(`kept the first ${MAX_SPRITE_PARTS} of ${kept.length} parts`);
    kept.length = MAX_SPRITE_PARTS;
  }

  // size
  let size = draft.size ?? "medium";
  const body = draft.body;
  let i = sizeIdx(size);
  if (role === "minion") i = Math.min(i, sizeIdx("medium"));
  if (role === "boss") i = Math.max(i, sizeIdx("medium"));
  if (role === "pc" || role === "npc" || ["merchant", "quest_giver", "ally", "bystander", "villain"].includes(role)) i = Math.min(i, sizeIdx("large"));
  if (body === "humanoid" && role !== "boss") i = Math.min(i, sizeIdx("large"));
  if (body === "humanoid") i = Math.max(i, sizeIdx("small"));
  const clamped = SPRITE_SIZES[i] as SpriteSize;
  if (clamped !== size) { notes.push(`size ${size} changed to ${clamped} for ${role || "this"} ${body}`); size = clamped; }

  // pose
  const mood = (ctx.mood ?? "").toLowerCase();
  const pose: SpritePose = draft.pose ?? (
    /\b(afraid|scared|frightened|cowering|timid|fearful)\b/.test(mood) ? "cowering"
      : body === "spirit" ? "floating"
        : role === "minion" || role === "standard" || role === "elite" || role === "boss" || /\b(hostile|angry|aggressive)\b/.test(mood) ? "aggressive"
          : "idle"
  );

  const glyph = draft.glyph?.trim() || glyphFromName(ctx.name ?? "");
  const traits = cleanTraits(draft.traits ?? "", notes);

  const spec: SpriteSpec = {
    kind: "spec", v: 1, body, size, glyph, pose, traits,
    palette: { primary, secondary, accent, detail },
    parts: kept.map((k) => ({ part: k.part, ...(k.color ? { color: k.color } : {}), ...(k.side ? { side: k.side } : {}) })),
    ...(draft.image_asset_id ? { image_asset_id: draft.image_asset_id } : {}),
  };
  return { spec: SpriteSpecSchema.parse(spec), notes };
}

// ---------- offline designer ----------

export type SpriteKind = "npc" | "enemy" | "pc" | "prop";

export interface SpriteDesignInput {
  concept: string;
  appearance?: string | undefined;
  name: string;
  role: string;
  kind: SpriteKind;
}

type Rule = readonly [pattern: RegExp, parts: readonly Part[]];
const w = (stems: string): RegExp => new RegExp(`\\b(?:${stems})(?:s|es)?\\b`, "i");

/** Body plan keyword table. The earliest match in the text wins; "humanoid" words anchor people so "a hunter in a wolf pelt" stays a person. */
export const BODY_KEYWORDS: Record<BodyPlan, RegExp> = {
  beast: w("wolf|wolves|bear|hound|dog|cat|lion|boar|fox|rat|stag|deer|panther|tiger|ox|goat|badger|jackal|hyena|beast|pup|mastiff|rodent|mouse|bull"),
  avian: w("bird|harpy|bat|crow|raven|owl|hawk|eagle|vulture|gull|heron|griffin|wyvern|falcon|sparrow|swan"),
  serpent: w("snake|eel|wyrm|serpent|worm|viper|naga|leech|lamprey|hydra|basilisk|cobra|python"),
  insectoid: w("spider|beetle|ant|wasp|scorpion|mantis|crab|centipede|moth|fl(?:y|ies)|insect|roach|tick|locust|bug|hornet"),
  amorphous: w("slime|ooze|jelly|blob|pudding|sludge|mire-thing|gloop|goo|mold"),
  construct: w("golem|automaton|clockwork|construct|robot|juggernaut|mechanical|animated armor|gargoyle|sentinel"),
  spirit: w("ghost|wraith|spirit|specter|spectre|phantom|shade|banshee|poltergeist|haunt|wisp|choir|apparition|voices"),
  plant: w("treant|vine|fungus|fungal|mushroom|thorn|bramble|moss-?thing|briar|tree|flower|spore|ent|shambler"),
  object: w("statue|chest|totem|mimic|lantern|barrel|idol|bell|mirror|crate|coffin|altar|obelisk|signpost|cart"),
  humanoid: w("man|woman|knight|cultist|priest|priestess|mage|wizard|witch|guard|merchant|thief|bandit|archer|soldier|child|elf|dwarf|orc|goblin|sailor|farmer|smith|blacksmith|ranger|monk|noble|king|queen|lord|lady|warrior|druid|bard|hermit|ghoul|zombie|skeleton|undead|villager|innkeeper|ferryman|captain|hunter|scout|rogue|assassin|pirate|ogre|troll|lich|necromancer|vampire|cleric|acolyte|zealot|paladin|shaman|sorcerer|warlock|sage|oracle|fisher|fisherman|keeper|girl|boy|figure|person|human|gnome|halfling"),
};
const BODY_ORDER = ["humanoid", "beast", "avian", "serpent", "insectoid", "amorphous", "construct", "spirit", "plant", "object"] as const satisfies readonly BodyPlan[];

/** Parts keyword table. Order is importance: the finalizer keeps the first six after removing contradictions. */
export const PART_RULES: readonly Rule[] = [
  // identities
  [w("cultist|acolyte|zealot"), ["hood", "robe"]],
  [w("knight|paladin|crusader|templar"), ["helmet", "armor", "sword", "shield"]],
  [w("guard|soldier|legionary|watchman|sentry"), ["helmet", "armor", "spear"]],
  [w("warrior|barbarian|gladiator|champion"), ["armor", "axe"]],
  [w("orc"), ["armor", "axe"]],
  [w("goblin"), ["ears_pointed"]],
  [w("ogre|troll"), ["tool"]],
  [w("archer|ranger|hunter|scout"), ["bow", "cloak"]],
  [w("priest|priestess|cleric|monk|friar|nun|oracle|chorister"), ["robe", "book"]],
  [w("holy|divine|saint|angel|blessed|radiant"), ["halo"]],
  [w("wizard|mage|sorcerer|sorceress|warlock|sage|enchanter|witch"), ["hat", "robe", "staff"]],
  [w("lich|necromancer"), ["robe", "hood", "staff"]],
  [w("thief|rogue|assassin|bandit|pirate|smuggler"), ["cloak", "mask"]],
  [w("king|queen|lord|lady|noble|duke|duchess|baron|prince|princess|emperor|empress"), ["crown", "cloak"]],
  [w("druid"), ["staff", "leaves"]],
  [w("shaman"), ["antlers", "staff"]],
  [w("smith|blacksmith|engineer|tinker|mechanic|farmer|miner|carpenter|mason"), ["tool"]],
  [w("merchant|trader|peddler|vendor|shopkeeper"), ["hat", "cloak"]],
  [w("ferryman|lamplighter|lantern-bearer|keeper"), ["lantern"]],
  [w("bard|minstrel|jester"), ["hat", "cloak"]],
  [w("hermit|elder|ancient|old man|old woman"), ["beard", "staff"]],
  [w("skeleton|zombie|ghoul|undead|revenant|wight|vampire"), ["glowing_eyes"]],
  // looks
  [w("robed|robe|cassock|vestment"), ["robe"]],
  [w("hooded|hood|cowl"), ["hood"]],
  [w("cloaked|cloak|cape|mantle"), ["cloak"]],
  [w("helmeted|helmet|helm"), ["helmet"]],
  [w("armored|armoured|armor|armour|plate|chainmail"), ["armor"]],
  [w("crowned|crown|circlet|diadem"), ["crown"]],
  [w("masked|mask"), ["mask"]],
  [w("wizard hat|pointed hat|hat|wide-brimmed"), ["hat"]],
  [w("horned|horns?|demon|devil|minotaur|ram"), ["horns"]],
  [w("antlered|antlers?"), ["antlers"]],
  [w("bearded|beard|dwarf"), ["beard"]],
  [w("elf|elven|fey|sylph|eared"), ["ears_pointed"]],
  [w("long hair|flowing hair|long-haired"), ["long_hair"]],
  // held
  [w("sword|blade|saber|sabre|rapier|scimitar|dagger|knife|cutlass"), ["sword"]],
  [w("axe|hatchet|cleaver"), ["axe"]],
  [w("spear|pike|lance|trident|harpoon|halberd"), ["spear"]],
  [w("bow|crossbow|longbow"), ["bow"]],
  [w("staff|cane|crook"), ["staff"]],
  [w("wand"), ["wand"]],
  [w("shield|buckler"), ["shield"]],
  [w("lantern|lamp|torch"), ["lantern"]],
  [w("book|tome|grimoire|scroll"), ["book"]],
  [w("hammer|pickaxe|shovel|wrench|saw|tool"), ["tool"]],
  [w("orb|sphere|globe|crystal ball"), ["orb"]],
  // body features
  [w("winged|wings?|feathered"), ["wings"]],
  [w("tail|tailed"), ["tail"]],
  [w("spiked|spikes?|spines?|thorns?|thorny"), ["spikes"]],
  [w("tentacled|tentacles?"), ["tentacles"]],
  [w("finned|fins?|gilled"), ["fins"]],
  [w("scaled|scales?|scaly"), ["scales"]],
  [w("furry|fur|pelt|shaggy|furred"), ["fur"]],
  [w("shelled|shell|carapace|chitin"), ["shell"]],
  [w("mane"), ["mane"]],
  [w("rooted|roots?"), ["roots"]],
  [w("leafy|leaves|foliage|moss|mossy"), ["leaves"]],
  [w("gears?|cogs?|clockwork|brass|cogwork"), ["gears"]],
  [w("crystal|crystalline|gem|gemstone"), ["crystals"]],
  // eyes and auras
  [w("glowing|glows?|luminous|bioluminescent|burning eyes|ember-eyed|lantern-eyed"), ["glowing_eyes"]],
  [w("many-eyed|many eyes|multiple eyes|extra eyes|eyestalks?|three eyes"), ["extra_eyes"]],
  [w("drowned|dripping|waterlogged|sodden|soaked|dripped|wet|sunken"), ["drips"]],
  [w("fire|fiery|flames?|flaming|burning|ember|embers|molten|infernal|blazing"), ["flames"]],
  [w("smoke|smoky|smoldering|smouldering|ash|ashen|fog|mist|misty|shroud|shrouded"), ["smoke"]],
  [w("sparkles?|glitter|glittering|shimmering|stardust|starlit"), ["sparkles"]],
  [w("aura|eldritch|arcane|spectral|ethereal|haunting|cursed|uncanny"), ["aura"]],
];

/** Parts added when the text gave fewer than two. */
const BODY_DEFAULT_PARTS: Record<BodyPlan, readonly Part[]> = {
  humanoid: ["cloak"], beast: ["fur", "tail"], avian: ["wings", "tail"], serpent: ["scales", "tail"], insectoid: ["shell", "extra_eyes"],
  amorphous: ["drips", "extra_eyes"], construct: ["gears", "glowing_eyes"], spirit: ["aura", "glowing_eyes"], plant: ["leaves", "roots"], object: ["crystals"],
};

interface PaletteRule { pattern: RegExp; primary: RampName; secondary: RampName; accent: RampName }
/** Mood word to ramps. First match wins. */
export const PALETTE_RULES: readonly PaletteRule[] = [
  { pattern: w("drowned|sea|ocean|water|river|tide|coral|sunken|kelp|lake|rain|frost|frozen|ice|icy|cold|marsh|siren|mermaid"), primary: "water", secondary: "stone", accent: "water" },
  { pattern: w("fire|fiery|flame|flames|burning|ember|embers|molten|lava|infernal|demon|devil|forge|blazing|pyre"), primary: "fire", secondary: "stone", accent: "sand" },
  { pattern: w("undead|skeleton|ghost|wraith|spirit|specter|spectre|lich|necromancer|haunted|cursed|choir|grave|crypt|zombie|banshee|phantom|shade|revenant|vampire"), primary: "stone", secondary: "magic", accent: "magic" },
  { pattern: w("nature|forest|vine|moss|mossy|fungus|fungal|treant|druid|swamp|bog|leaf|leafy|ranger|herb|grove|bramble|thorn|woodland|wild|beast|wolf"), primary: "grass", secondary: "earth", accent: "sand" },
  { pattern: w("desert|sand|dust|sun|golden|gold|scorched|dune"), primary: "sand", secondary: "earth", accent: "fire" },
  { pattern: w("arcane|magic|magical|wizard|mage|witch|sorcerer|fey|star|starlit|eldritch|oracle|moon|mystic|enchanted"), primary: "magic", secondary: "stone", accent: "sand" },
  { pattern: w("stone|statue|golem|iron|steel|clockwork|armor|armored|knight|guard|soldier|construct"), primary: "stone", secondary: "earth", accent: "sand" },
];

const TINY_WORDS = w("tiny|minuscule|imp|sprite|pixie|familiar|fairy|mouse|bug|rat|wisp");
const SMALL_WORDS = w("small|little|young|child|kid|gnome|halfling|goblin|pup|cub|runt|scrawny");
const BIG_WORDS = w("large|big|hulking|massive|ogre|troll|minotaur|bear|golem|treant|brute|towering");
const HUGE_WORDS = w("huge|giant|colossal|titan|dragon|behemoth|kraken|leviathan|gargantuan|immense|ancient wyrm");

/** Earliest body-plan keyword in the text, or "humanoid". Exposed for tests. */
export function bodyFromText(text: string): BodyPlan {
  let best: BodyPlan = "humanoid";
  let bestAt = Infinity;
  for (const plan of BODY_ORDER) {
    const m = BODY_KEYWORDS[plan].exec(text);
    if (m && m.index < bestAt) { bestAt = m.index; best = plan; }
  }
  return best;
}

function textHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function sizeFor(text: string, role: string, kind: SpriteKind, body: BodyPlan): SpriteSize {
  let i = sizeIdx(role === "minion" ? "small" : role === "boss" ? "large" : "medium");
  if (kind === "prop") i = sizeIdx("small");
  if (TINY_WORDS.test(text)) i -= 1;
  if (SMALL_WORDS.test(text)) i -= 1;
  if (BIG_WORDS.test(text)) i += 1;
  if (HUGE_WORDS.test(text)) i += 2;
  if (body === "amorphous" && role === "boss") i += 1;
  return SPRITE_SIZES[Math.min(SPRITE_SIZES.length - 1, Math.max(0, i))] as SpriteSize;
}

function paletteFor(text: string, role: string, kind: SpriteKind, rng: Rng): SpriteSpecDraft["palette"] {
  const hostile = kind === "enemy" || role === "villain";
  const rule = PALETTE_RULES.find((r) => r.pattern.test(text));
  let primary: RampName, secondary: RampName, accent: RampName;
  if (rule) ({ primary, secondary, accent } = rule);
  else if (hostile) {
    primary = rng.pick(["fire", "magic", "stone", "earth"] as const);
    secondary = "stone";
    accent = rng.pick(["fire", "magic"] as const);
  } else {
    primary = rng.pick(["earth", "grass", "water", "sand", "earth"] as const);
    secondary = "earth";
    accent = rng.pick(["sand", "skin", "sand"] as const);
  }
  if (secondary === primary) secondary = primary === "stone" ? "earth" : "stone";
  // allies and neutrals sit lighter and warmer, enemies darker with a bright accent
  const pStep = hostile ? rng.int(0, 1) + 1 : rng.int(1, 2);
  const sStep = hostile ? 0 : rng.int(0, 1);
  const aStep = accent === primary ? 3 : hostile ? 3 : rng.int(2, 3);
  return {
    primary: PALETTE[primary][pStep] as string,
    secondary: PALETTE[secondary][sStep] as string,
    accent: PALETTE[accent][aStep] as string,
    detail: OUTLINE_HEX,
  };
}

/**
 * Deterministic keyword designer. Same input and seed always give the same spec; always returns a valid one.
 * Body plan: the earliest `BODY_KEYWORDS` match in name + concept + appearance (default humanoid).
 * Parts: every matching `PART_RULES` row in table order (identity, looks, held, body, eyes and auras), then the finalizer's caps.
 * Palette: first `PALETTE_RULES` mood match, else enemy (fire/magic/stone/earth) or friendlier (earth/grass/water/sand).
 * Size: role (minion small, boss large), then tiny/small/big/huge words, clamped by the finalizer.
 */
export function designSpriteOffline(input: SpriteDesignInput, seed: number): SpriteSpec {
  const text = `${input.name} ${input.concept} ${input.appearance ?? ""}`.toLowerCase().replace(/\s+/g, " ");
  const rng = createRng((seed | 0) ^ textHash(text));
  const role = input.kind === "pc" ? "pc" : input.role.toLowerCase();
  const body = bodyFromText(text);

  const parts: SpriteSpecDraft["parts"] = [];
  const seen = new Set<Part>();
  const add = (p: Part) => { if (!seen.has(p)) { seen.add(p); parts.push({ part: p }); } };
  for (const [pat, ps] of PART_RULES) if (pat.test(text)) for (const p of ps) add(p);
  if (parts.length < 2) for (const p of BODY_DEFAULT_PARTS[body]) add(p);

  const colored = parts.map((p, i) => ({ ...p, color: (["primary", "secondary", "accent", "secondary", "detail", "accent"] as const)[i % 6] as PartColor }));
  // accent coloring for glow/aura parts, primary for the main garment
  for (const p of colored) {
    if (["glowing_eyes", "flames", "sparkles", "aura", "drips", "halo"].includes(p.part)) p.color = "accent";
    else if (["robe", "armor", "fur", "scales", "shell", "leaves", "gears"].includes(p.part)) p.color = "primary";
  }

  const draft: SpriteSpecDraft = {
    kind: "spec", v: 1, body,
    size: sizeFor(text, role, input.kind, body),
    palette: paletteFor(text, role, input.kind, rng),
    parts: colored,
    traits: cleanTraits(`${input.appearance?.trim() || input.concept}`),
  };
  const { spec } = finalizeSpriteSpec(draft, { role, name: input.name, mood: input.kind === "enemy" ? "hostile" : "" });
  return spec;
}

/**
 * Seed for engine call sites that have an Rng. Draws three values (what the old random shape picker drew), so the
 * rng stream, and with it every existing replay and test that follows a spawn, is unchanged.
 */
export function spriteSeed(rng: Rng): number {
  return (rng.int(0, 0x7fffff) * 31 + rng.int(0, 0x7fffff) * 17 + rng.int(0, 0x7fffff)) | 0;
}
