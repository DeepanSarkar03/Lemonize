import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdPublish } from '../src/commands.js';
import { configureLogger } from '../src/lib/logger.js';

describe('publish --dry-run', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it('previews the deterministic package file list without credentials', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'lem-dry-run-'));
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'dry-run-fixture', version: '1.0.0', files: ['z.js', 'a.js'] }),
    );
    writeFileSync(join(cwd, 'z.js'), 'export const z = true;\n');
    writeFileSync(join(cwd, 'a.js'), 'export const a = true;\n');
    process.chdir(cwd);
    configureLogger({ color: false, json: false, verbose: false });
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(String(line)));

    await expect(cmdPublish({ dryRun: true })).resolves.toBeUndefined();

    const aIndex = output.findIndex((line) => line.trim() === 'a.js');
    const zIndex = output.findIndex((line) => line.trim() === 'z.js');
    expect(output).toContain('  Files:');
    expect(aIndex).toBeGreaterThan(-1);
    expect(zIndex).toBeGreaterThan(aIndex);
    expect(output.some((line) => line.includes('Dry run complete'))).toBe(true);
  });
});
