import { defineConfig } from "@playwright/test";
import { getPorts } from "./packages/config/src/ports.js";

const ports = getPorts();
const serverEnv = {
  SMA_WEB_PORT: String(ports.e2eWeb),
  SMA_API_PORT: String(ports.e2eApi),
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${ports.e2eWeb}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npm run dev:api",
      url: `http://127.0.0.1:${ports.e2eApi}/api/health`,
      env: serverEnv,
      reuseExistingServer: false,
    },
    {
      command: "npm run dev:web",
      url: `http://127.0.0.1:${ports.e2eWeb}`,
      env: serverEnv,
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // Optional: reuse a preinstalled browser (e.g. in cloud containers).
        launchOptions: process.env.SMA_CHROMIUM_PATH
          ? { executablePath: process.env.SMA_CHROMIUM_PATH }
          : {},
      },
    },
  ],
});
