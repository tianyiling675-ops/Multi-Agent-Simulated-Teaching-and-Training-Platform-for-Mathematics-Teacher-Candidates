import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/tests',
  testMatch: ['**/teacher-classroom.spec.ts', '**/teacher-training*.spec.ts'],
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    channel: 'msedge',
    baseURL: 'http://localhost:3013',
    navigationTimeout: 120_000,
    actionTimeout: 20000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      '"' +
      process.execPath +
      '" --max-old-space-size=6144 node_modules/next/dist/bin/next dev --webpack -p 3013',
    // Wait for storage and the API bundle too, before the first UI action.
    url: 'http://localhost:3013/api/teacher-training/capabilities',
    timeout: 240_000,
    reuseExistingServer: process.env.TEACHER_TRAINING_ACCEPTANCE_REUSE === '1',
    env: {
      NODE_OPTIONS: '--max-old-space-size=6144',
      DATABASE_URL: '',
      TEACHER_TRAINING_TEST_DIST: '.next-training-acceptance',
      TEACHER_TRAINING_SQLITE_PATH: 'data/teacher-classroom-acceptance.sqlite',
      TEACHER_TRAINING_ALLOW_LOCAL: '1',
      NEXT_PUBLIC_MAIC_EDITOR_ENABLED: 'true',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
