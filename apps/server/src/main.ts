import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropicProvider, createFakeProvider, type ModelProvider } from "@aedm/llm";
import { parseEnv } from "./env";
import { createGameServer } from "./server";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function loadDotEnv(): void {
  const file = join(REPO_ROOT, ".env");
  if (!existsSync(file)) return;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (process.env[k] === undefined && v !== "") process.env[k] = v;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const port = Number(process.env.AEDM_PORT ?? 8787);
  const kind = (process.env.AEDM_LLM_PROVIDER ?? "fake").toLowerCase();
  const dataDir = process.env.AEDM_DATA_DIR ? resolve(process.env.AEDM_DATA_DIR) : join(REPO_ROOT, "data");
  const saveDir = process.env.AEDM_SAVE_DIR ?? join(dataDir, "saves");

  let provider: ModelProvider;
  if (kind === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("AEDM_LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY (set it in .env).");
      process.exit(1);
    }
    provider = createAnthropicProvider(); // the SDK reads the key from the environment; it is never logged
  } else if (kind === "fake") {
    provider = createFakeProvider();
  } else {
    console.error(`Unknown AEDM_LLM_PROVIDER "${kind}". Use fake or anthropic.`);
    process.exit(1);
  }

  const server = await createGameServer({ port, provider, saveDir, dataDir, config: { devLog: process.env.AEDM_DEV_LOG === "1" } });
  console.log(`AEDM server listening on ws://localhost:${server.port} (LLM provider: ${provider.name}, saves: ${saveDir}, accounts: ${join(dataDir, "accounts")})`);

  const stop = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err: unknown) => {
  console.error("Server failed to start:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
