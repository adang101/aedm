export type LlmErrorKind = "rate_limit" | "api" | "network" | "refusal" | "aborted" | "invalid_output";

/** Every failure that leaves the LLM layer is an LlmError. `retryable` says whether trying again may help. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, kind: LlmErrorKind, retryable: boolean, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "LlmError";
    this.kind = kind;
    this.retryable = retryable;
    this.status = opts.status;
  }
}

/** The model declined to answer (stop_reason "refusal"). Never retryable as-is. */
export class RefusalError extends LlmError {
  constructor(message = "The model declined to respond.") {
    super(message, "refusal", false);
    this.name = "RefusalError";
  }
}
