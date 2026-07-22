import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_VERSION } from '../src/version.js';

describe('CLI version', () => {
  it('matches the published package version', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };

    expect(CLI_VERSION).toBe(packageJson.version);
  });
});
