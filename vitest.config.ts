import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // API_TOKEN is a secret in production; supply a fixed one for tests.
        bindings: {
          API_TOKEN: "test-token",
          LOG_LEVEL: "error",
          RETENTION_SECONDS: "3600",
        },
      },
    }),
  ],
});
