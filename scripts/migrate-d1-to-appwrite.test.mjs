import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const migrationScript = fileURLToPath(new URL('./migrate-d1-to-appwrite.mjs', import.meta.url));

function runMigration(visibility, includeVisibility = true) {
  const pkg = {
    id: 'package-1',
    name: '@owner/example',
    normalized_name: '@owner/example',
    scope: 'owner',
    owner_user_id: 'user-1',
    description: null,
    readme: null,
    latest_version: null,
    deleted_at: null,
  };
  if (includeVisibility) pkg.visibility = visibility;

  return spawnSync(process.execPath, [migrationScript, '--stdin'], {
    encoding: 'utf8',
    input: JSON.stringify({ users: [], packages: [pkg], versions: [], tags: [], r2Proofs: [] }),
  });
}

test('accepts explicit public and private package visibility', () => {
  for (const visibility of ['public', 'private']) {
    const result = runMigration(visibility);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run complete/);
  }
});

test('fails closed when legacy visibility is missing or invalid', () => {
  for (const result of [runMigration(undefined, false), runMigration('unexpected')]) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing or invalid visibility; refusing to migrate it as public/);
  }
});
