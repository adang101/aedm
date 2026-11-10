import type { GameClient } from "../net/client";
import type { AppState, Store } from "../state/store";

export interface Ctx {
  store: Store;
  client: GameClient;
  toast(message: string, kind?: "error" | "info"): void;
}

export interface Screen {
  el: HTMLElement;
  update(s: AppState): void;
  destroy?(): void;
}
