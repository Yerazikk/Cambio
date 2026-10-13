import { defineConfig, devices } from "@playwright/test";

const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  /**
   * Rooms live in the server's memory, so the suite shares real state. One
   * worker keeps tables from colliding and keeps snap-race timings honest.
   */
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
    video: process.env.CI ? "retain-on-failure" : "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node server/dist/index.js",
    env: { PORT: String(PORT) },
    url: `${BASE}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
