import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  testIgnore: process.env.SHOTS ? [] : ['**/screenshots.spec.ts'],
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5199',
    permissions: ['clipboard-read', 'clipboard-write'],
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'pnpm build && SPARKMAN_AGENT_FAKE=1 SPARKMAN_ALLOW_BYPASS=1 SPARKMAN_FAKE_DELAY_MS=30 SPARKMAN_PORT=5199 tsx server/index.ts',
    url: 'http://127.0.0.1:5199/api/agent/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
