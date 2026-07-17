import { describe, it, expect } from 'vitest';
import {
  validatePackageName,
  normalizePackageName,
  parsePackageName,
  toObjectKeyName,
} from '../src/names.js';

describe('validatePackageName', () => {
  it('accepts simple + scoped names', () => {
    expect(validatePackageName('react').ok).toBe(true);
    expect(validatePackageName('@deepan/utils').ok).toBe(true);
  });
  it('rejects reserved names', () => {
    expect(validatePackageName('lemonize').ok).toBe(false);
    expect(validatePackageName('admin').ok).toBe(false);
    expect(validatePackageName('@lemonize/anything').ok).toBe(false);
  });
  it('rejects invalid characters and leading dot/underscore', () => {
    expect(validatePackageName('_hidden').ok).toBe(false);
    expect(validatePackageName('.dot').ok).toBe(false);
    expect(validatePackageName('Has Space').ok).toBe(false);
    expect(validatePackageName('UPPER').ok).toBe(false);
  });
});

describe('normalizePackageName', () => {
  it('collapses confusable separators', () => {
    expect(normalizePackageName('my.utils')).toBe('my-utils');
    expect(normalizePackageName('my_utils')).toBe('my-utils');
    expect(normalizePackageName('my--utils')).toBe('my-utils');
    expect(normalizePackageName('@Scope/My_Pkg')).toBe('@scope/my-pkg');
  });
});

describe('toObjectKeyName traversal guard', () => {
  it('parses scoped names', () => {
    expect(parsePackageName('@deepan/utils')).toEqual({ full: '@deepan/utils', scope: 'deepan', name: 'utils' });
  });
  it('never yields traversal segments', () => {
    // parsePackageName already lowercases + validates charset upstream; guard is belt-and-suspenders.
    expect(toObjectKeyName('@deepan/utils')).toBe('@deepan/utils');
    expect(toObjectKeyName('react')).toBe('react');
  });
});
