export const UPSTREAM_ORIGIN = 'https://registry.npmjs.org';
export const PUBLIC_ORIGIN = 'https://npm.lemonize.cyou';

export const MAX_PACKUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_AUDIT_BYTES = 1024 * 1024;
export const MAX_TARBALL_BYTES = 100 * 1024 * 1024;

export const METADATA_TTL_SECONDS = 300;
export const NEGATIVE_TTL_SECONDS = 60;

const CORGI_MEDIA_TYPE = 'application/vnd.npm.install-v1+json';
const JSON_MEDIA_TYPE = 'application/json';
const PACKAGE_PART = /^[-A-Za-z0-9!~*'()][-A-Za-z0-9!~*'()._]*$/;
const TARBALL_FILE = /^[A-Za-z0-9._~!$&'*()+,;=@%-]+\.tgz$/;

export type MetadataRoute =
  | { kind: 'packument'; packageName: string }
  | { kind: 'search' }
  | { kind: 'ping' };

export type AuditRoute = { kind: 'audit-bulk' } | { kind: 'audit-quick' };

export type TarballRoute = {
  kind: 'tarball';
  packageName: string;
  filename: string;
};

export type NpmRoute = MetadataRoute | AuditRoute | TarballRoute;

export class InvalidNpmPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNpmPathError';
  }
}

function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw new InvalidNpmPathError('The URL path contains malformed percent-encoding.');
  }
}

function isValidPackagePart(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 214 &&
    value[0] !== '.' &&
    value[0] !== '_' &&
    PACKAGE_PART.test(value)
  );
}

export function isValidPackageName(value: string): boolean {
  if (value.length === 0 || value.length > 214) return false;

  if (!value.startsWith('@')) {
    return !value.includes('/') && isValidPackagePart(value);
  }

  const pieces = value.slice(1).split('/');
  return pieces.length === 2 && isValidPackagePart(pieces[0] ?? '') && isValidPackagePart(pieces[1] ?? '');
}

export function classifyPath(pathname: string): NpmRoute | null {
  if (pathname === '/-/v1/search') return { kind: 'search' };
  if (pathname === '/-/ping') return { kind: 'ping' };
  if (pathname === '/-/npm/v1/security/advisories/bulk') return { kind: 'audit-bulk' };
  if (pathname === '/-/npm/v1/security/audits/quick') return { kind: 'audit-quick' };
  if (pathname === '/' || pathname.length > 2048) return null;

  const decoded = decodePath(pathname);
  const tarballMatch = /^\/(.+)\/-\/([^/]+)$/.exec(decoded);
  if (tarballMatch) {
    const packageName = tarballMatch[1] ?? '';
    const filename = tarballMatch[2] ?? '';
    if (!isValidPackageName(packageName)) {
      throw new InvalidNpmPathError('The tarball path contains an invalid package name.');
    }
    if (filename.length > 512 || !TARBALL_FILE.test(filename)) {
      throw new InvalidNpmPathError('The tarball path contains an invalid filename.');
    }
    return { kind: 'tarball', packageName, filename };
  }

  if (decoded.startsWith('/-/')) return null;

  const packageName = decoded.slice(1);
  if (!isValidPackageName(packageName)) {
    throw new InvalidNpmPathError('The URL path is not a valid npm package name.');
  }
  return { kind: 'packument', packageName };
}

function encodeScope(scope: string): string {
  return encodeURIComponent(scope).replace(/^%40/i, '@');
}

export function packumentPath(packageName: string): string {
  if (!packageName.startsWith('@')) return `/${encodeURIComponent(packageName)}`;
  const [scope = '', name = ''] = packageName.split('/');
  return `/${encodeScope(scope)}%2F${encodeURIComponent(name)}`;
}

export function tarballPath(route: TarballRoute): string {
  const packagePath = route.packageName.startsWith('@')
    ? route.packageName
        .split('/')
        .map((part, index) => (index === 0 ? encodeScope(part) : encodeURIComponent(part)))
        .join('/')
    : encodeURIComponent(route.packageName);
  return `/${packagePath}/-/${encodeURIComponent(route.filename)}`;
}

function mediaTypeQuality(accept: string, target: string): number {
  let best = -1;
  for (const item of accept.split(',')) {
    const [rawMediaType = '', ...parameters] = item.split(';');
    const mediaType = rawMediaType.trim().toLowerCase();
    if (mediaType !== target && mediaType !== 'application/*' && mediaType !== '*/*') continue;

    let quality = 1;
    for (const parameter of parameters) {
      const [rawName = '', rawValue = ''] = parameter.split('=', 2);
      if (rawName.trim().toLowerCase() !== 'q') continue;
      const parsed = Number(rawValue.trim());
      quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    }
    best = Math.max(best, quality);
  }
  return best;
}

function hasExplicitMediaType(accept: string, target: string): boolean {
  return accept.split(',').some((item) => item.split(';', 1)[0]?.trim().toLowerCase() === target);
}

export type PackumentRepresentation = {
  variant: 'corgi' | 'full';
  accept: typeof CORGI_MEDIA_TYPE | typeof JSON_MEDIA_TYPE;
};

export function selectPackumentRepresentation(acceptHeader: string | null): PackumentRepresentation {
  if (!acceptHeader) return { variant: 'full', accept: JSON_MEDIA_TYPE };

  const corgiIsExplicit = hasExplicitMediaType(acceptHeader, CORGI_MEDIA_TYPE);
  const corgiQuality = mediaTypeQuality(acceptHeader, CORGI_MEDIA_TYPE);
  const jsonQuality = mediaTypeQuality(acceptHeader, JSON_MEDIA_TYPE);
  if (corgiIsExplicit && corgiQuality > 0 && corgiQuality >= jsonQuality) {
    return { variant: 'corgi', accept: CORGI_MEDIA_TYPE };
  }
  return { variant: 'full', accept: JSON_MEDIA_TYPE };
}

function rewriteTarballUrl(value: string, publicOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }

  if (
    parsed.origin !== UPSTREAM_ORIGIN ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    return value;
  const publicUrl = new URL(publicOrigin);
  publicUrl.pathname = parsed.pathname;
  return publicUrl.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rewritePackumentTarballs(
  packument: unknown,
  publicOrigin = PUBLIC_ORIGIN,
): unknown {
  if (!isRecord(packument) || !isRecord(packument.versions)) return packument;

  for (const version of Object.values(packument.versions)) {
    if (!isRecord(version) || !isRecord(version.dist) || typeof version.dist.tarball !== 'string') continue;
    version.dist.tarball = rewriteTarballUrl(version.dist.tarball, publicOrigin);
  }
  return packument;
}
