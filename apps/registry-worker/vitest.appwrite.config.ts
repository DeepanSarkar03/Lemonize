import { defineConfig } from 'vitest/config';

/** Isolated unit suite for the fetch-only Appwrite layer (no Worker bootstrap). */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/appwrite.test.ts', 'test/public-appwrite.test.ts'],
  },
});
