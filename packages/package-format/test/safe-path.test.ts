import { describe, it, expect } from 'vitest';
import { isSafeEntryPath, isUnderPackageRoot } from '../src/safe-path.js';

describe('isSafeEntryPath', () => {
  it('accepts normal package paths', () => {
    expect(isSafeEntryPath('package/dist/index.js')).toBe(true);
    expect(isSafeEntryPath('package/package.json')).toBe(true);
    expect(isSafeEntryPath('package/dist..backup/index.js')).toBe(true);
    expect(isSafeEntryPath('package/..safe/index.js')).toBe(true);
  });

  it('rejects raw traversal segments before path normalization', () => {
    expect(isSafeEntryPath('../etc/passwd')).toBe(false);
    expect(isSafeEntryPath('package/../../secret')).toBe(false);
    expect(isSafeEntryPath('package/a/../secret')).toBe(false);
    expect(isSafeEntryPath('package/.. /secret')).toBe(false);
    expect(isSafeEntryPath('package/．．/secret')).toBe(false);
  });

  it('rejects encoded traversal, separators, and drive paths', () => {
    expect(isSafeEntryPath('package/%2e%2e/secret')).toBe(false);
    expect(isSafeEntryPath('package/%252e%252e/secret')).toBe(false);
    expect(isSafeEntryPath('package/%2e%2e%20/secret')).toBe(false);
    expect(isSafeEntryPath('package%2f%2e%2e%2fsecret')).toBe(false);
    expect(isSafeEntryPath('package%5c..%5csecret')).toBe(false);
    expect(isSafeEntryPath('C%3a%2ftemp%2fsecret')).toBe(false);
  });

  it('rejects absolute, drive-relative, backslash, and NUL paths', () => {
    expect(isSafeEntryPath('/etc/passwd')).toBe(false);
    expect(isSafeEntryPath('C:secret')).toBe(false);
    expect(isSafeEntryPath('C:\\windows\\system32')).toBe(false);
    expect(isSafeEntryPath('package\\dist\\index.js')).toBe(false);
    expect(isSafeEntryPath('package/\0evil')).toBe(false);
  });
});

describe('isUnderPackageRoot', () => {
  it('requires the package/ prefix', () => {
    expect(isUnderPackageRoot('package/x')).toBe(true);
    expect(isUnderPackageRoot('other/x')).toBe(false);
  });
});
