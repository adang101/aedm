import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.vite/**", ".claude/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["packages/engine/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "Date", message: "Engine is deterministic: no Date." }],
      "no-restricted-properties": ["error", { object: "Math", property: "random", message: "Use the seeded RNG." }],
      "no-restricted-imports": ["error", { patterns: ["node:*", "fs", "path", "http", "ws"] }],
    },
  },
);
