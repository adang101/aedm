# Rules numbers

Every number here is version 0, to be tuned by simulated fights; the formulas are what the engine's unit tests should lock in. Store the numbers as JSON under `packages/engine/data/`, never hardcoded.

**Core resolution**

| Rule | Value |
| --- | --- |
| Ability modifier | floor((score minus 10) divided by 2): 8 to 9 is -1, 10 to 11 is 0, 12 to 13 is +1, 14 to 15 is +2, 16 to 17 is +3, 18 to 19 is +4, 20 is +5 |
| Key ability | Each character picks one of the six abilities as its key ability. It drives attacks and the save DC of its abilities. |
| Attack roll | d20 + key ability modifier + proficiency bonus + tag bonus against the target's Defense. A natural 20 always hits and doubles damage dice. A natural 1 always misses. |
| Ability check | d20 + ability modifier + 2 if a tag matches, against a DC. No critical results. |
| Save | The target rolls d20 + ability modifier against the save DC, which is 8 + proficiency bonus + the caster's key ability modifier |
| Defense | 10 + DEX modifier + armor bonus |
| Initiative | d20 + DEX modifier; ties go to higher DEX, then to players |
| Speed | 6 tiles per turn (1 tile is 5 feet). Hasted +2, slowed -2 (minimum 1), rooted 0. |
| Turn | Move up to speed, take one action, and one quick action. Each ability is marked action or quick. |
| Advantage and disadvantage | Roll two d20 and keep the higher or lower. Any mix of advantage and disadvantage cancels to a normal roll. |
| DC guide | Trivial 5, easy 10, medium 15, hard 20, very hard 25, near impossible 30. The engine clamps every DC to 5 through 30. |
| Distance | Diagonals count as 1 tile. Line of sight is blocked by walls and smoke. |

**Point buy**

Scores start at 8, creation budget is 27 points, and no score may start above 15.

| Score | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Cost | 0 | 1 | 2 | 3 | 4 | 5 | 7 | 9 |

At levels 3, 6 and 9, add +1 to any one ability (maximum 20).

**Level table**

Level cap for the MVP is 10. Growth needed per level is 100. HP at level 1 is 10 + CON modifier, and each later level adds 6 + CON modifier (at least +1).

| Level | Proficiency | Power budget | Per-ability cap | Max average damage or healing per effect | Max area radius | Max condition turns | Max stun turns | Weapon tier |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | +2 | 30 | 13 | 7 | 1 | 1 | 1 | T1 |
| 2 | +2 | 35 | 15 | 9 | 1 | 1 | 1 | T1 |
| 3 | +2 | 40 | 18 | 11 | 1 | 1 | 1 | T2 |
| 4 | +2 | 45 | 20 | 13 | 1 | 1 | 1 | T2 |
| 5 | +3 | 50 | 22 | 15 | 2 | 2 | 1 | T3 |
| 6 | +3 | 55 | 24 | 17 | 2 | 2 | 1 | T3 |
| 7 | +3 | 60 | 27 | 19 | 2 | 2 | 2 | T4 |
| 8 | +3 | 65 | 29 | 21 | 2 | 2 | 2 | T4 |
| 9 | +4 | 70 | 31 | 23 | 2 | 3 | 2 | T5 |
| 10 | +4 | 75 | 33 | 25 | 2 | 3 | 2 | T5 |

Power budget is 25 + 5 times level. Per-ability cap is 45% of the budget, rounded down. Maximum average damage per effect is 5 + 2 times level. A character's abilities must total at most the budget, and no single ability may exceed the cap.

How the caps apply to abilities:

- **Max condition turns** applies to conditions the DM imposes with `apply_condition` (clamped, not rejected). Inside abilities only stunned is capped, by **max stun turns**; other ability conditions may last up to 3 turns, and the cost formula prices the longer duration through the duration multiplier.
- **Max area radius** applies to damage, heal and terrain effects. Reveal is not capped by it (radius 1 to 2 at any level).

**Gear**

| Item | Rule |
| --- | --- |
| Weapon tiers (basic attack damage) | T1 1d6, T2 1d8, T3 1d10, T4 2d6, T5 2d8. A basic attack is an action: range 1 (melee) or up to 6 tiles (ranged), damage = dice + key ability modifier. |
| Armor | None +0, light +2, medium +4 (DEX modifier counts up to +2), heavy +6 (DEX modifier does not count, speed -1) |
| Healing draught | Quick action, restores 2d4 + 2 HP, value 25 |
| Loot cap per encounter | 20 + 10 times level in gold-equivalent value (30 at level 1). Quest items have value 0 and do not count. |
| Damage types | fire, cold, lightning, acid, blunt, sharp, psychic, radiant. A weakness takes 1.5 times damage and a resistance 0.5 times, rounded down. |

**Conditions**

Durations count in the affected creature's own turns and tick down at the end of its turn. The same condition does not stack; the longer duration wins.

| Condition | Effect |
| --- | --- |
| stunned | Cannot act or move. Attacks against it have advantage. |
| slowed | Speed -2 (minimum 1) and -1 Defense |
| rooted | Speed 0. It can still act. |
| prone | Adjacent attacks against it have advantage; ranged attacks against it have disadvantage. Standing costs 3 tiles of movement. |
| burning | Takes 1d6 fire damage at the start of its turn. An action puts it out. |
| bleeding | Takes 1d4 damage at the start of its turn. Any healing ends it. |
| shielded | Absorbs damage up to the shield value before HP is touched |
| hasted | Speed +2 and +2 Defense |
| marked | Attacks against it get +2 to hit |
| taunted | Disadvantage on attacks against anyone except the taunter |
| dazzled | Disadvantage on attacks |
| evasive | Attacks against it have disadvantage |

**Downed, rests and absent players**

- A character at 0 HP is downed: prone and unable to act. Any healing revives it with that many HP. An adjacent ally can use an action for a DC 10 Wisdom check to revive it at 1 HP. After 3 rounds without revival it is out of the fight.
- When combat ends, downed characters wake at 1 HP. If everyone is downed, the DM narrates a defeat consequence such as capture, retreat or lost loot. It is never game over.
- A rest is a safe scene break narrated by the DM. It restores half of maximum HP and resets all cooldowns and limited uses.
- A character whose player is absent cannot drop below 1 HP.

**Ability cost formula**

1. Price each effect using the effect table, applying its own duration multiplier where listed.
2. Add the effect prices together.
3. Multiply the sum by the area, save, range and frequency multipliers.
4. Round up to a whole number, with a minimum of 1.

Do the math in integers: store prices and multipliers in hundredths, multiply, then divide and round up. Floating-point math gives wrong costs (5 x 0.6 evaluates to 3.0000000000000004 and would round up to 4).

| Effect | Price |
| --- | --- |
| damage | ceil(average damage / 2): 1d6 is 2, 1d8 is 3, 2d4 is 3, 2d6 is 4, 3d6 is 6 |
| heal | ceil(average healing / 2), same table as damage |
| shield | ceil(absorb / 3), times the duration multiplier |
| condition, per 1 turn | stunned 6, hasted 3, evasive 3, slowed 2, rooted 2, burning 2, bleeding 2, dazzled 2, taunted 2, prone 1, marked 1, times the duration multiplier |
| mark | Shorthand for the marked condition |
| push or pull | ceil(tiles / 2) |
| dash | ceil(tiles / 2) |
| teleport | 1 per tile, up to 6 tiles |
| reveal | 1 |
| disarm | 1 |
| terrain | smoke 2, wall 3, fire 3 plus its damage price, trap 3 plus its damage price. Smoke, wall and fire are times the duration multiplier. A trap lasts until triggered. |
| check_bonus | +1 or +2 costs 2, +3 or +4 costs 5, times the duration multiplier |

| Multiplier | Values |
| --- | --- |
| Duration (turns) | 1 turn is 1.00, 2 turns is 1.60, 3 turns is 2.20 |
| Area | Single target 1.00, burst radius 1 is 1.50, burst radius 2 is 2.00, line up to 6 tiles is 1.50, cone up to 4 tiles is 1.50 |
| Save | The target gets a save to negate or halve: 0.75. No save: 1.00. |
| Range | Self or adjacent 0.80, up to 4 tiles 1.00, up to 8 tiles 1.10, up to 12 tiles 1.20 |
| Frequency (pick one) | Cooldown: none 1.50, 1 turn 1.20, 2 turns 1.00, 3 turns 0.85, 4 or more turns 0.70. Or limited uses per rest: 1 use 0.50, 2 uses 0.60, 3 uses 0.70. |

**Worked examples (use these as unit-test fixtures)**

| Ability | Calculation | Cost |
| --- | --- | --- |
| Shaped Charge | damage 2d6 (4) + stunned 1 turn (6) = 10; x1.50 area r1, x0.75 save, x1.10 range 6, x0.85 cooldown 3 = 10.52 | 11 |
| Tripwire Cache | trap 3 + damage 1d6 (2) = 5; single tile, range up to 4 x1.00, x0.60 two uses = 3.00 | 3 |
| Smoke Pop | smoke 2 x1.60 (2 turns) = 3.20; x1.50 area r1, x1.10 range 6, x0.85 cooldown 3 = 4.49 | 5 |
| Blink Rush | dash 4 tiles (2) + damage 1d6 (2) = 4; range up to 4 x1.00, x1.20 cooldown 1 = 4.80 | 5 |
| Feint and Fade | evasive 1 turn (3); x0.80 self, x1.00 cooldown 2 = 2.40 | 3 |
| Slipstream | hasted 2 turns 3 x1.60 = 4.80; range up to 4 x1.00, x0.85 cooldown 3 = 4.08 | 5 |
| Mending Poultice | heal 2d4 (3); x0.80 adjacent, x1.00 cooldown 2 = 2.40 | 3 |
| Bitterroot Snare | rooted 2 turns 2 x1.60 = 3.20; x0.75 save, x1.10 range 8, x0.85 cooldown 3 = 2.24 | 3 |
| Fog Lantern | reveal (1); x2.00 area r2, x0.80 self, x0.85 cooldown 3 = 1.36 | 2 |
| Riposte Stance (as evasive) | Same as Feint and Fade | 3 |
| Mark for the Blade | marked 2 turns 1 x1.60 = 1.60; x1.10 range 8, x1.00 cooldown 2 = 1.76 | 2 |
| Wounding Cut | damage 1d6 (2) + bleeding 3 turns 2 x2.20 (4.40) = 6.40; x0.80 adjacent, x1.00 cooldown 2 = 5.12 | 6 |
| Reality Chorus (toned down) | damage 2d6 (4) + stunned 1 turn (6) = 10; x1.50 area r1, x0.75 save, x1.10 range 6, x0.50 one use = 6.19 | 7 |
| Hymn of Mending (toned down) | heal 2d4 (3); x1.50 area r1, x0.80 self, x0.50 one use = 1.80 | 2 |

Checks at level 1: Brindle's three abilities total 19, Tamsin's 13, Orrin's 8 and Iselle's 11, all under the budget of 30, and every ability is under the cap of 13.

**Enemy numbers**

Threat score = HP / 4 + 2 x (Defense - 10) + 1.5 x damage per round + 0.5 x (sum of ability costs) + (speed - 6). Damage per round is the average damage of the enemy's best repeatable action, assuming it hits. Use the exact dice average (1d6 is 3.5, not 4).

| Party level | HP | Defense | Attack bonus | Damage per round | Threat of a standard enemy |
| --- | --- | --- | --- | --- | --- |
| 1 | 10 | 12 | +3 | 4 | 12.5 |
| 3 | 22 | 13 | +4 | 7 | 22.0 |
| 5 | 40 | 15 | +6 | 12 | 38.0 |
| 7 | 60 | 16 | +7 | 16 | 51.0 |
| 10 | 90 | 18 | +9 | 22 | 71.5 |

Interpolate between rows. The enemy builder's allowed ranges are HP and damage within 20% of the table value, and Defense and attack bonus within 1.

- **Encounter budget (standard)** = party size x (10 + 3 x party level). For 3 level-1 characters that is 39, and for 4 it is 52.
- **Difficulty multipliers:** easy 0.5, standard 1.0, hard 1.5, deadly 2.0.
- **Roles:** a minion has half the standard HP, 75% of the damage and no abilities. An elite may have up to 1.5 times standard HP and damage and 1 to 2 abilities. A boss may have up to 2 times HP, 1.5 times damage and 1 to 3 abilities, and one boss may spend up to 1.5 times the standard budget alone. Minions come out of the remaining budget.
- **Worked example:** a robed chorister at level 1 has HP 10, Defense 12, attack +3, damage 4 per round, and Borrowed Voice (dazzled 1 turn, save, range 6, cooldown 3: 2 x0.75 x1.10 x0.85 = 1.40, costs 2). With a 1d6 basic attack (average 3.5): threat = 2.5 + 4 + 5.25 + 1 = 12.75. Two of them total 25.5, inside the budget of 39. (The table's "damage per round 4" is a target for the enemy builder, not a fixed value.)

**Out-of-combat and tactical AI (`rules.ai`, added with the engine-led play work)**

Stored in `packages/engine/data/rules.json` under `ai`. These are untuned first guesses. The morale, tactics and `healBelowPct` keys that were there before are unchanged.

| Key | Value | Meaning |
| --- | --- | --- |
| `areaAllyPenalty` | 1 | An area ability is scored as foes caught minus this times allies caught. It is never used when it would catch as many allies as foes, or no foe. |
| `kite.enabled` | true | A ranged creature may step away from a foe next to it and still shoot. |
| `kite.triggerDistance` | 1 | It kites when a foe is this close or closer (in tiles). |
| `kite.minFoeDistance` | 2 | The tile it steps to must be at least this far from every foe. |
| `finish.enabled` | true | A foe the creature can plausibly drop this turn is targeted first. |
| `finish.damagePct` | 100 | A foe counts as droppable when its HP plus shield is at most this percent of the creature's average hit (average basic damage plus key modifier, at least the minimum damage). |
| `hazard.avoid` | true | Creatures walk around fire with damage dice and visible traps of the other side. |
| `hazard.detourAllowance` | 3 | A path around hazards is taken when it is at most this many tiles longer. A step that would end on a hazard is cut short unless that leaves no progress at all, in which case the whole step is taken. |
| `aggro.enabled` | true | Out of combat, hostile creatures can start a fight by noticing the party. |
| `aggro.radius` | 8 | A hostile creature notices a standing party character within this many tiles and in line of sight (walls, smoke and closed doors block it). |
| `aggro.joinRadius` | 6 | Other hostiles within this many tiles of one that noticed join the fight. |
| `aggro.joinAll` | false | When true every hostile on the map joins. |
| `aggro.includeAllies` | true | Allied NPCs on the map fight beside the party. |
| `follow.enabled` | true | Allied NPCs follow the party outside combat and at scene changes. |
| `follow.maxDistance` | 4 | An ally farther than this from the nearest standing party character walks toward them; at a scene change, allies within this distance come along. |
| `follow.stopDistance` | 2 | A following ally stops within this many tiles of the character. |
| `follow.stepTiles` | 6 | At most this many tiles per follow step (one step after each party move). |

Creatures that survive a fight that ends without their defeat (truce, flight, party defeat) are marked calm and never aggro until a new combat starts with them. This is a flag on the entity, not a number.

**Engine data files for text and offline building** (all numbers below are first guesses; phrasings are in the files)

- `packages/engine/data/enemy-kits.json` (the offline enemy builder). Names: at most 3 words and 40 characters, from an `en_` ref or the concept (concept text is cut to 200 characters). Each stat is placed inside the allowed range for the party level (the ranges in Enemy numbers; 0% is the lowest value, 100% the highest). It starts at 50%, moves by a random plus or minus 10 points, and by the trait shifts below (percentage points of the range; speed in tiles, with a 25% chance of one more or one less):

| Trait | HP | Defense | Attack | Damage | Speed |
| --- | --- | --- | --- | --- | --- |
| armored | +25% | +45% | +0% | +0% | -1 |
| swift | -25% | -10% | +10% | +0% | +1 |
| brute | +15% | +0% | -35% | +40% | -1 |
| frail | -30% | -10% | +0% | -15% | +0 |
| deadly | -10% | +0% | +30% | +15% | +0 |

  Behavior is 2 to 3 short lines that the `rules.ai.tactics` patterns read. Element themes (fire, cold, poison, shadow, radiant, lightning, brute, blade, beast, healer, default) carry a resistance, a weakness, a loot hint, sprite tags and ability templates; the result is always clamped and validated like a model enemy. Ability count by role: minion 0, standard 1, elite 2, boss 3. Ability dice power as a percent of the template by role: minion 0, standard 80, elite 100, boss 120. Every ability goes through `clampAbilityToLevel`, so costs stay in integer hundredths.
- `packages/engine/data/describe.json` (scene, creature and pack descriptions). Health words from the percentage of HP, rounded up, so only a creature at full health is unhurt: unhurt (from 100%), scratched (from 75%), wounded (from 50%), badly wounded (from 25%), barely standing (from 1%), downed (from 0%). List caps in a description: exits 4, objects 6, containers 4, creatures 8, party 6, inventory 24. Descriptions never print hit points as numbers.
- `packages/engine/data/combat-voice.json` (fight openings, barks, victory close). Bark chance by event, in percent: morale broken 100, surrendered 100, fled 100, bloodied 50 (a roll of d100 above the number means a quiet moment). Body plans that speak aloud: humanoid, spirit; the others get a described reaction. A won fight needs the DM when a boss or elite was involved (roles: boss, elite) or, with `dmWhenPartyDown` set to true, a party member is still down. The `start_noticed` templates open a fight that creatures started by noticing the party.

**Growth**

- Level cap 10 in the MVP. 100 growth points per level, and any overflow carries over.
- A milestone grants 100 to every present character, once per milestone.
- A contextual award is 1 to 25 points per `award_growth`, at most 50 per character per session and at most 3 awards per character per session.
- A level-up raises the power budget and HP, and adds an ability score point at levels 3, 6 and 9. The player picks a new ability (through the forge) or upgrades an existing one (re-forged within the new caps).

**Check tags**

Each character has two tags and gets +2 on checks the DM labels with a matching tag. The DM may use only tags from this list: athletics, stealth, speed, perception, survival, nature, medicine, lore, crafting, explosives, lockpicking, persuasion, deception, intimidation, performance, leadership, tinkering, animals. Add tags only after playtests show a gap.

**Containers, locks and loot** (added with the engine-handled interactions; none of the numbers above change)

Stored in `packages/engine/data/interact.json` and `loot.json`. Starting values, to be tuned by simulation.

| Rule | Value |
| --- | --- |
| Reach | 1 tile (Chebyshev, so diagonals count) to a container, door, lever or lock. Reading a sign and `examine`: 4 tiles. |
| Pack cap for taking, receiving and picking up | 24 items per character. (The schema allows 100 and the DM's `grant_item` keeps its existing cap of 100; the 24 applies to engine transfers.) |
| Items per pile or remains | 30; a full pile starts another on the same tile |
| Bound gear | Weapons and armor equip on pickup like a granted item and cannot be dropped or given, so a tier cannot be copied from one character to another |

In combat (only the active creature acts; one verb per slot):

| Verb | Cost |
| --- | --- |
| Open or close a container, take, take all, open or close a door, pull a lever, unlock, pick or force a lock | Action |
| Drop, give | Quick action |
| Read a sign, examine | Free, even out of turn |

Locks:

| Tier | Lock DC (before variance) |
| --- | --- |
| 1 | 10 |
| 2 | 12 |
| 3 | 15 |
| 4 | 18 |
| 5 | 20 |

- Variance: plus or minus 2, drawn when the map is built, kept within 5 to 30. The tier is the party's gear allowance (the level's weapon tier), passed to map generation; default 1.
- Unlock with the matching key item: automatic, the key is kept. Pick: DEX check, +2 with the lockpicking tag, against the DC. Force: STR check, +2 with the athletics tag, against the DC plus 2. A failed pick has no penalty. A forced lock breaks for good; forcing makes noise that carries 6 tiles, success or failure.
- Doors the generator adds on door tiles (enabled by default): 50% start closed, and locked with odds by tier of 5, 10, 15, 20 and 25 percent (locked doors are also closed). A lever links to the nearest door (1 link).

Loot (`rollLoot`): 1 to 3 items per roll, kinds weighted consumable 38, trinket 38, weapon 14, armor 10, never quest. Gear is rolled only up to the party's tier allowance and richer trinkets only at higher tiers, so no item beats what the level allows. The total value of a roll never exceeds its budget.

| Source | Budget | Items |
| --- | --- | --- |
| Chest | 40% of the encounter loot cap (12 at level 1) | up to 3 |
| Loot slot | 30% of the cap for each count (9 at level 1 for a count of 1) | up to 2 for each count |
| Remains | Percent of the cap by role below, and never more than the cap still unspent this encounter | by role below |

| Enemy role | Drops nothing | Drops loot | Budget (% of cap) | Most items |
| --- | --- | --- | --- | --- |
| Minion | 70 | 30 | 15 | 1 |
| Standard | 35 | 65 | 30 | 2 |
| Elite | 10 | 90 | 50 | 3 |
| Boss | 0 | 100 | 80 | 4 |

Remains loot counts against the encounter loot cap exactly like `grant_item` (and the cap resets when the next combat starts). Chest and slot stock is scenery: it does not count. Template values run from 2 (a river stone) to 105 (a master-made blade); the healing draught takes its name and value (25) from the Gear table above.

**Tuning plan**

Run seeded battles nightly between generated parties and enemies. Starting targets: a standard encounter is won in 70 to 90% of runs and ends within about 8 rounds. If results fall outside that band, change the encounter budget multiplier first, then enemy damage, and keep the ability cost formula stable.
