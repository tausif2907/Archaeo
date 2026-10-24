import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a running stack (`docker compose up -d && pnpm dev`) with the demo repo
 * already ingested. Override with E2E_BASE_URL / E2E_API_URL / E2E_REPO_URL.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
