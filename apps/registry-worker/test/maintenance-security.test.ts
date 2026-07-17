import { describe, expect, it } from 'vitest';
import { assertMaintainerIdentity, assertRegistryMutable } from '../src/lib/maintenance-security.js';

describe('maintenance capability boundaries', () => {
  it('blocks all metadata mutations while the registry is read-only', () => {
    expect(() => assertRegistryMutable('read_only')).toThrow();
    expect(() => assertRegistryMutable('invite_only')).not.toThrow();
  });

  it('blocks a publisher from maintaining an imported unscoped package', () => {
    expect(() =>
      assertMaintainerIdentity({
        role: 'publisher',
        userId: 'user-1',
        namespace: 'alice',
        packageOwnerId: 'user-1',
        packageScope: '',
      }),
    ).toThrow();
  });

  it('blocks a publisher from maintaining another namespace', () => {
    expect(() =>
      assertMaintainerIdentity({
        role: 'publisher',
        userId: 'user-1',
        namespace: 'alice',
        packageOwnerId: 'user-1',
        packageScope: 'bob',
      }),
    ).toThrow();
  });

  it('allows an owner to maintain packages in their verified namespace', () => {
    expect(() =>
      assertMaintainerIdentity({
        role: 'publisher',
        userId: 'user-1',
        namespace: 'Alice',
        packageOwnerId: 'user-1',
        packageScope: 'alice',
      }),
    ).not.toThrow();
  });

  it('retains explicit administrator remediation access', () => {
    expect(() =>
      assertMaintainerIdentity({
        role: 'admin',
        userId: 'admin-1',
        namespace: 'admin',
        packageOwnerId: 'user-1',
        packageScope: '',
      }),
    ).not.toThrow();
  });
});
