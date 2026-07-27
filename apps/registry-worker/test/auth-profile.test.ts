import { describe, expect, it } from 'vitest';
import { clerkGithubId } from '../src/lib/auth.js';

describe('Clerk GitHub external account compatibility', () => {
  it('reads the current provider_user_id shape', () => {
    expect(clerkGithubId({ provider_user_id: 'github-current-42' })).toBe(
      'github-current-42',
    );
  });

  it('falls back to the legacy external_id shape', () => {
    expect(clerkGithubId({ external_id: 'github-legacy-42' })).toBe('github-legacy-42');
    expect(
      clerkGithubId({ provider_user_id: null, external_id: 'github-legacy-42' }),
    ).toBe('github-legacy-42');
  });

  it('prefers provider_user_id when both fields are present', () => {
    expect(
      clerkGithubId({
        provider_user_id: 'github-current-42',
        external_id: 'github-legacy-42',
      }),
    ).toBe('github-current-42');
  });

  it.each([
    ['missing account', undefined],
    ['null account', null],
    ['non-object account', 'github-42'],
    ['array account', []],
    ['missing ids', {}],
    ['null current id', { provider_user_id: null }],
    ['empty current id', { provider_user_id: '' }],
    ['oversized current id', { provider_user_id: 'g'.repeat(129) }],
    ['non-string current id', { provider_user_id: 42 }],
    ['null legacy id', { external_id: null }],
    ['empty legacy id', { external_id: '' }],
    ['oversized legacy id', { external_id: 'g'.repeat(129) }],
    ['non-string legacy id', { external_id: 42 }],
  ])('rejects %s', (_label, account) => {
    expect(clerkGithubId(account)).toBeNull();
  });

  it('does not downgrade to the legacy field when a preferred value is invalid', () => {
    expect(clerkGithubId({ provider_user_id: '', external_id: 'github-legacy-42' })).toBeNull();
  });

  it('preserves the existing nonempty 128-character boundary', () => {
    const id = 'g'.repeat(128);
    expect(clerkGithubId({ provider_user_id: id })).toBe(id);
  });
});
