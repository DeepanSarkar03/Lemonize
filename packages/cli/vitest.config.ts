import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CLI tests intentionally exercise the real content-addressed cache. Test
    // files must not delete that shared cache while another file is using it.
    fileParallelism: false,
  },
});
