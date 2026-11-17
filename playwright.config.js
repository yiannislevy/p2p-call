import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 120000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  webServer: {
    command: 'node tests/serve.mjs',
    url: 'http://localhost:8800/meta.json',
    reuseExistingServer: !process.env.CI,
    timeout: 60000
  },
  use: {
    baseURL: 'http://localhost:8800',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: process.env.CHROME_PATH || undefined,
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required'
      ]
    }
  }
});
