import type { ModelProvider } from "@aedm/llm";

/** Timer functions, injectable so tests can run fast or fully fake. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export const consoleLogger: Logger = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};
export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface ServerConfig {
  /** A beat closes this long after the first intent if not every present player has acted. */
  beatWindowMs: number;
  /** Delay between steps of a click-to-move walk. */
  moveStepMs: number;
  /** Delay before each AI-controlled combat turn. */
  aiStepMs: number;
  /** Combat turn timer for player turns. */
  turnMs: number;
  /** How often turn_timer is broadcast. */
  turnTickMs: number;
  /** How long a skip/wait/autopilot vote stays open. */
  voteMs: number;
  /** A closed connection becomes "offline" (and its character absent) after this long. */
  disconnectGraceMs: number;
  /** Wait before the single retry of a failed model call. */
  retryBackoffMs: number;
  /** A room with nobody connected for this long is deleted. */
  roomIdleMs: number;
  maxPlayers: number;
  limits: { movePerSec: number; sayIntervalMs: number; otherPerSec: number };
  /** Log rejected DM actions and other dev details to the logger. */
  devLog: boolean;
  /** Characters of the recent-turn window handed to the DM. */
  recentTurnLimit: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  beatWindowMs: 6000,
  moveStepMs: 120,
  aiStepMs: 700,
  turnMs: 45_000,
  turnTickMs: 1000,
  voteMs: 20_000,
  disconnectGraceMs: 5000,
  retryBackoffMs: 1500,
  roomIdleMs: 10 * 60_000,
  maxPlayers: 6,
  limits: { movePerSec: 10, sayIntervalMs: 2000, otherPerSec: 5 },
  devLog: false,
  recentTurnLimit: 12,
};

/** Everything injected into rooms and games. */
export interface Deps {
  provider: ModelProvider;
  saveDir: string;
  clock: () => number;
  /** Returns a float in [0, 1). Used for seeds and invite codes. */
  random: () => number;
  timers: Timers;
  config: ServerConfig;
  logger: Logger;
}
