import { describe, expect, it } from "vitest";
import { AbilitySchema, EnemySchema, ENEMY_ROLES, type Enemy, type EnemyRole } from "@aedm/schemas";
import { buildEnemyOffline, enemyNameFromConcept, enemyNameFromRef } from "./enemy-builder.ts";
import { ENEMY_DATA, ENEMY_KITS, RULES } from "./data.ts";
import { enemyRangesForLevel, validateEnemy } from "./threat.ts";
import { abilityCost } from "./cost.ts";
import { registerArchetype } from "./state.ts";
import { makeWorld } from "./testkit.ts";

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const CONCEPTS = [
  "", "   ", "!!!???...", "A", "\u0000\u0001\u0002", "```json {\"v\":1}```",
  "A wolf that hunts in packs", "an armored stone golem guarding the vault", "swift bat swarm", "ogre brute with a club",
  "goblin sneak thief", "skeleton archer", "cultist who sings with the voice of the drowned", "ember-skinned fire imp",
  "frost wraith of the glacier", "venomous spider", "storm-touched sentinel", "radiant angelic knight", "shaman healer of the marsh",
  "bodyguard knight, loyal to the baron", "mindless ooze", "bandit assassin in the rafters", "zombie", "Das Wesen aus dem dunklen Wald",
  "狼の群れ", "الغول المتوحش", "🐺🔥💀", "Robert'); DROP TABLE enemies;--",
  "<script>alert(1)</script> goblin", "a ".repeat(500), "wolf ".repeat(300), "x".repeat(5000),
  "THE LOUD ARCHER (WHO SHOUTS), WITH A HORN; AND A DOG!", "...and then, the hound.", "a - b - c - d - e - f", "a\nb\r\nc\td",
];

const behaviorText = (e: Enemy) => e.behavior.join(" ");
const matches = (pattern: string, text: string) => new RegExp(pattern, "i").test(text);
const ranged = (e: Enemy) => matches(RULES.ai.rangedPattern, behaviorText(e));
const tactic = (e: Enemy, t: keyof typeof RULES.ai.tactics) => matches(RULES.ai.tactics[t], behaviorText(e));

const build = (concept: string, role: EnemyRole = "standard", level = 3, seed = 1, extra: { ref?: string; settingNotes?: string } = {}) =>
  buildEnemyOffline({ concept, role, partyLevel: level, seed, ...extra });

describe("buildEnemyOffline: determinism", () => {
  it("same input gives the same enemy and notes", () => {
    const a = build("ogre brute with a club", "elite", 5, 42, { ref: "en_cave_ogre" });
    const b = build("ogre brute with a club", "elite", 5, 42, { ref: "en_cave_ogre" });
    expect(b).toEqual(a);
  });
  it("different concepts with the same seed differ", () => {
    let differing = 0;
    for (let seed = 0; seed < 10; seed++) {
      const a = build("a quiet thing", "standard", 9, seed).enemy;
      const b = build("a loud thing", "standard", 9, seed).enemy;
      if (JSON.stringify([a.stats, a.behavior]) !== JSON.stringify([b.stats, b.behavior])) differing++;
    }
    expect(differing).toBeGreaterThan(5);
  });
  it("different seeds vary the stats over a handful of seeds", () => {
    const hps = new Set<number>();
    for (let s = 0; s < 12; s++) hps.add(build("plain thing", "standard", 8, s).enemy.stats.hp);
    expect(hps.size).toBeGreaterThan(1);
  });
});

describe("buildEnemyOffline: always valid", () => {
  it("passes validateEnemy and the schema for every role, level and concept", () => {
    for (const role of ENEMY_ROLES) {
      for (const level of LEVELS) {
        CONCEPTS.forEach((concept, i) => {
          const { enemy } = build(concept, role, level, i * 31 + level);
          const v = validateEnemy(enemy, level);
          expect(v.errors, `${role} L${level} "${concept.slice(0, 30)}"`).toEqual([]);
          const parsed = EnemySchema.safeParse(enemy);
          expect(parsed.success, `${role} L${level} "${concept.slice(0, 30)}" ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
          expect(enemy.threat).toBeTypeOf("number");
        });
      }
    }
  });
  it("keeps the requested role for every level", () => {
    for (const role of ENEMY_ROLES) for (const level of LEVELS) expect(build("an armored golem", role, level).enemy.role).toBe(role);
  });
  it("handles out-of-range party levels without throwing", () => {
    for (const level of [0, -3, 11, 99, 2.5]) expect(() => build("wolf", "standard", level)).not.toThrow();
  });
  it("every ability costs within the level caps (validateEnemy checks them) and has a computed cost", () => {
    const { enemy } = build("fire cultist with a torch", "boss", 6, 3);
    for (const a of enemy.abilities) {
      expect(a.cost).toBe(abilityCost(a));
      expect(AbilitySchema.safeParse(a).success).toBe(true);
    }
  });
  it("keeps damage-dealing abilities off cooldown 0 so damage per round stays in range", () => {
    for (const t of ENEMY_KITS.themes) for (const tpl of [...t.templates, ENEMY_KITS.abilities.fallback]) expect(tpl.cooldown_turns ?? 1).toBeGreaterThanOrEqual(1);
  });
});

describe("buildEnemyOffline: names", () => {
  it("title-cases the ref without its en_ prefix", () => {
    expect(build("anything", "standard", 1, 1, { ref: "en_robed_chorister" }).enemy.name).toBe("Robed Chorister");
    expect(enemyNameFromRef("en_ROBED-chorister")).toBe("Robed Chorister");
    expect(enemyNameFromRef("en_")).toBeUndefined();
    expect(enemyNameFromRef("en_" + "wolf_".repeat(30))!.length).toBeLessThanOrEqual(ENEMY_KITS.name.maxLength);
  });
  it("takes the head of the concept", () => {
    expect(enemyNameFromConcept("A cultist who borrows the voices of the drowned", "standard")).toBe("Cultist");
    expect(enemyNameFromConcept("the armored stone golem guarding the vault", "standard")).toBe("Armored Stone Golem");
    expect(enemyNameFromConcept("goblin sneak, quick with a knife", "minion")).toBe("Goblin Sneak");
    expect(enemyNameFromConcept("keeper of", "standard")).toBe("Keeper");
    expect(build("a hungry wolf that hunts alone", "standard", 1).enemy.name).toBe("Hungry Wolf");
  });
  it("falls back to a role default for empty or symbol-only concepts", () => {
    for (const role of ENEMY_ROLES) {
      expect(enemyNameFromConcept("", role)).toBe(ENEMY_KITS.name.defaults[role]);
      expect(enemyNameFromConcept("!!! ???", role)).toBe(ENEMY_KITS.name.defaults[role]);
    }
  });
  it("never exceeds the schema length", () => {
    expect(build("x".repeat(5000)).enemy.name.length).toBeLessThanOrEqual(40);
    expect(build("a ".repeat(500)).enemy.concept.length).toBeLessThanOrEqual(200);
  });
  it("carries the concept, trimmed", () => {
    expect(build("  a wolf  ").enemy.concept).toBe("a wolf");
    expect(build("").enemy.concept.length).toBeGreaterThan(0);
  });
});

describe("buildEnemyOffline: stats and traits", () => {
  const avg = (concept: string, role: EnemyRole, level: number, pick: (e: Enemy) => number) => {
    let sum = 0;
    const n = 30;
    for (let s = 0; s < n; s++) sum += pick(build(concept, role, level, s).enemy);
    return sum / n;
  };
  const dmg = (e: Enemy) => {
    const m = /^(\d)d(\d+)$/.exec(e.stats.damage_dice)!;
    return Number(m[1]) * (Number(m[2]) + 1) / 2;
  };
  it("armored concepts get more hp and defense and less speed", () => {
    expect(avg("armored stone golem", "standard", 8, (e) => e.stats.hp)).toBeGreaterThan(avg("plain thing", "standard", 8, (e) => e.stats.hp));
    expect(avg("armored stone golem", "standard", 8, (e) => e.stats.defense)).toBeGreaterThan(avg("plain thing", "standard", 8, (e) => e.stats.defense));
    expect(avg("armored stone golem", "standard", 8, (e) => e.stats.speed)).toBeLessThan(avg("plain thing", "standard", 8, (e) => e.stats.speed));
  });
  it("swift concepts get more speed and less hp", () => {
    expect(avg("swift nimble thing", "standard", 8, (e) => e.stats.speed)).toBeGreaterThan(avg("plain thing", "standard", 8, (e) => e.stats.speed));
    expect(avg("swift nimble thing", "standard", 8, (e) => e.stats.hp)).toBeLessThan(avg("plain thing", "standard", 8, (e) => e.stats.hp));
  });
  it("brutes hit harder and attack worse", () => {
    expect(avg("hulking brute", "standard", 8, dmg)).toBeGreaterThan(avg("plain thing", "standard", 8, dmg));
    expect(avg("hulking brute", "standard", 8, (e) => e.stats.attack_bonus)).toBeLessThan(avg("plain thing", "standard", 8, (e) => e.stats.attack_bonus));
  });
  it("stays inside the level ranges and the speed range, even with stacked traits", () => {
    for (const role of ENEMY_ROLES) for (const level of LEVELS) {
      for (const concept of ["armored stone golem brute giant", "swift quick wolf bat frail", "plain"]) {
        const { enemy } = build(concept, role, level, 5);
        const rg = enemyRangesForLevel(level, role);
        expect(enemy.stats.hp).toBeGreaterThanOrEqual(rg.hp.min);
        expect(enemy.stats.hp).toBeLessThanOrEqual(rg.hp.max);
        expect(enemy.stats.speed).toBeGreaterThanOrEqual(ENEMY_DATA.speedRange.min);
        expect(enemy.stats.speed).toBeLessThanOrEqual(ENEMY_DATA.speedRange.max);
      }
    }
  });
  it("a plain concept starts near the middle of the range", () => {
    const rg = enemyRangesForLevel(10, "standard");
    const mid = (rg.hp.min + rg.hp.max) / 2;
    expect(Math.abs(avg("plain", "standard", 10, (e) => e.stats.hp) - mid)).toBeLessThan((rg.hp.max - rg.hp.min) * 0.2);
  });
});

describe("buildEnemyOffline: behavior drives the combat AI", () => {
  const families: { id: string; concepts: string[]; want: (keyof typeof RULES.ai.tactics)[]; ranged?: boolean }[] = [
    { id: "ranged", concepts: ["archer", "cultist caster", "acid spitter", "slinger", "chorister singer"], want: [], ranged: true },
    { id: "pack", concepts: ["wolf", "giant rat", "swarm of gnats", "pack of dogs"], want: ["pack"] },
    { id: "fearless", concepts: ["zombie", "skeleton", "clockwork construct", "stone golem", "grey ooze", "mindless husk"], want: ["fearless"] },
    { id: "cowardly", concepts: ["goblin", "bandit", "thief", "sneak"], want: ["cowardly"] },
    { id: "guard", concepts: ["guard", "bodyguard", "knight", "sentinel"], want: ["protect_leader"] },
    { id: "hunter", concepts: ["assassin", "stalker"], want: ["focus_weakest"] },
  ];
  it.each(families)("$id concepts match the intended pattern", ({ concepts, want, ranged: wantRanged }) => {
    for (const concept of concepts) {
      for (const role of ENEMY_ROLES) {
        for (const seed of [1, 2, 3, 4, 5, 6]) {
          const e = build(concept, role, 4, seed).enemy;
          for (const t of want) expect(tactic(e, t), `${concept}/${role}/${seed}: ${behaviorText(e)}`).toBe(true);
          if (wantRanged) expect(ranged(e), `${concept}: ${behaviorText(e)}`).toBe(true);
        }
      }
    }
  });
  it("does not trigger tactics a concept did not ask for", () => {
    for (const concept of ["wolf", "skeleton", "goblin", "knight", "assassin", "plain thing", ""]) {
      for (const seed of [1, 2, 3]) {
        const e = build(concept, "standard", 4, seed).enemy;
        const all = Object.keys(RULES.ai.tactics) as (keyof typeof RULES.ai.tactics)[];
        const fam = families.find((f) => f.concepts.includes(concept));
        for (const t of all) if (!fam?.want.includes(t)) {
          // Wolves, goblins and the like may trigger exactly their own family only.
          if (concept === "wolf" && t === "pack") continue;
          expect(tactic(e, t), `${concept} should not match ${t}: ${behaviorText(e)}`).toBe(false);
        }
        if (!fam?.ranged) expect(ranged(e), `${concept}: ${behaviorText(e)}`).toBe(false);
      }
    }
  });
  it("never produces both fearless and cowardly, even for conflicting concepts", () => {
    for (const concept of ["skeletal goblin thief", "zombie bandit", "mindless cowardly sneak", "goblin golem"]) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const e = build(concept, "elite", 4, seed).enemy;
        expect(tactic(e, "fearless") && tactic(e, "cowardly"), behaviorText(e)).toBe(false);
      }
    }
  });
  it("keeps 2 to 3 lines of at most 80 characters, for any concept", () => {
    for (const concept of CONCEPTS) for (const role of ENEMY_ROLES) {
      const e = build(concept, role, 2, 9).enemy;
      expect(e.behavior.length).toBeGreaterThanOrEqual(2);
      expect(e.behavior.length).toBeLessThanOrEqual(3);
      for (const l of e.behavior) expect(l.length).toBeLessThanOrEqual(80);
    }
  });
  it("data sentences: every filler is tactic-free; every family line matches its own tactic", () => {
    const all = Object.entries(RULES.ai.tactics);
    for (const role of ENEMY_ROLES) for (const line of ENEMY_KITS.behavior.fillers[role]) {
      expect(matches(RULES.ai.rangedPattern, line), line).toBe(false);
      for (const [id, p] of all) expect(matches(p, line), `${line} vs ${id}`).toBe(false);
    }
    for (const fam of ENEMY_KITS.behavior.families) for (const v of fam.variants) {
      const first = v[0]!;
      expect(matches(fam.tactic === "ranged" ? RULES.ai.rangedPattern : RULES.ai.tactics[fam.tactic], first), first).toBe(true);
      for (const line of v) expect(line.length).toBeLessThanOrEqual(80);
      // second lines must not trigger anything the family did not intend (above all: not fearless and cowardly together)
      for (const line of v.slice(1)) for (const [id, p] of all) if (id !== fam.tactic) expect(matches(p, line), `${line} vs ${id}`).toBe(false);
    }
  });
});

describe("buildEnemyOffline: abilities", () => {
  it("respects each role's ability limits", () => {
    for (const role of ENEMY_ROLES) for (const level of LEVELS) for (const concept of CONCEPTS.slice(0, 20)) {
      const { enemy } = build(concept, role, level, 3);
      const r = ENEMY_DATA.roles[role];
      expect(enemy.abilities.length).toBeGreaterThanOrEqual(r.abilitiesMin);
      expect(enemy.abilities.length).toBeLessThanOrEqual(r.abilitiesMax);
    }
  });
  it("minions have none; elites and bosses have at least one; names within an enemy are unique", () => {
    expect(build("wolf", "minion").enemy.abilities).toHaveLength(0);
    expect(build("wolf", "elite").enemy.abilities.length).toBeGreaterThanOrEqual(1);
    const boss = build("fire cultist", "boss", 7).enemy;
    expect(boss.abilities.length).toBeGreaterThanOrEqual(1);
    expect(new Set(boss.abilities.map((a) => a.name)).size).toBe(boss.abilities.length);
  });
  const themeOf = (concept: string, settingNotes?: string) => build(concept, "boss", 5, 4, settingNotes ? { settingNotes } : {}).enemy;
  it("picks the theme from concept keywords", () => {
    const damageTypes = (e: Enemy) => e.abilities.flatMap((a) => a.effects.flatMap((f) => (f.type === "damage" ? [f.damage_type] : [])));
    expect(damageTypes(themeOf("fire imp with burning hands")).every((d) => d === "fire")).toBe(true);
    expect(damageTypes(themeOf("frost wraith of the glacier")).every((d) => d === "cold")).toBe(true);
    expect(damageTypes(themeOf("venomous spider")).every((d) => d === "acid")).toBe(true);
    expect(damageTypes(themeOf("storm thunder elemental")).every((d) => d === "lightning")).toBe(true);
    expect(damageTypes(themeOf("holy radiant angel")).every((d) => d === "radiant")).toBe(true);
    expect(damageTypes(themeOf("nightmare whisper")).every((d) => d === "psychic")).toBe(true);
    expect(damageTypes(themeOf("ogre brute")).every((d) => d === "blunt")).toBe(true);
    expect(damageTypes(themeOf("duelist swordsman")).every((d) => d === "sharp")).toBe(true);
  });
  it("gives healers a heal and sets resistance and weakness from the theme", () => {
    const e = themeOf("marsh shaman healer");
    expect(e.abilities.some((a) => a.effects.some((f) => f.type === "heal" || f.type === "shield"))).toBe(true);
    const fire = themeOf("fire imp");
    expect(fire.resistance).toBe("fire");
    expect(fire.weakness).toBe("cold");
  });
  it("uses setting notes only when the concept has no theme of its own", () => {
    const damageTypes = (e: Enemy) => e.abilities.flatMap((a) => a.effects.flatMap((f) => (f.type === "damage" ? [f.damage_type] : [])));
    expect(damageTypes(themeOf("a hungry thing", "a frozen waste of ice and snow")).every((d) => d === "cold")).toBe(true);
    expect(damageTypes(themeOf("fire imp", "a frozen waste of ice and snow")).every((d) => d === "fire")).toBe(true);
  });
  it("uses the default theme when nothing matches", () => {
    const e = themeOf("zzz qqq");
    const names = new Set(ENEMY_KITS.themes.find((t) => t.id === ENEMY_KITS.defaultTheme)!.templates.map((t) => t.name));
    for (const a of e.abilities) expect(names.has(a.name)).toBe(true);
  });
  it("scales ability dice with level", () => {
    const avgOf = (d: string) => { const m = /^(\d)d(\d+)$/.exec(d)!; return Number(m[1]) * (Number(m[2]) + 1) / 2; };
    const top = (level: number) => Math.max(...build("fire imp", "boss", level, 4).enemy.abilities.flatMap((a) => a.effects.flatMap((f) => (f.type === "damage" ? [avgOf(f.dice)] : [0]))));
    expect(top(10)).toBeGreaterThan(top(1));
  });
  it("every data template is a valid ability after filling, at every level and role", () => {
    for (const theme of ENEMY_KITS.themes) {
      expect(theme.templates.length).toBeGreaterThanOrEqual(3);
      for (const role of ["standard", "elite", "boss"] as const) for (const level of LEVELS) {
        const { enemy } = build(theme.keywords[0] ?? "plain", role, level, 2);
        expect(validateEnemy(enemy, level).ok).toBe(true);
      }
    }
  });
});

describe("buildEnemyOffline: sprite tags and extras", () => {
  it("derives sprite tags from keywords, at most 5, each at most 24 chars", () => {
    const e = build("robed cultist with a wolf and a bow, golem armor, frost fire", "standard", 3).enemy;
    expect(e.sprite_tags.length).toBeGreaterThan(0);
    expect(e.sprite_tags.length).toBeLessThanOrEqual(5);
    expect(e.sprite_tags).toContain("robe");
    for (const t of e.sprite_tags) expect(t.length).toBeLessThanOrEqual(24);
    expect(new Set(e.sprite_tags).size).toBe(e.sprite_tags.length);
  });
  it("does not set an id (registration assigns it)", () => {
    expect(build("wolf", "standard", 1, 1, { ref: "en_wolf" }).enemy.id).toBeUndefined();
  });
  it("reports what it decided in notes", () => {
    const { notes } = build("fire wolf", "elite", 3, 1);
    expect(notes.join("\n")).toMatch(/theme/i);
    expect(notes.join("\n")).toMatch(/fire/);
  });
});

describe("buildEnemyOffline: registers cleanly", () => {
  it("registerArchetype accepts every role at level 1 with validation on a fresh game state", () => {
    const { state } = makeWorld();
    for (const role of ENEMY_ROLES) {
      const { enemy } = build("wolf pack hunter", role, 1, 8, { ref: "en_pack_wolf" });
      const r = registerArchetype(state, enemy, 1);
      expect(r.ok, r.ok ? "" : r.errors.join("; ")).toBe(true);
      if (r.ok) {
        expect(r.archetype.id).toMatch(/^en_/);
        expect(r.archetype.abilities.every((a) => a.id?.startsWith("ab_"))).toBe(true);
        expect(EnemySchema.safeParse(r.archetype).success).toBe(true);
      }
    }
  });
});
