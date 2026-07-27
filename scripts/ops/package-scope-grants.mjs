const MAX_GRANTS = 100;
const MAX_CONFIG_BYTES = 16 * 1024;
const PACKAGE_SCOPE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const GITHUB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESERVED_SCOPES = new Set(['lemonize', 'lem', 'admin', 'support', 'system', 'api']);

export function normalizePackageScopeGrantsJson(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('PACKAGE_SCOPE_GRANTS_JSON is required and must be nonblank');
  }
  const source = raw.trim();
  if (Buffer.byteLength(source, 'utf8') > MAX_CONFIG_BYTES) {
    throw new Error('PACKAGE_SCOPE_GRANTS_JSON exceeds 16 KiB');
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('PACKAGE_SCOPE_GRANTS_JSON must be valid JSON');
  }
  if (!Array.isArray(value) || value.length > MAX_GRANTS) {
    throw new Error('PACKAGE_SCOPE_GRANTS_JSON must be an array of at most 100 grants');
  }

  const scopes = new Set();
  const grants = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`PACKAGE_SCOPE_GRANTS_JSON entry ${index} must be an object`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== 'githubId' || keys[1] !== 'scope') {
      throw new Error(
        `PACKAGE_SCOPE_GRANTS_JSON entry ${index} must contain only scope and githubId`,
      );
    }
    if (typeof entry.scope !== 'string' || !PACKAGE_SCOPE.test(entry.scope)) {
      throw new Error(`PACKAGE_SCOPE_GRANTS_JSON entry ${index} has an invalid scope`);
    }
    if (RESERVED_SCOPES.has(entry.scope)) {
      throw new Error(`PACKAGE_SCOPE_GRANTS_JSON entry ${index} uses a reserved scope`);
    }
    if (typeof entry.githubId !== 'string' || !GITHUB_ID.test(entry.githubId)) {
      throw new Error(`PACKAGE_SCOPE_GRANTS_JSON entry ${index} has an invalid githubId`);
    }
    if (scopes.has(entry.scope)) {
      throw new Error(`PACKAGE_SCOPE_GRANTS_JSON assigns scope ${entry.scope} more than once`);
    }
    scopes.add(entry.scope);
    return { scope: entry.scope, githubId: entry.githubId };
  });
  return JSON.stringify(grants);
}
