import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          NPM_ORIGIN_PER_IP_MINUTE: '3',
          NPM_ORIGIN_GLOBAL_MINUTE: '5',
          NPM_ORIGIN_GLOBAL_DAY: '10',
          NPM_ORIGIN_METADATA_MINUTE: '5',
          NPM_ORIGIN_METADATA_DAY: '10',
          NPM_ORIGIN_SEARCH_MINUTE: '2',
          NPM_ORIGIN_SEARCH_DAY: '4',
          NPM_ORIGIN_AUDIT_MINUTE: '2',
          NPM_ORIGIN_AUDIT_DAY: '4',
          NPM_ORIGIN_TARBALL_MINUTE: '2',
          NPM_ORIGIN_TARBALL_DAY: '4',
        },
      },
    }),
  ],
});
