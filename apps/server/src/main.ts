import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderFromEnv, type ModelProvider } from "@aedm/llm";
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
  const dataDir = process.env.AEDM_DATA_DIR ? resolve(process.env.AEDM_DATA_DIR) : join(REPO_ROOT, "data");
  const saveDir = process.env.AEDM_SAVE_DIR ?? join(dataDir, "saves");

  let provider: ModelProvider;
  try {
    provider = createProviderFromEnv(process.env); // keys are read from the environment and never logged
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err), "Set it in .env.");
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
