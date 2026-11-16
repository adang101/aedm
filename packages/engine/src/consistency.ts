/**
 * Story versus map: does a narration name places and objects that exist?
 *
 * A measure, not a rule. It reads text for the place and object nouns of `data/place-words.json` and sorts each mention:
 * on the current map, elsewhere in the campaign plan, or nowhere. A lexicon cannot catch a paraphrase ("the crumbling
 * sanctuary"), so the count of invented things is a lower bound. Pure and deterministic.
 */
import placeWordsJson from "../data/place-words.json" with { type: "json" };
import { getObjects, mapLandmarks } from "./map/index.ts";
import type { GameState } from "./state.ts";

interface PlaceWords {
  version: number;
  /** A negation this many words or fewer before a mention, in the same sentence, cancels it. */
  negationWindow: number;
  /** Shorter words of a name ("of", "at") are not kept as known things. */
  minKnownWord: number;
  negations: string[];
  determiners: string[];
  /** Words with a common other meaning ("as well", "to sign"): a mention only right after a determiner. */
  ambiguous: string[];
  /** Canonical noun to the words that mean it. Only the listed words match, so a noun can be a label ("wall" for "rampart"). */
  nouns: Record<string, string[]>;
}

const W = placeWordsJson as PlaceWords;

/** "inns" to "inn", "churches" to "church"; leaves "moss" and short words alone. */
export function singular(word: string): string {
  if (word.length > 4 && /(ch|sh|ss|x)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [];

const CANON = new Map<string, string>();
for (const [noun, list] of Object.entries(W.nouns)) for (const w of list) if (!CANON.has(singular(w))) CANON.set(singular(w), noun);
const NEGATIONS = new Set(W.negations);
const DETERMINERS = new Set(W.determiners);
const AMBIGUOUS = new Set(W.ambiguous);

/** The canonical nouns a set of words covers. */
function canonical(words: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const w of words) {
    const noun = CANON.get(w);
    if (noun) out.add(noun);
  }
  return out;
}

/** Words of names that exist: on the current map, and elsewhere in the plan. Lower case, singular. */
export interface KnownThings {
  map: Set<string>;
  plan: Set<string>;
}

function addWords(set: Set<string>, text: string | undefined): void {
  if (!text) return;
  for (const t of tokens(text)) if (t.length >= W.minKnownWord) set.add(singular(t));
}

/**
 * What exists to be named. On the map: its setting, landmarks (name and keywords), interactables by kind, exits and the
 * creatures standing on it. In the plan: every location, its features, the cast, the encounters and the key items.
 */
export function knownThings(state: GameState, mapId: string): KnownThings {
  const known: KnownThings = { map: new Set(), plan: new Set() };
  const map = state.maps[mapId];
  if (map) {
    addWords(known.map, map.meta.setting.name);
    for (const l of mapLandmarks(map)) {
      addWords(known.map, l.name);
      for (const k of l.keywords) addWords(known.map, k);
    }
    for (const o of getObjects(map)) {
      if (o.type === "interactable") addWords(known.map, o.kind);
      else if (o.type === "exit") addWords(known.map, o.name);
    }
    for (const e of Object.values(state.entities)) if (e.mapId === mapId) addWords(known.map, e.name);
  }
  const bible = state.bible;
  for (const l of bible.locations ?? []) {
    addWords(known.plan, l.name);
    addWords(known.plan, l.setting.name);
    for (const f of l.features ?? []) addWords(known.plan, f);
  }
  for (const c of bible.cast ?? []) addWords(known.plan, c.name);
  for (const e of bible.encounters ?? []) addWords(known.plan, e.name);
  for (const i of bible.key_items ?? []) addWords(known.plan, i.name);
  return known;
}

export interface Mention {
  /** The canonical noun, for example "tavern" for "inns". */
  noun: string;
  /** The word as written, lower case. */
  word: string;
  sentence: string;
  /** Where the thing exists: on this map, elsewhere in the plan, or nowhere. */
  grounded: "map" | "plan" | "none";
}

export interface ConsistencyScore {
  mentions: Mention[];
  /** The mentions that exist nowhere: the invented places and objects. */
  ungrounded: Mention[];
  /** Mentions that exist on the map or in the plan, over all mentions; 1 when the text names nothing. */
  groundedRate: number;
}

/** Scores text against a known set. */
export function scoreText(text: string, known: KnownThings): ConsistencyScore {
  const onMap = canonical(known.map);
  const inPlan = canonical(known.plan);
  const mentions: Mention[] = [];
  for (const raw of text.match(/[^.!?\n]+[.!?]*/g) ?? []) {
    const sentence = raw.trim();
    const toks = tokens(sentence);
    toks.forEach((word, i) => {
      const noun = CANON.get(singular(word));
      if (!noun) return;
      if (AMBIGUOUS.has(singular(word)) && !DETERMINERS.has(toks[i - 1] ?? "")) return;
      if (toks.slice(Math.max(0, i - W.negationWindow), i).some((t) => NEGATIONS.has(t))) return;
      mentions.push({ noun, word, sentence, grounded: onMap.has(noun) ? "map" : inPlan.has(noun) ? "plan" : "none" });
    });
  }
  const ungrounded = mentions.filter((m) => m.grounded === "none");
  return { mentions, ungrounded, groundedRate: mentions.length === 0 ? 1 : (mentions.length - ungrounded.length) / mentions.length };
}

/** Scores what the players read in one beat against the map the party stands on and the plan. */
export function scoreNarration(state: GameState, mapId: string, text: string): ConsistencyScore {
  return scoreText(text, knownThings(state, mapId));
}
