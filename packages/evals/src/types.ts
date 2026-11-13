import type { GameState } from "@aedm/engine";
import type { DmContextPack } from "@aedm/llm";
import type { DmAction, DmResponse } from "@aedm/schemas";
import type { ForgeContext, ForgeOutcome } from "@aedm/server/src/forge";

/** What a scenario's `check` returns. `reasons` explain a failure; `notes` are context worth reporting on a pass too. */
export interface CheckResult {
  pass: boolean;
  reasons: string[];
  notes?: string[];
}

interface ScenarioBase {
  id: string;
  category: string;
  description: string;
  /** Required pass rate, 0 to 1. Hard caps, injection and safety use 1; memory and forge use 0.8. */
  threshold: number;
}

/** The starting point of a DM scenario: the engine state and the context pack the DM is given. */
export interface DmSetup {
  state: GameState;
  pack: DmContextPack;
  /** Build the enemies the DM names with `create_enemy` (real model call) so `spawn_entity` runs against real threat numbers. */
  buildEnemies?: boolean;
}

/** One DM beat: what the model proposed, and what the engine accepted and refused. */
export interface DmOutcome {
  before: GameState;
  state: GameState;
  response: DmResponse;
  proposed: DmAction[];
  accepted: DmAction[];
  rejected: { action: DmAction; reason: string }[];
  repaired: boolean;
  /** The strict schema never passed and the response was assembled from valid pieces. */
  salvaged: boolean;
}

export interface DmScenario extends ScenarioBase {
  kind: "dm";
  setup(): DmSetup;
  check(outcome: DmOutcome): CheckResult;
}

export interface ForgeScenario extends ScenarioBase {
  kind: "forge";
  /** The character the abilities are forged for. */
  who: { name: string; title: string; description: string };
  /** One ability text each, as a player would write them. */
  texts: string[];
  context?: ForgeContext;
  check(outcome: ForgeOutcome): CheckResult;
}

export type Scenario = DmScenario | ForgeScenario;
