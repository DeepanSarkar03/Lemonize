import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(message);
}

function asDeployment(payload, source) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail(`${source} is not a JSON object`);
  }
  const deployment = payload.deployment ?? payload;
  if (!deployment || typeof deployment !== 'object' || Array.isArray(deployment)) {
    fail(`${source} does not contain a deployment object`);
  }
  return deployment;
}

function assertDeploymentId(value, source) {
  if (typeof value !== 'string' || !DEPLOYMENT_ID.test(value)) {
    fail(`${source} does not contain a valid deployment ID`);
  }
  return value;
}

function assertReady(deployment, source) {
  if (deployment.readyState !== 'READY') {
    fail(`${source} deployment is not ready`);
  }
}

function exactDeploymentUrl(value, source) {
  if (typeof value !== 'string') {
    fail(`${source} does not contain a deployment URL`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${source} deployment URL is invalid`);
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.vercel.app') ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    fail(`${source} is not an exact HTTPS Vercel deployment URL`);
  }
  return url.href.slice(0, -1);
}

function assertApiDeployment(deployment, expectedId, expectedProjectId, source) {
  if (assertDeploymentId(deployment.id, source) !== expectedId) {
    fail(`${source} deployment ID does not match`);
  }
  if (deployment.projectId !== expectedProjectId) {
    fail(`${source} deployment belongs to a different Vercel project`);
  }
  assertReady(deployment, source);
}

export function parseDeployOutput(payload, expectedTarget) {
  if (expectedTarget !== 'production' && expectedTarget !== 'preview') {
    fail('Expected Vercel target must be production or preview');
  }
  const deployment = asDeployment(payload, 'Vercel deploy output');
  const id = assertDeploymentId(deployment.id, 'Vercel deploy output');
  const url = exactDeploymentUrl(deployment.url, 'Vercel deploy output');
  assertReady(deployment, 'Vercel deploy output');
  if (expectedTarget === 'production' && deployment.target !== 'production') {
    fail('Vercel production deployment has the wrong target');
  }
  if (
    expectedTarget === 'preview' &&
    deployment.target !== null &&
    deployment.target !== undefined &&
    deployment.target !== 'preview'
  ) {
    fail('Vercel preview deployment has the wrong target');
  }
  return { id, url };
}

export function verifyStableSnapshot(inspectPayload, apiPayload, expectedProjectId) {
  const inspected = asDeployment(inspectPayload, 'Vercel inspect output');
  const deployment = asDeployment(apiPayload, 'Vercel deployment API response');
  const id = assertDeploymentId(inspected.id, 'Vercel inspect output');
  assertReady(inspected, 'Vercel inspect output');
  assertApiDeployment(deployment, id, expectedProjectId, 'Vercel deployment API response');
  if (inspected.url !== deployment.url) {
    fail('Stable inspect result and deployment API hostname do not match');
  }
  return id;
}

export function verifyExactDeployment({
  inspectPayload,
  apiPayload,
  expectedId,
  expectedUrl,
  expectedProjectId,
  expectedSha,
  deployEnvironment,
}) {
  if (deployEnvironment !== 'production' && deployEnvironment !== 'staging') {
    fail('Deployment environment must be production or staging');
  }
  if (!COMMIT_SHA.test(expectedSha)) {
    fail('Expected release SHA is not a lowercase full commit SHA');
  }
  assertDeploymentId(expectedId, 'Expected release');
  const expectedHostname = new URL(exactDeploymentUrl(expectedUrl, 'Expected release')).hostname;
  const inspected = asDeployment(inspectPayload, 'Vercel inspect output');
  const deployment = asDeployment(apiPayload, 'Vercel deployment API response');

  if (assertDeploymentId(inspected.id, 'Vercel inspect output') !== expectedId) {
    fail('Exact deployment URL did not resolve to the deployed ID');
  }
  assertReady(inspected, 'Vercel inspect output');
  assertApiDeployment(deployment, expectedId, expectedProjectId, 'Vercel deployment API response');
  if (inspected.url !== expectedHostname || deployment.url !== expectedHostname) {
    fail('Exact deployment hostname does not match the deployed ID');
  }
  if (
    deployment.meta?.githubCommitSha !== expectedSha ||
    deployment.meta?.lemonizeReleaseSha !== expectedSha
  ) {
    fail('Exact deployment metadata does not match the checked-out commit');
  }
  if (deployEnvironment === 'production' && deployment.target !== 'production') {
    fail('Exact production deployment has the wrong Vercel target');
  }
  if (deployEnvironment === 'staging' && deployment.target === 'production') {
    fail('Exact staging deployment unexpectedly has the production target');
  }
}

export function resolveReadyDeploymentId(inspectPayload) {
  const deployment = asDeployment(inspectPayload, 'Vercel inspect output');
  const id = assertDeploymentId(deployment.id, 'Vercel inspect output');
  assertReady(deployment, 'Vercel inspect output');
  return id;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function requireArgumentCount(command, args, expected) {
  if (args.length !== expected) {
    fail(`${command} expects ${expected} arguments, received ${args.length}`);
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'deploy-output': {
      requireArgumentCount(command, args, 2);
      const result = parseDeployOutput(readJson(args[0]), args[1]);
      process.stdout.write(`${result.id}\n${result.url}\n`);
      return;
    }
    case 'snapshot': {
      requireArgumentCount(command, args, 3);
      const id = verifyStableSnapshot(readJson(args[0]), readJson(args[1]), args[2]);
      process.stdout.write(id);
      return;
    }
    case 'exact': {
      requireArgumentCount(command, args, 7);
      verifyExactDeployment({
        inspectPayload: readJson(args[0]),
        apiPayload: readJson(args[1]),
        expectedId: args[2],
        expectedUrl: args[3],
        expectedProjectId: args[4],
        expectedSha: args[5],
        deployEnvironment: args[6],
      });
      return;
    }
    case 'resolved-id': {
      requireArgumentCount(command, args, 1);
      process.stdout.write(resolveReadyDeploymentId(readJson(args[0])));
      return;
    }
    default:
      fail(
        'Usage: vercel-release-integrity.mjs ' + '<deploy-output|snapshot|exact|resolved-id> ...',
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
