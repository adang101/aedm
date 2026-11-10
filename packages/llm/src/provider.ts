export type Tier = "fast" | "standard" | "strong";

export type ModelPurpose = "dm" | "forge" | "enemy" | "repair" | "bible" | "summary";

export interface ModelRequest {
  tier: Tier;
  /** Stable instructions. Cached by providers that support it; keep volatile context out of here. */
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  purpose: ModelPurpose;
}

export interface ModelResponse {
  text: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
  stopReason?: string;
}

export interface ModelProvider {
  readonly name: string;
  complete(
    req: ModelRequest,
    opts?: { signal?: AbortSignal; onText?: (delta: string) => void },
  ): Promise<ModelResponse>;
}
