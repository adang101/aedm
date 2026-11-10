import type { ModelProvider, ModelRequest, ModelResponse } from "../provider";
import { improvFor } from "./fake-improv";

export type FakeReply = string | Error | ModelResponse;
export type FakeScript = FakeReply[] | ((req: ModelRequest, callIndex: number) => FakeReply | Promise<FakeReply>);

export interface FakeProvider extends ModelProvider {
  /** Every request received, in order. */
  readonly requests: ModelRequest[];
  /** Replies still waiting in a queue script. */
  readonly remaining: number;
}

export interface FakeOptions {
  /** Characters per streamed chunk (default 24) so streaming consumers get realistic partial input. */
  chunkSize?: number;
}

/**
 * Fake provider. Without a script it is an offline improv Dungeon Master (and forge, enemy builder,
 * bible and summary writer) so the game is playable with no API key. With a queue (array) or a function it
 * returns the given replies and records requests; an exhausted queue throws. Strings are streamed in chunks.
 */
export function createFakeProvider(script?: FakeScript, options: FakeOptions = {}): FakeProvider {
  const requests: ModelRequest[] = [];
  const queue = Array.isArray(script) ? [...script] : undefined;
  const chunk = Math.max(1, options.chunkSize ?? 24);

  return {
    name: "fake",
    requests,
    get remaining() {
      return queue?.length ?? 0;
    },
    async complete(req, opts = {}): Promise<ModelResponse> {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const index = requests.length;
      requests.push(structuredClone(req));
      let reply: FakeReply;
      if (queue) {
        const next = queue.shift();
        if (next === undefined) throw new Error("Fake provider script exhausted");
        reply = next;
      } else if (typeof script === "function") {
        reply = await script(req, index);
      } else {
        reply = improvFor(req);
      }
      if (reply instanceof Error) throw reply;
      const res: ModelResponse =
        typeof reply === "string"
          ? {
              text: reply, model: `fake-${req.tier}`, stopReason: "end_turn",
              usage: { inputTokens: Math.ceil((req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0)) / 4), outputTokens: Math.ceil(reply.length / 4) },
            }
          : reply;
      if (opts.onText) for (let i = 0; i < res.text.length; i += chunk) opts.onText(res.text.slice(i, i + chunk));
      return res;
    },
  };
}
