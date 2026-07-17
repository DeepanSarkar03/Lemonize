import { describe, it, expect } from 'vitest';
import { resolveVersion, parseInstallTarget, isGreater, maxStable } from '../src/semver.js';

const versions = ['1.0.0', '1.1.0', '1.2.0', '2.0.0-beta.1', '2.0.0'];

describe('resolveVersion', () => {
  it('resolves latest via dist-tag then max stable', () => {
    expect(resolveVersion('latest', versions, { latest: '1.2.0' })).toBe('1.2.0');
    expect(resolveVersion('latest', versions, {})).toBe('2.0.0');
  });
  it('resolves dist-tag aliases', () => {
    expect(resolveVersion('beta', versions, { beta: '2.0.0-beta.1' })).toBe('2.0.0-beta.1');
  });
  it('resolves exact versions', () => {
    expect(resolveVersion('1.1.0', versions)).toBe('1.1.0');
    expect(resolveVersion('9.9.9', versions)).toBeNull();
  });
  it('resolves caret and tilde ranges to max satisfying stable', () => {
    expect(resolveVersion('^1.0.0', versions)).toBe('1.2.0');
    expect(resolveVersion('~1.1.0', versions)).toBe('1.1.0');
    expect(resolveVersion('>=1.0.0 <2.0.0', versions)).toBe('1.2.0');
  });
  it('excludes prereleases from ranges', () => {
    expect(resolveVersion('^2.0.0', versions)).toBe('2.0.0');
  });
  it('returns null for garbage', () => {
    expect(resolveVersion('not-a-range', versions)).toBeNull();
  });
});

describe('parseInstallTarget', () => {
  it('parses unscoped', () => {
    expect(parseInstallTarget('react@^18')).toEqual({ name: 'react', spec: '^18' });
    expect(parseInstallTarget('react')).toEqual({ name: 'react', spec: 'latest' });
  });
  it('parses scoped', () => {
    expect(parseInstallTarget('@deepan/utils@1.2.3')).toEqual({ name: '@deepan/utils', spec: '1.2.3' });
    expect(parseInstallTarget('@deepan/utils')).toEqual({ name: '@deepan/utils', spec: 'latest' });
  });

  it('parses the slash version syntax (name/version)', () => {
    expect(parseInstallTarget('stape-cli/latest')).toEqual({ name: 'stape-cli', spec: 'latest' });
    expect(parseInstallTarget('stape-cli/1.2.0')).toEqual({ name: 'stape-cli', spec: '1.2.0' });
    expect(parseInstallTarget('stape-cli')).toEqual({ name: 'stape-cli', spec: 'latest' });
  });

  it('parses scoped names with the slash version syntax', () => {
    expect(parseInstallTarget('@deepan/utils/latest')).toEqual({ name: '@deepan/utils', spec: 'latest' });
    expect(parseInstallTarget('@deepan/utils/2.0.0-beta.1')).toEqual({
      name: '@deepan/utils',
      spec: '2.0.0-beta.1',
    });
  });

  it('keeps the @ syntax working alongside the slash syntax', () => {
    expect(parseInstallTarget('react@^18')).toEqual({ name: 'react', spec: '^18' });
    expect(parseInstallTarget('@deepan/utils@1.2.3')).toEqual({ name: '@deepan/utils', spec: '1.2.3' });
  });
});

describe('helpers', () => {
  it('isGreater compares', () => {
    expect(isGreater('2.0.0', '1.9.9')).toBe(true);
    expect(isGreater('1.0.0', '1.0.0')).toBe(false);
  });
  it('maxStable ignores prereleases', () => {
    expect(maxStable(versions)).toBe('2.0.0');
    expect(maxStable(['2.0.0-beta.1'])).toBeNull();
  });
});
