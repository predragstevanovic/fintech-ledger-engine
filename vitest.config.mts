import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: [
        "src/core/ledger/split.calculator.ts",
        "src/core/ledger/ledger.rules.ts",
        "src/core/ledger/payment.posting.ts",
        "src/core/reconciliation/reconciliation.matcher.ts",
        "src/core/idempotency/idempotency.service.ts",
        "src/lib/money.ts",
        "src/lib/hmac.ts",
      ],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
      reporter: ["text", "json-summary"],
    },
  },
});
