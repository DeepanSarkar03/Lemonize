#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const apply = process.argv.includes('--apply');
const database = process.env.CF_D1_DATABASE_NAME || 'lemonize_db';
const appwriteEndpoint = (process.env.APPWRITE_ENDPOINT || 'https://fra.cloud.appwrite.io/v1').replace(/\/+$/, '');
const appwriteProject = process.env.APPWRITE_PROJECT_ID || 'lemonize-prod-2026';
const appwriteKey = process.env.APPWRITE_API_KEY;
const registryUrl = (process.env.LEGACY_REGISTRY_URL || 'https://registry.lemonize.cyou').replace(/\/+$/, '');
const ownerEmailMap = JSON.parse(process.env.LEGACY_OWNER_EMAIL_MAP || '{}');

if (apply) {
  const required = [
    'APPWRITE_API_KEY',
    'APPWRITE_ENDPOINT',
    'APPWRITE_PROJECT_ID',
    'CF_D1_DATABASE_NAME',
    'LEGACY_R2_BUCKET',
    'LEGACY_OWNER_EMAIL_MAP',
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(`Apply requires explicit configuration: ${missing.join(', ')}`);
  if (process.env.CONFIRM_CUTOVER !== appwriteProject) {
    throw new Error('CONFIRM_CUTOVER must exactly equal APPWRITE_PROJECT_ID.');
  }
}

function d1Query(sql) {
  const command = 'pnpm';
  const result = spawnSync(
    command,
    ['dlx', 'wrangler@4.111.0', 'd1', 'execute', database, '--remote', '--command', sql, '--json'],
    {
      cwd: new URL('../apps/registry-worker/', import.meta.url),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32',
    },
  );
  if (result.status !== 0) {
    throw new Error(`D1 query failed: ${(result.stderr || result.error?.message || 'unknown error').trim()}`);
  }
  const decoded = JSON.parse(result.stdout);
  if (!Array.isArray(decoded) || decoded[0]?.success !== true || !Array.isArray(decoded[0].results)) {
    throw new Error('D1 returned an unexpected response.');
  }
  return decoded[0].results;
}

function tableRows() {
  return {
    users: d1Query('SELECT id, username, email FROM users ORDER BY id'),
    packages: d1Query(
      'SELECT id, name, normalized_name, scope, owner_user_id, description, readme, latest_version, deleted_at FROM packages ORDER BY id',
    ),
    versions: d1Query(
      'SELECT id, package_id, version, tarball_key, integrity, shasum, unpacked_size, tarball_size, file_count, manifest_json, published_by, published_at, deprecated_message, yanked_at FROM package_versions ORDER BY id',
    ),
    tags: d1Query('SELECT id, package_id, tag, version FROM dist_tags ORDER BY id'),
  };
}

async function verifyArtifact(pkg, version) {
  const url = `${registryUrl}/v1/packages/${encodeURIComponent(pkg.name)}/versions/${encodeURIComponent(version.version)}/tarball`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Legacy artifact check failed for ${pkg.name}@${version.version}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (bytes.byteLength !== version.tarball_size || sha256 !== version.shasum || integrity !== version.integrity) {
    throw new Error(`Legacy artifact integrity mismatch for ${pkg.name}@${version.version}.`);
  }
}

function headers() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Appwrite-Project': appwriteProject,
    'X-Appwrite-Key': appwriteKey,
    'X-Appwrite-Response-Format': '1.9.5',
  };
}

async function upsertChecked(table, id, data) {
  const base = `${appwriteEndpoint}/tablesdb/registry/tables/${encodeURIComponent(table)}/rows`;
  const response = await fetch(base, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ rowId: id, data }),
  });
  if (response.ok) return 'created';
  if (response.status !== 409) throw new Error(`Appwrite ${table}/${id} create failed: HTTP ${response.status}`);
  const existingResponse = await fetch(`${base}/${encodeURIComponent(id)}`, { headers: headers() });
  if (!existingResponse.ok) throw new Error(`Appwrite ${table}/${id} conflict could not be verified.`);
  const existing = await existingResponse.json();
  for (const [key, value] of Object.entries(data)) {
    const current = existing[key] ?? null;
    const expected = value ?? null;
    const sameInstant =
      key.endsWith('At') &&
      typeof current === 'string' &&
      typeof expected === 'string' &&
      Number.isFinite(Date.parse(current)) &&
      Date.parse(current) === Date.parse(expected);
    if (!sameInstant && JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`Appwrite ${table}/${id} differs at ${key}; refusing to overwrite.`);
    }
  }
  return 'verified';
}

const source = process.argv.includes('--stdin')
  ? JSON.parse(readFileSync(0, 'utf8'))
  : tableRows();
const packagesById = new Map(source.packages.map((pkg) => [pkg.id, pkg]));
const versionsByPackage = new Map();
for (const version of source.versions) {
  const list = versionsByPackage.get(version.package_id) || [];
  list.push(version);
  versionsByPackage.set(version.package_id, list);
}
const tagsByPackage = new Map();
for (const tag of source.tags) {
  const list = tagsByPackage.get(tag.package_id) || [];
  list.push(tag);
  tagsByPackage.set(tag.package_id, list);
}

const directProofs = new Map(
  Array.isArray(source.r2Proofs) ? source.r2Proofs.map((proof) => [proof.key, proof]) : [],
);
let directProofsValid = source.versions.length === directProofs.size;
for (const version of source.versions) {
  const proof = directProofs.get(version.tarball_key);
  if (
    !proof ||
    proof.size !== version.tarball_size ||
    proof.shasum !== version.shasum ||
    proof.integrity !== version.integrity
  ) {
    directProofsValid = false;
    break;
  }
}
if (apply && !directProofsValid) {
  throw new Error('Direct source/target R2 artifact proofs are required before apply.');
}
if (!directProofsValid) {
  for (const version of source.versions) {
    const pkg = packagesById.get(version.package_id);
    if (!pkg) throw new Error(`Version ${version.id} references a missing package.`);
    await verifyArtifact(pkg, version);
  }
}

console.log(
  `Verified D1 source: ${source.users.length} users, ${source.packages.length} packages, ` +
    `${source.versions.length} versions, ${source.tags.length} tags; ` +
    `all artifacts match size and digests (${directProofsValid ? 'direct R2' : 'legacy HTTP'}).`,
);

if (!apply) {
  console.log('Dry run complete. Re-run with --apply and APPWRITE_API_KEY to import.');
  process.exit(0);
}

const results = { created: 0, verified: 0 };
async function write(table, id, data) {
  const outcome = await upsertChecked(table, id, data);
  results[outcome] += 1;
}

for (const user of source.users) {
  const owned = source.packages.filter((pkg) => pkg.owner_user_id === user.id);
  const mappedEmail = ownerEmailMap[user.username];
  if (owned.length > 0 && (typeof mappedEmail !== 'string' || !mappedEmail.includes('@'))) {
    throw new Error(`LEGACY_OWNER_EMAIL_MAP must map package owner ${user.username}.`);
  }
  const storageBytes = owned.reduce(
    (total, pkg) =>
      total +
      (versionsByPackage.get(pkg.id) || []).reduce(
        (sum, version) => sum + version.tarball_size,
        0,
      ),
    0,
  );
  await write('users', user.id, {
    clerkId: `legacy_${user.id}`,
    email: mappedEmail || user.email || `${user.username}@legacy.invalid`,
    githubUsername: null,
    namespace: user.username.toLowerCase(),
    status: 'active',
    role: 'consumer',
    storageBytes,
    packageCount: owned.length,
    acceptedTermsAt: null,
    lastLoginAt: null,
  });
}

for (const pkg of source.packages) {
  const versions = versionsByPackage.get(pkg.id) || [];
  const storageBytes = versions.reduce(
    (sum, version) => sum + version.tarball_size,
    0,
  );
  const availableVersions = new Set(
    versions.filter((version) => !version.yanked_at).map((version) => version.version),
  );
  await write('packages', pkg.id, {
    name: pkg.name,
    normalizedName: pkg.normalized_name,
    scope: pkg.scope || '',
    ownerId: pkg.owner_user_id,
    description: pkg.description,
    readme: pkg.readme,
    status: pkg.deleted_at ? 'deleted' : 'active',
    latestVersion: availableVersions.has(pkg.latest_version) ? pkg.latest_version : null,
    storageBytes,
    publishedVersionCount: availableVersions.size,
  });

  const tags = tagsByPackage.get(pkg.id) || [];
  for (const version of versions) {
    const tag = tags.find((candidate) => candidate.version === version.version)?.tag || 'latest';
    await write('versions', version.id, {
      packageId: pkg.id,
      version: version.version,
      status: version.yanked_at ? 'yanked' : 'published',
      stagingKey: null,
      artifactKey: version.tarball_key,
      archiveFileId: null,
      integrity: version.integrity,
      shasum: version.shasum,
      computedShasum: version.shasum,
      tarballSize: version.tarball_size,
      unpackedSize: version.unpacked_size,
      fileCount: version.file_count,
      manifest: version.manifest_json,
      tag,
      publishedBy: version.published_by,
      deprecatedMessage: version.deprecated_message,
      scanError: null,
      publishedAt: version.published_at,
      yankedAt: version.yanked_at,
    });
  }
}

for (const tag of source.tags) {
  const available = (versionsByPackage.get(tag.package_id) || []).some(
    (version) => version.version === tag.version && !version.yanked_at,
  );
  if (!available) continue;
  await write('dist_tags', tag.id, {
    packageId: tag.package_id,
    tag: tag.tag,
    version: tag.version,
  });
}

console.log(`Appwrite cutover import complete: ${results.created} created, ${results.verified} already matched.`);
