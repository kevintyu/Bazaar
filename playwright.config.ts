import { defineConfig } from '@playwright/test';
process.loadEnvFile('.env.local');
if (process.env.NEXT_PUBLIC_SUPABASE_URL !== 'http://127.0.0.1:54321') {
  throw new Error('Integration tests require the disposable local Supabase project.');
}
export default defineConfig({
  testDir: './tests', timeout: 60_000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:3000', browserName: 'chromium' },
  webServer: {
    command: 'npm run start -- --hostname 127.0.0.1',
    url: 'http://127.0.0.1:3000/auth', reuseExistingServer: false,
  },
});
