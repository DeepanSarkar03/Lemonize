import { createHash, createHmac } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extract } from 'tar';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const ARTIFACT_HANDOFF_ERROR = 'Build produced no output artifact.';
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_BUILD_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_FILES = 256;
const CHALLENGE_PATH = '/__lemonize_secret_challenge';
const CHALLENGE_BODY = '{}';

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} response is not an object`);
  }
  return value;
}

function sameStringSet(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    new Set(value).size === value.length &&
    expected.every((item) => value.includes(item))
  );
}

export function verifyScannerFunctionConfiguration(functionPayload, functionId) {
  const fn = requireObject(functionPayload, 'Function');
  if (!ID_PATTERN.test(functionId)) {
    throw new Error('Function ID must be a valid Appwrite ID');
  }
  if (
    fn.$id !== functionId ||
    fn.name !== 'Lemonize artifact scanner' ||
    fn.enabled !== true ||
    fn.logging !== true ||
    fn.runtime !== 'node-25' ||
    fn.timeout !== 60 ||
    fn.entrypoint !== 'dist/main.js' ||
    fn.commands !== 'node --check dist/main.js' ||
    fn.schedule !== '' ||
    fn.deploymentRetention !== 3 ||
    !sameStringSet(fn.scopes, ['files.read', 'files.write']) ||
    !sameStringSet(fn.execute, []) ||
    !sameStringSet(fn.events, []) ||
    fn.installationId !== '' ||
    fn.providerRepositoryId !== '' ||
    fn.providerBranch !== '' ||
    fn.providerSilentMode !== false ||
    fn.providerRootDirectory !== '' ||
    !sameStringSet(fn.providerBranches, []) ||
    !sameStringSet(fn.providerPaths, [])
  ) {
    throw new Error('The scanner function configuration has drifted');
  }
  return functionId;
}

export function verifyScannerFunctionState(functionPayload, expectedDeploymentId, functionId) {
  const fn = requireObject(functionPayload, 'Function');
  if (!ID_PATTERN.test(expectedDeploymentId) || !ID_PATTERN.test(functionId)) {
    throw new Error('Fallback deployment and function IDs must be valid Appwrite IDs');
  }
  verifyScannerFunctionConfiguration(fn, functionId);
  if (fn.deploymentId !== expectedDeploymentId) {
    throw new Error('The expected fallback is not the function active deployment');
  }
  if (fn.live !== true) {
    throw new Error('The active scanner function configuration has drifted');
  }
  return expectedDeploymentId;
}

function verifyIdentity(functionPayload, deploymentPayload, expectedDeploymentId, functionId) {
  verifyScannerFunctionState(functionPayload, expectedDeploymentId, functionId);
  const deployment = requireObject(deploymentPayload, 'Deployment');
  if (
    deployment.$id !== expectedDeploymentId ||
    deployment.resourceId !== functionId ||
    deployment.resourceType !== 'functions' ||
    deployment.status !== 'ready' ||
    deployment.entrypoint !== 'dist/main.js' ||
    !Number.isSafeInteger(deployment.sourceSize) ||
    deployment.sourceSize <= 0 ||
    deployment.sourceSize > MAX_SOURCE_BYTES ||
    !Number.isSafeInteger(deployment.buildSize) ||
    deployment.buildSize <= 0 ||
    deployment.buildSize > MAX_BUILD_BYTES
  ) {
    throw new Error('The fallback scanner deployment is not a complete ready build');
  }
}

export function isExactArtifactHandoffFailure(value) {
  const payload = requireObject(value, 'Deployment');
  if (typeof payload.buildLogs !== 'string') return false;
  const lines = payload.buildLogs
    // eslint-disable-next-line no-control-regex -- Appwrite build logs can contain ANSI SGR sequences.
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) === ARTIFACT_HANDOFF_ERROR;
}

export function verifyScannerVariables({
  functionVariablesPayload,
  projectVariablesPayload,
  functionId,
  registryUrl,
  quarantineBucketId,
  maxArchiveBytes,
  maxPackageFiles,
}) {
  if (!ID_PATTERN.test(functionId)) throw new Error('Scanner function ID is invalid');
  const functionVariables = requireObject(functionVariablesPayload, 'Function variables');
  const projectVariables = requireObject(projectVariablesPayload, 'Project variables');
  if (
    projectVariables.total !== 0 ||
    !Array.isArray(projectVariables.variables) ||
    projectVariables.variables.length !== 0
  ) {
    throw new Error('Project-level Appwrite variables are not allowed for the scanner project');
  }

  const expected = new Map([
    ['REGISTRY_INTERNAL_URL', { value: registryUrl, secret: false }],
    ['SCAN_SIGNING_SECRET', { value: null, secret: true }],
    ['APPWRITE_QUARANTINE_BUCKET_ID', { value: quarantineBucketId, secret: false }],
    ['MAX_ARCHIVE_BYTES', { value: maxArchiveBytes, secret: false }],
    ['MAX_PACKAGE_FILES', { value: maxPackageFiles, secret: false }],
    ['MAX_SIGNATURE_AGE_SECONDS', { value: '300', secret: false }],
  ]);
  if (
    functionVariables.total !== expected.size ||
    !Array.isArray(functionVariables.variables) ||
    functionVariables.variables.length !== expected.size
  ) {
    throw new Error('Scanner function variables do not match the exact allowlist');
  }

  const seen = new Set();
  for (const variable of functionVariables.variables) {
    const item = requireObject(variable, 'Function variable');
    const desired = expected.get(item.key);
    if (
      !desired ||
      seen.has(item.key) ||
      item.resourceType !== 'function' ||
      item.resourceId !== functionId ||
      item.secret !== desired.secret ||
      (desired.secret ? item.value != null : item.value !== desired.value)
    ) {
      throw new Error('Scanner function variables do not match the exact allowlist');
    }
    seen.add(item.key);
  }
  return functionId;
}

export function scannerChallengeHeaders(secret, now = new Date()) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Scanner challenge secret is missing or too short');
  }
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  const digest = createHash('sha256').update(CHALLENGE_BODY).digest('hex');
  const canonical = `v1:${timestamp}:POST:${CHALLENGE_PATH}:${digest}`;
  const signature = createHmac('sha256', secret).update(canonical).digest('hex');
  return {
    'content-type': 'application/json',
    'x-lemonize-timestamp': timestamp,
    'x-lemonize-signature': `v1=${signature}`,
  };
}

export function verifyScannerChallenge(executionPayload, expectedDeploymentId) {
  const execution = requireObject(executionPayload, 'Scanner challenge execution');
  let responseBody;
  try {
    responseBody = JSON.parse(execution.responseBody);
  } catch {
    throw new Error('Scanner challenge returned malformed JSON');
  }
  if (
    !ID_PATTERN.test(expectedDeploymentId) ||
    execution.status !== 'completed' ||
    execution.deploymentId !== expectedDeploymentId ||
    execution.requestMethod !== 'POST' ||
    execution.requestPath !== CHALLENGE_PATH ||
    execution.responseStatusCode !== 400 ||
    JSON.stringify(responseBody) !== JSON.stringify({ ok: false, error: { code: 'invalid_job' } })
  ) {
    throw new Error('Scanner secret challenge did not prove the active deployment');
  }
  return expectedDeploymentId;
}

async function fileManifest(root) {
  const result = new Map();
  let totalBytes = 0;

  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Scanner source archives may not contain links');
      if (stat.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error('Scanner source archives may contain only files');
      totalBytes += stat.size;
      if (result.size >= MAX_SOURCE_FILES || totalBytes > MAX_SOURCE_BYTES) {
        throw new Error('Scanner source exceeds the fallback verification limits');
      }
      const name = relative(root, absolute).split(sep).join('/');
      result.set(
        name,
        createHash('sha256')
          .update(await readFile(absolute))
          .digest('hex'),
      );
    }
  }

  await visit(root);
  return result;
}

function normalizedDownloadedManifest(extractedManifest) {
  const packageFiles = [...extractedManifest.keys()].filter(
    (name) => name === 'package.json' || name.endsWith('/package.json'),
  );
  if (packageFiles.length !== 1) {
    throw new Error('Downloaded scanner source must contain exactly one package.json');
  }
  const prefix = dirname(packageFiles[0]) === '.' ? '' : `${dirname(packageFiles[0])}/`;
  const normalized = new Map();
  for (const [name, digest] of extractedManifest) {
    if (!name.startsWith(prefix)) {
      throw new Error('Downloaded scanner source contains files outside its package root');
    }
    normalized.set(name.slice(prefix.length), digest);
  }
  return normalized;
}

function compareManifests(candidate, downloaded) {
  for (const required of ['package.json', 'dist/main.js']) {
    if (!candidate.has(required)) throw new Error(`Candidate scanner is missing ${required}`);
  }
  if (candidate.size !== downloaded.size) {
    throw new Error('Fallback scanner source file set does not match the candidate');
  }
  for (const [name, digest] of candidate) {
    if (downloaded.get(name) !== digest) {
      throw new Error(`Fallback scanner source differs from the candidate at ${name}`);
    }
  }
}

export async function verifyScannerFallback({
  functionPayload,
  deploymentPayload,
  expectedDeploymentId,
  functionId,
  candidateDirectory,
  sourceArchive,
}) {
  verifyIdentity(functionPayload, deploymentPayload, expectedDeploymentId, functionId);
  const candidateRoot = resolve(candidateDirectory);
  const archivePath = resolve(sourceArchive);
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile() || archiveStat.size <= 0 || archiveStat.size > MAX_SOURCE_BYTES) {
    throw new Error('Downloaded scanner source archive has an invalid size');
  }
  const extractionRoot = await mkdtemp(join(tmpdir(), 'lemonize-scanner-fallback-'));
  try {
    let archiveFiles = 0;
    let archiveBytes = 0;
    let archiveViolation = null;
    await extract({
      cwd: extractionRoot,
      file: archivePath,
      preservePaths: false,
      strict: true,
      onwarn(code) {
        archiveViolation ??= new Error(`Scanner source archive was rejected: ${code}`);
      },
      filter(path, entry) {
        const normalized = path.replaceAll('\\', '/');
        if (
          normalized.startsWith('/') ||
          /^[A-Za-z]:/.test(normalized) ||
          normalized.split('/').includes('..')
        ) {
          archiveViolation ??= new Error(
            'Scanner source archives may not escape their extraction root',
          );
          return false;
        }
        if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
          archiveViolation ??= new Error('Scanner source archives may not contain links');
          return false;
        }
        if (entry.type !== 'File' && entry.type !== 'Directory') {
          archiveViolation ??= new Error(
            'Scanner source archives may contain only regular files and directories',
          );
          return false;
        }
        if (entry.type === 'File') {
          archiveFiles += 1;
          archiveBytes += entry.size;
          if (archiveFiles > MAX_SOURCE_FILES || archiveBytes > MAX_SOURCE_BYTES) {
            archiveViolation ??= new Error(
              'Scanner source exceeds the fallback verification limits',
            );
            return false;
          }
        }
        return true;
      },
    });
    if (archiveViolation) throw archiveViolation;
    const [candidate, extracted] = await Promise.all([
      fileManifest(candidateRoot),
      fileManifest(extractionRoot),
    ]);
    compareManifests(candidate, normalizedDownloadedManifest(extracted));
    return expectedDeploymentId;
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--configuration-only') {
    const [, functionFile, functionId] = args;
    if (!functionId) {
      throw new Error(
        'Usage: verify-appwrite-scanner-fallback.mjs --configuration-only <function.json> <function-id>',
      );
    }
    const functionPayload = JSON.parse(await readFile(functionFile, 'utf8'));
    process.stdout.write(`${verifyScannerFunctionConfiguration(functionPayload, functionId)}\n`);
    return;
  }
  if (args[0] === '--function-only') {
    const [, functionFile, expectedDeploymentId, functionId] = args;
    if (!functionId) {
      throw new Error(
        'Usage: verify-appwrite-scanner-fallback.mjs --function-only <function.json> <deployment-id> <function-id>',
      );
    }
    const functionPayload = JSON.parse(await readFile(functionFile, 'utf8'));
    process.stdout.write(
      `${verifyScannerFunctionState(functionPayload, expectedDeploymentId, functionId)}\n`,
    );
    return;
  }
  if (args[0] === '--build-log') {
    const [, deploymentFile] = args;
    if (!deploymentFile) {
      throw new Error('Usage: verify-appwrite-scanner-fallback.mjs --build-log <deployment.json>');
    }
    const payload = JSON.parse(await readFile(deploymentFile, 'utf8'));
    if (!isExactArtifactHandoffFailure(payload)) process.exitCode = 1;
    return;
  }
  if (args[0] === '--variables') {
    const [
      ,
      functionVariablesFile,
      projectVariablesFile,
      functionId,
      registryUrl,
      quarantineBucketId,
      maxArchiveBytes,
      maxPackageFiles,
    ] = args;
    if (!maxPackageFiles) {
      throw new Error(
        'Usage: verify-appwrite-scanner-fallback.mjs --variables <function-variables.json> <project-variables.json> <function-id> <registry-url> <bucket-id> <max-archive-bytes> <max-package-files>',
      );
    }
    const [functionVariablesPayload, projectVariablesPayload] = await Promise.all([
      readFile(functionVariablesFile, 'utf8').then(JSON.parse),
      readFile(projectVariablesFile, 'utf8').then(JSON.parse),
    ]);
    process.stdout.write(
      `${verifyScannerVariables({
        functionVariablesPayload,
        projectVariablesPayload,
        functionId,
        registryUrl,
        quarantineBucketId,
        maxArchiveBytes,
        maxPackageFiles,
      })}\n`,
    );
    return;
  }
  if (args[0] === '--challenge-headers') {
    process.stdout.write(
      `${JSON.stringify(scannerChallengeHeaders(process.env.SCANNER_SHARED_SECRET))}\n`,
    );
    return;
  }
  if (args[0] === '--challenge-result') {
    const [, executionFile, expectedDeploymentId] = args;
    if (!expectedDeploymentId) {
      throw new Error(
        'Usage: verify-appwrite-scanner-fallback.mjs --challenge-result <execution.json> <deployment-id>',
      );
    }
    const executionPayload = JSON.parse(await readFile(executionFile, 'utf8'));
    process.stdout.write(`${verifyScannerChallenge(executionPayload, expectedDeploymentId)}\n`);
    return;
  }

  const [functionFile, deploymentFile, expectedDeploymentId, functionId, candidate, archive] = args;
  if (!archive) {
    throw new Error(
      'Usage: verify-appwrite-scanner-fallback.mjs <function.json> <deployment.json> <deployment-id> <function-id> <candidate-dir> <source-archive>',
    );
  }
  const [functionPayload, deploymentPayload] = await Promise.all([
    readFile(functionFile, 'utf8').then(JSON.parse),
    readFile(deploymentFile, 'utf8').then(JSON.parse),
  ]);
  const id = await verifyScannerFallback({
    functionPayload,
    deploymentPayload,
    expectedDeploymentId,
    functionId,
    candidateDirectory: candidate,
    sourceArchive: archive,
  });
  process.stdout.write(`${id}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
