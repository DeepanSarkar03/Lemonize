import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  parseDeployOutput,
  resolveReadyDeploymentId,
  verifyExactDeployment,
  verifyStableSnapshot,
} from './vercel-release-integrity.mjs';

const id = 'dpl_AbC123';
const hostname = 'lemonize-abc-team.vercel.app';
const url = `https://${hostname}`;
const projectId = 'prj_Lemonize';
const sha = 'a'.repeat(40);

const deployWorkflow = await readFile(
  new URL('../../.github/workflows/deploy.yml', import.meta.url),
  'utf8',
);

function inspect(overrides = {}) {
  return { id, url: hostname, readyState: 'READY', target: null, ...overrides };
}

function api(overrides = {}) {
  return {
    id,
    url: hostname,
    projectId,
    readyState: 'READY',
    target: null,
    meta: { githubCommitSha: sha, lemonizeReleaseSha: sha },
    ...overrides,
  };
}

test('parses direct and agent-wrapped JSON deploy output', () => {
  const deployment = { ...inspect(), url, target: 'production' };
  assert.deepEqual(parseDeployOutput(deployment, 'production'), { id, url });
  assert.deepEqual(parseDeployOutput({ status: 'ok', deployment }, 'production'), { id, url });
});

test('accepts a preview deployment with a null target', () => {
  assert.deepEqual(parseDeployOutput({ ...inspect(), url }, 'preview'), {
    id,
    url,
  });
});

test('rejects malformed, non-ready, aliased, or wrongly targeted deploy output', () => {
  assert.throws(
    () => parseDeployOutput({ ...inspect(), id: 'bad', url }, 'preview'),
    /valid deployment ID/,
  );
  assert.throws(
    () => parseDeployOutput({ ...inspect(), url, readyState: 'BUILDING' }, 'preview'),
    /not ready/,
  );
  assert.throws(
    () => parseDeployOutput({ ...inspect(), url: 'https://lemonize.cyou' }, 'preview'),
    /exact HTTPS Vercel deployment URL/,
  );
  assert.throws(() => parseDeployOutput({ ...inspect(), url }, 'production'), /wrong target/);
});

test('snapshots only a ready deployment in the expected project', () => {
  assert.equal(verifyStableSnapshot(inspect(), api(), projectId), id);
  assert.throws(
    () => verifyStableSnapshot(inspect(), api({ projectId: 'prj_Other' }), projectId),
    /different Vercel project/,
  );
  assert.throws(
    () => verifyStableSnapshot(inspect(), api({ url: 'other.vercel.app' }), projectId),
    /hostname do not match/,
  );
});

test('binds an exact deployment ID, URL, project, target, and SHA', () => {
  assert.doesNotThrow(() =>
    verifyExactDeployment({
      inspectPayload: inspect({ target: 'production' }),
      apiPayload: api({ target: 'production' }),
      expectedId: id,
      expectedUrl: url,
      expectedProjectId: projectId,
      expectedSha: sha,
      deployEnvironment: 'production',
    }),
  );
});

test('rejects exact-deployment identity and commit drift', () => {
  const base = {
    inspectPayload: inspect(),
    apiPayload: api(),
    expectedId: id,
    expectedUrl: url,
    expectedProjectId: projectId,
    expectedSha: sha,
    deployEnvironment: 'staging',
  };
  assert.throws(
    () => verifyExactDeployment({ ...base, inspectPayload: inspect({ id: 'dpl_Other' }) }),
    /did not resolve to the deployed ID/,
  );
  assert.throws(
    () => verifyExactDeployment({ ...base, apiPayload: api({ projectId: 'prj_Other' }) }),
    /different Vercel project/,
  );
  assert.throws(
    () =>
      verifyExactDeployment({
        ...base,
        apiPayload: api({
          meta: { githubCommitSha: 'b'.repeat(40), lemonizeReleaseSha: sha },
        }),
      }),
    /metadata does not match/,
  );
  assert.throws(
    () => verifyExactDeployment({ ...base, apiPayload: api({ target: 'production' }) }),
    /staging deployment unexpectedly/,
  );
});

test('resolves only ready, well-formed deployment IDs', () => {
  assert.equal(resolveReadyDeploymentId(inspect()), id);
  assert.throws(() => resolveReadyDeploymentId(inspect({ readyState: 'ERROR' })), /not ready/);
});

test('runs every Vercel operation from the repository root', () => {
  const cwdArguments = [...deployWorkflow.matchAll(/--cwd\s+(?:"[^"]+"|\S+)/g)].map(
    ([argument]) => argument,
  );
  assert.ok(cwdArguments.length > 0, 'deployment workflow has no checked Vercel working directory');
  assert.deepEqual(new Set(cwdArguments), new Set(['--cwd "$GITHUB_WORKSPACE"']));
});
