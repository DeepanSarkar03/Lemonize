import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePackageScopeGrantsJson } from './package-scope-grants.mjs';

test('canonicalizes strict deployment package-scope grants', () => {
  assert.equal(normalizePackageScopeGrantsJson('[]'), '[]');
  assert.equal(
    normalizePackageScopeGrantsJson(
      JSON.stringify([{ scope: 'staging-team', githubId: 'github-42' }]),
    ),
    '[{"scope":"staging-team","githubId":"github-42"}]',
  );
});

test('rejects invalid deployment package-scope grants', () => {
  for (const value of [
    undefined,
    '',
    '   ',
    '{',
    '{}',
    JSON.stringify([{ scope: 'team_name', githubId: 'github-42' }]),
    JSON.stringify([{ scope: 'admin', githubId: 'github-42' }]),
    JSON.stringify([{ scope: 'team', githubId: 'github-42', extra: true }]),
    JSON.stringify([
      { scope: 'team', githubId: 'github-42' },
      { scope: 'team', githubId: 'github-43' },
    ]),
  ]) {
    assert.throws(() => normalizePackageScopeGrantsJson(value));
  }
});
