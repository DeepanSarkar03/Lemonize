import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { lem: 'src/lem.ts', lemx: 'src/lemx.ts' },
  format: ['esm'],
  target: 'node24',
  noExternal: ['@lemonize/package-format', '@lemonize/shared'],
  clean: true,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
});
