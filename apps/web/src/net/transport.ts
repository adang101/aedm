export interface TransportHandlers {
  onOpen(): void;
  onMessage(raw: string): void;
  onClose(): void;
}

export interface Transport {
  send(raw: string): void;
  close(): void;
}

/** Opens a connection and wires the handlers. The real WebSocket and the MockServer both provide one. */
export type TransportFactory = (handlers: TransportHandlers) => Transport;

export function defaultWsUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
  const configured = env?.VITE_AEDM_WS_URL;
  if (typeof configured === "string" && configured) return configured;
  // A production build is served by the same origin that hosts the game (the Cloudflare Worker answers /ws).
  if (env?.PROD === true && typeof location !== "undefined" && location.host) {
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  }
  const host = typeof location !== "undefined" && location.hostname ? location.hostname : "localhost";
  const scheme = typeof location !== "undefined" && location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${host}:8787`;
}

export function webSocketFactory(url: string = defaultWsUrl()): TransportFactory {
  return (h) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => h.onOpen());
    ws.addEventListener("message", (ev) => { if (typeof ev.data === "string") h.onMessage(ev.data); });
    ws.addEventListener("close", () => h.onClose());
    ws.addEventListener("error", () => { /* a close event follows */ });
    return { send: (raw) => { if (ws.readyState === WebSocket.OPEN) ws.send(raw); }, close: () => ws.close() };
  };
}
