import { validateRegistryUrl } from './config.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_RESOURCE_REDIRECTS = 5;
type FetchInput = Parameters<typeof fetch>[0];

function inputUrl(input: FetchInput): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL(input.url);
}

function mergedHeaders(input: FetchInput, init?: RequestInit): Headers {
  const inputHeaders = typeof input === 'string' || input instanceof URL ? undefined : input.headers;
  const headers = new Headers(inputHeaders);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  }
  return headers;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function assertSecureResourceUrl(url: URL): void {
  if (url.username || url.password) throw new Error(`Refusing package URL containing credentials: ${url.href}`);
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return;
  throw new Error(`Refusing insecure package URL: ${url.href}`);
}

/**
 * Fetch adapter for LemonizeClient. Authorization is accepted only on the
 * configured registry origin, and registry requests never follow redirects
 * automatically.
 */
export function createSecureRegistryFetch(registry: string): typeof fetch {
  const trustedOrigin = new URL(validateRegistryUrl(registry)).origin;

  return (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const url = inputUrl(input);
    const headers = mergedHeaders(input, init);
    const hasAuthorization = headers.has('authorization');
    const hasUploadToken = headers.has('x-lemonize-upload-token');
    const hasCredentials = hasAuthorization || hasUploadToken;

    if (hasAuthorization && url.origin !== trustedOrigin) {
      throw new Error(`Refusing to send registry credentials to untrusted origin ${url.origin}.`);
    }
    if (hasCredentials) assertSecureResourceUrl(url);

    const response = await globalThis.fetch(input, { ...init, redirect: 'manual' });
    if (REDIRECT_STATUSES.has(response.status)) {
      throw new Error(`Refusing registry request redirect from ${url.href}.`);
    }
    return response;
  }) as typeof fetch;
}

/**
 * Download a package resource while authenticating only the first request and
 * only when it targets the configured registry origin. Redirects are followed
 * manually without Authorization, including redirects back to the registry.
 */
export async function fetchPackageResource(
  registry: string,
  resource: string | URL,
  token: string | null,
  init: Pick<RequestInit, 'method'> = {},
): Promise<Response> {
  const trustedOrigin = new URL(validateRegistryUrl(registry)).origin;
  let url = new URL(resource);
  let includeAuthorization = token !== null && url.origin === trustedOrigin;

  for (let redirectCount = 0; redirectCount <= MAX_RESOURCE_REDIRECTS; redirectCount += 1) {
    assertSecureResourceUrl(url);
    const headers = new Headers({ 'user-agent': 'lem-cli/0.1.0' });
    if (includeAuthorization && token) headers.set('authorization', `Bearer ${token}`);

    const response = await globalThis.fetch(url, {
      method: init.method ?? 'GET',
      headers,
      redirect: 'manual',
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    if (redirectCount === MAX_RESOURCE_REDIRECTS) {
      throw new Error(`Too many redirects while downloading ${resource.toString()}.`);
    }
    const location = response.headers.get('location');
    if (!location) throw new Error(`Package download redirect from ${url.href} has no Location header.`);
    await response.body?.cancel();
    url = new URL(location, url);
    includeAuthorization = false;
  }

  throw new Error(`Too many redirects while downloading ${resource.toString()}.`);
}

export async function fetchRegistryWithToken(
  registry: string,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const normalizedRegistry = validateRegistryUrl(registry);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return createSecureRegistryFetch(normalizedRegistry)(`${normalizedRegistry}${path}`, { ...init, headers });
}
