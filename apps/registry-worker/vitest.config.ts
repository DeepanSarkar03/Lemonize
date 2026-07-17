import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Remote provider credentials are never used by tests. These values
        // make missing-secret paths explicit while KV and R2 stay local.
        bindings: {
          APPWRITE_API_KEY: 'test-appwrite-key',
          CLERK_SECRET_KEY: 'test-clerk-key',
          SCANNER_SHARED_SECRET: 'test-scanner-secret-at-least-32-bytes',
        },
      },
    }),
  ],
});
