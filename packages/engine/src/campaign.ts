/**
 * The campaign plan: lookups and the semantic checks for the plan the story bible carries (locations, cast, encounters,
 * key items, ending and milestone triggers). Pure. Thresholds live in data/campaign.json.
 */
import type { Milestone, MilestoneTrigger, StoryBible } from "@aedm/schemas";
import { CAMPAIGN } from "./data.ts";

/** Anything of the plan present: `validateCampaign` then holds the bible to the whole plan. */
function hasAnyPlanField(b: StoryBible): boolean {
  return b.locations !== undefined || b.cast !== undefined || b.encounters !== undefined || b.key_items !== undefined || b.ending !== undefined;
}

/** True when the bible has a campaign plan with at least one location (saves from before the plan do not). */
export function hasCampaignPlan(bible: StoryBible): boolean {
  return (bible.locations?.length ?? 0) > 0;
}

/** A milestone's trigger; `story` (the DM decides) when it has none. */
export function triggerOf(m: Milestone): MilestoneTrigger {
  return m.trigger ?? { type: "story" };
}

/** True for the triggers the engine tracks (everything but `story`). */
export function isMachineTrigger(t: MilestoneTrigger): boolean {
  return t.type !== "story";
}

/** Ids of the locations connected to this one, in list order. A connection declared on either side counts. */
export function campaignNeighbors(bible: StoryBible, locationId: string): string[] {
  const locs = bible.locations ?? [];
  const me = locs.find((l) => l.id === locationId);
  if (!me) return [];
  const ids = new Set(me.connects_to);
  for (const l of locs) if (l.id !== locationId && l.connects_to.includes(locationId)) ids.add(l.id);
  ids.delete(locationId);
  return locs.map((l) => l.id).filter((id) => ids.has(id));
}

/**
 * Semantic checks for a bible's campaign plan, after the schema: reference integrity (every trigger, cast home, encounter and
 * key item points at something that exists), a connected location graph, stages covered in order, a machine-checkable share
 * of milestones and a machine-checkable final stage. Returns reasons; empty when fine or when the bible has no plan at all
 * (older saves). A bible that has a plan but no plot fails: the plan hangs off the plot's stages.
 */
export function validateCampaign(bible: StoryBible): string[] {
  if (!hasAnyPlanField(bible)) return [];
  const L = CAMPAIGN.limits;
  const errs: string[] = [];
  const stageIds = bible.plot?.stages.map((s) => s.id) ?? [];
  if (!bible.plot) errs.push("campaign plan: the bible has no plot, and the plan hangs off the plot's stages");
  const locations = bible.locations ?? [];
  const cast = bible.cast ?? [];
  const encounters = bible.encounters ?? [];
  const items = bible.key_items ?? [];

  // locations
  if (locations.length === 0) errs.push("campaign plan: locations are missing");
  else {
    if (locations.length < L.minLocations) errs.push(`campaign plan: at least ${L.minLocations} locations are needed (got ${locations.length})`);
    if (locations.length > L.maxLocations) errs.push(`campaign plan: at most ${L.maxLocations} locations are allowed (got ${locations.length})`);
  }
  const locIds = new Set<string>();
  for (const l of locations) {
    if (locIds.has(l.id)) errs.push(`duplicate location id ${l.id}`);
    locIds.add(l.id);
  }
  for (const l of locations) {
    for (const c of l.connects_to) {
      if (c === l.id) errs.push(`location ${l.id} connects to itself`);
      else if (!locIds.has(c)) errs.push(`location ${l.id}: connects to unknown location ${c}`);
    }
    if (bible.plot && !stageIds.includes(l.stage)) errs.push(`location ${l.id}: unknown stage ${l.stage}`);
  }
  if (locations.length > 0) {
    const reached = new Set<string>([locations[0]!.id]);
    const queue = [locations[0]!.id];
    while (queue.length > 0) {
      for (const n of campaignNeighbors(bible, queue.shift()!)) if (!reached.has(n)) { reached.add(n); queue.push(n); }
    }
    const lost = [...locIds].filter((id) => !reached.has(id));
    if (lost.length > 0) errs.push(`locations not reachable from the first location: ${lost.join(", ")}`);
    for (const l of locations) {
      const n = campaignNeighbors(bible, l.id).length;
      if (n > L.maxConnections) errs.push(`location ${l.id} has ${n} connections (at most ${L.maxConnections})`);
    }
  }
  if (bible.plot && locations.length > 0) {
    let last = -1;
    let ordered = true;
    const seen = new Set<string>();
    for (const l of locations) {
      const idx = stageIds.indexOf(l.stage);
      if (idx < 0) continue;
      seen.add(l.stage);
      if (idx < last) ordered = false;
      last = Math.max(last, idx);
    }
    if (!ordered) errs.push("locations must be listed in stage order");
    for (const id of stageIds) if (!seen.has(id)) errs.push(`stage ${id} has no location`);
  }

  // cast
  if (cast.length > L.maxCast) errs.push(`campaign plan: at most ${L.maxCast} cast members are allowed (got ${cast.length})`);
  const castIds = new Set<string>();
  const castNames = new Map<string, string>();
  const perLocation = new Map<string, number>();
  for (const c of cast) {
    if (castIds.has(c.id)) errs.push(`duplicate cast id ${c.id}`);
    castIds.add(c.id);
    if (!locIds.has(c.location)) errs.push(`cast ${c.id}: unknown location ${c.location}`);
    perLocation.set(c.location, (perLocation.get(c.location) ?? 0) + 1);
    const key = c.name.trim().toLowerCase();
    const other = castNames.get(key);
    if (other !== undefined) errs.push(`cast members ${other} and ${c.id} share the name ${c.name}`);
    else castNames.set(key, c.id);
  }
  for (const [loc, n] of perLocation) if (n > L.maxCastPerLocation) errs.push(`location ${loc} has ${n} cast members (at most ${L.maxCastPerLocation})`);

  // encounters
  if (encounters.length > L.maxEncounters) errs.push(`campaign plan: at most ${L.maxEncounters} encounters are allowed (got ${encounters.length})`);
  const encIds = new Set<string>();
  for (const e of encounters) {
    if (encIds.has(e.id)) errs.push(`duplicate encounter id ${e.id}`);
    encIds.add(e.id);
    if (!locIds.has(e.location)) errs.push(`encounter ${e.id}: unknown location ${e.location}`);
    if (bible.plot && !stageIds.includes(e.stage)) errs.push(`encounter ${e.id}: unknown stage ${e.stage}`);
    const units = e.groups.reduce((n, g) => n + g.count, 0);
    if (units > L.maxUnitsPerEncounter) errs.push(`encounter ${e.id} has ${units} creatures (at most ${L.maxUnitsPerEncounter})`);
    const bosses = e.groups.filter((g) => g.role === "boss").reduce((n, g) => n + g.count, 0);
    if (bosses > L.maxBossCount) errs.push(`encounter ${e.id}: at most ${L.maxBossCount} boss allowed (got ${bosses})`);
  }

  // key items
  if (items.length > L.maxKeyItems) errs.push(`campaign plan: at most ${L.maxKeyItems} key items are allowed (got ${items.length})`);
  const itemIds = new Set<string>();
  for (const k of items) {
    if (itemIds.has(k.id)) errs.push(`duplicate key item id ${k.id}`);
    itemIds.add(k.id);
    if (!locIds.has(k.location)) errs.push(`key item ${k.id}: unknown location ${k.location}`);
    const h = k.held_by;
    if (!h) continue;
    const home = h.kind === "cast" ? cast.find((c) => c.id === h.id)?.location : encounters.find((e) => e.id === h.id)?.location;
    if (home === undefined) errs.push(`key item ${k.id}: unknown ${h.kind} ${h.id}`);
    else if (home !== k.location) errs.push(`key item ${k.id}: held by ${h.id}, who is at ${home}, but the item is at ${k.location}`);
  }

  if (!bible.ending) errs.push("campaign plan: the ending is missing");

  // milestone triggers
  const first = locations[0]?.id;
  let machine = 0;
  for (const m of bible.milestones) {
    const t = triggerOf(m);
    if (isMachineTrigger(t)) machine++;
    switch (t.type) {
      case "reach_location":
        if (!locIds.has(t.location)) errs.push(`milestone ${m.id}: unknown location ${t.location}`);
        else if (t.location === first) errs.push(`milestone ${m.id}: location ${t.location} is already reached when the story starts`);
        break;
      case "defeat_encounter": if (!encIds.has(t.encounter)) errs.push(`milestone ${m.id}: unknown encounter ${t.encounter}`); break;
      case "obtain_item": if (!itemIds.has(t.item)) errs.push(`milestone ${m.id}: unknown key item ${t.item}`); break;
      case "talk_to": if (!castIds.has(t.cast)) errs.push(`milestone ${m.id}: unknown cast ${t.cast}`); break;
      case "story": break;
    }
  }
  const total = bible.milestones.length;
  if (total > 0 && machine * 100 < CAMPAIGN.checkable.minPct * total) {
    errs.push(`only ${machine} of ${total} milestones are machine-checkable (at least ${CAMPAIGN.checkable.minPct}% are needed)`);
  }
  const lastStage = stageIds[stageIds.length - 1];
  if (lastStage !== undefined) {
    const finalMachine = bible.milestones.filter((m) => m.stage === lastStage && isMachineTrigger(triggerOf(m))).length;
    if (finalMachine < CAMPAIGN.checkable.finalStageMin) errs.push(`final stage ${lastStage} has no machine-checkable milestone`);
  }
  return errs;
}
