import { readFile } from 'node:fs/promises';

const REQUIRED_PREDICATE = 'https://slsa.dev/provenance/v1';
const REQUIRED_STATEMENT = 'https://in-toto.io/Statement/v1';
const REQUIRED_BUILDER = 'https://github.com/actions/runner/github-hosted';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment value: ${name}`);
  return value;
}

async function registryJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`npm registry request failed with HTTP ${response.status}`);
  return response.json();
}

function localPackEntry(value, packageName, version) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error('npm pack output must contain exactly one package.');
  }
  const entry = value[0];
  if (
    !entry ||
    entry.name !== packageName ||
    entry.version !== version ||
    typeof entry.filename !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)
  ) {
    throw new Error('npm pack output does not match the requested package release.');
  }
  return entry;
}

const packJsonPath = required('CLI_PACK_JSON');
const packageName = required('RELEASE_PACKAGE');
const version = required('RELEASE_VERSION');
const repository = required('RELEASE_REPOSITORY').replace(/\/$/, '');
const releaseSha = required('RELEASE_SHA').toLowerCase();
const releaseRef = required('RELEASE_REF');
const workflowPath = required('RELEASE_WORKFLOW');

if (!/^[0-9a-f]{40}$/.test(releaseSha)) throw new Error('Release SHA must be a full commit SHA.');
if (!/^refs\/tags\/[^/]+$/.test(releaseRef)) throw new Error('Release ref must be a tag.');

const packOutput = JSON.parse(await readFile(packJsonPath, 'utf8'));
const local = localPackEntry(packOutput, packageName, version);
const packageUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
const metadata = await registryJson(packageUrl);
if (metadata?.dist?.integrity !== local.integrity) {
  throw new Error('Published npm integrity does not match the locally built tarball.');
}

const attestationUrl = new URL(metadata?.dist?.attestations?.url ?? '');
if (
  attestationUrl.protocol !== 'https:' ||
  attestationUrl.hostname !== 'registry.npmjs.org' ||
  !attestationUrl.pathname.startsWith('/-/npm/v1/attestations/')
) {
  throw new Error('Published npm release has no trusted registry attestation URL.');
}
if (metadata?.dist?.attestations?.provenance?.predicateType !== REQUIRED_PREDICATE) {
  throw new Error('Published npm release has no SLSA provenance declaration.');
}

const attestations = await registryJson(attestationUrl);
const provenance = attestations?.attestations?.find(
  (entry) => entry?.predicateType === REQUIRED_PREDICATE,
);
const envelope = provenance?.bundle?.dsseEnvelope;
if (
  envelope?.payloadType !== 'application/vnd.in-toto+json' ||
  typeof envelope.payload !== 'string'
) {
  throw new Error('Published npm SLSA attestation has an invalid DSSE envelope.');
}

const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
const localSha512 = Buffer.from(local.integrity.slice('sha512-'.length), 'base64').toString('hex');
const expectedPurl = `pkg:npm/${encodeURIComponent(packageName).replace(/%2F/gi, '/')}@${version}`;
const subjectMatches = statement?.subject?.some(
  (subject) => subject?.name === expectedPurl && subject?.digest?.sha512 === localSha512,
);
const build = statement?.predicate?.buildDefinition;
const workflow = build?.externalParameters?.workflow;
const dependencyMatches = build?.resolvedDependencies?.some(
  (dependency) => dependency?.digest?.gitCommit?.toLowerCase() === releaseSha,
);
const invocationId = statement?.predicate?.runDetails?.metadata?.invocationId;

if (
  statement?._type !== REQUIRED_STATEMENT ||
  statement?.predicateType !== REQUIRED_PREDICATE ||
  !subjectMatches ||
  workflow?.repository !== repository ||
  workflow?.path !== workflowPath ||
  workflow?.ref !== releaseRef ||
  !dependencyMatches ||
  statement?.predicate?.runDetails?.builder?.id !== REQUIRED_BUILDER ||
  typeof invocationId !== 'string' ||
  !invocationId.startsWith(`${repository}/actions/runs/`)
) {
  throw new Error('Published npm provenance does not match this repository release.');
}

console.log(`Verified npm integrity and SLSA provenance for ${packageName}@${version}`);
