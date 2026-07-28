import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function drift(message) {
  throw new Error(`Clerk public configuration drift: ${message}`);
}

function exactHttpsOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    drift(`${label} must be an absolute URL`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    drift(`${label} must be an exact HTTPS origin`);
  }
  return parsed;
}

function requireValue(condition, message) {
  if (!condition) drift(message);
}

function has(values, expected) {
  return Array.isArray(values) && values.includes(expected);
}

async function jsonResponse(fetchImpl, url, label) {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Lemonize-Clerk-Drift-Check/1.0',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) drift(`${label} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    drift(`${label} did not return valid JSON`);
  }
}

function publishableKeyHosts(html, expectedPrefix) {
  const oppositePrefix = expectedPrefix === 'pk_live_' ? 'pk_test_' : 'pk_live_';
  requireValue(!html.includes(oppositePrefix), 'the deployed web app contains the wrong key type');

  const keys = html.match(/pk_(?:live|test)_[A-Za-z0-9_-]+/g) ?? [];
  const hosts = new Set();
  for (const key of keys) {
    if (!key.startsWith(expectedPrefix)) continue;
    const encoded = key.slice(expectedPrefix.length);
    try {
      const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
      if (!decoded.endsWith('$')) continue;
      const host = decoded.slice(0, -1);
      if (/^[A-Za-z0-9.-]+$/.test(host)) hosts.add(host.toLowerCase());
    } catch {
      // Another unrelated string can resemble a publishable key. Only a
      // decodable Clerk frontend API host satisfies this deployment check.
    }
  }
  return hosts;
}

export async function verifyClerkPublicConfig({
  definition,
  issuer,
  webBaseUrl,
  expectedInstanceEnvironment,
  fetchImpl = fetch,
}) {
  const issuerUrl = exactHttpsOrigin(issuer, 'issuer');
  const webUrl = exactHttpsOrigin(webBaseUrl, 'web base URL');
  requireValue(
    expectedInstanceEnvironment === 'production' || expectedInstanceEnvironment === 'development',
    'expected instance environment must be production or development',
  );

  const [jwks, environment] = await Promise.all([
    jsonResponse(fetchImpl, new URL('/.well-known/jwks.json', issuerUrl), 'Clerk JWKS endpoint'),
    jsonResponse(fetchImpl, new URL('/v1/environment', issuerUrl), 'Clerk environment endpoint'),
  ]);

  requireValue(
    Array.isArray(jwks?.keys) &&
      jwks.keys.some(
        (key) =>
          key?.kty === 'RSA' &&
          key?.alg === 'RS256' &&
          typeof key?.kid === 'string' &&
          key.kid.length > 0,
      ),
    'JWKS does not expose an identified RSA/RS256 signing key',
  );

  const auth = environment?.auth_config;
  const display = environment?.display_config;
  const userSettings = environment?.user_settings;
  requireValue(
    display?.instance_environment_type === expectedInstanceEnvironment,
    `instance environment is not ${expectedInstanceEnvironment}`,
  );
  requireValue(
    auth?.test_mode === (expectedInstanceEnvironment === 'development'),
    'test-mode state does not match the expected environment',
  );

  const email = definition?.auth_email;
  if (email?.used_for_sign_in || email?.used_for_sign_up) {
    requireValue(
      has(auth?.identification_strategies, 'email_address'),
      'email-address identification is disabled',
    );
  }
  if (email?.sign_in_strategies?.includes('email_code')) {
    requireValue(has(auth?.first_factors, 'email_code'), 'email-code sign-in is disabled');
  }
  if (email?.verification_strategies?.includes('email_code')) {
    requireValue(
      has(auth?.email_address_verification_strategies, 'email_code'),
      'email-code verification is disabled',
    );
  }

  if (definition?.connection_oauth_github?.enabled) {
    requireValue(
      has(auth?.identification_strategies, 'oauth_github'),
      'GitHub OAuth identification is disabled',
    );
    if (definition.connection_oauth_github.authenticatable) {
      requireValue(has(auth?.first_factors, 'oauth_github'), 'GitHub OAuth sign-in is disabled');
    }
  }

  if (definition?.auth_password?.enabled === false) {
    requireValue(
      !has(auth?.identification_strategies, 'password') &&
        !has(auth?.first_factors, 'password') &&
        userSettings?.attributes?.password?.enabled === false,
      'password authentication is unexpectedly enabled',
    );
  }

  const legal = definition?.compliance?.legal_consent;
  if (legal?.enabled) {
    requireValue(
      userSettings?.sign_up?.legal_consent_enabled === true,
      'legal consent is disabled',
    );
    requireValue(
      display?.privacy_policy_url === legal.privacy_policy_url,
      'privacy-policy URL does not match the checked definition',
    );
    requireValue(
      display?.terms_url === legal.terms_of_service_url,
      'terms URL does not match the checked definition',
    );
  }

  const botProtection = definition?.auth_attack_protection?.bot_protection;
  if (botProtection?.captcha_enabled) {
    requireValue(Boolean(display?.captcha_provider), 'CAPTCHA provider is disabled');
    requireValue(
      display?.captcha_widget_type === botProtection.captcha_widget_type,
      'CAPTCHA widget type does not match the checked definition',
    );
  }
  if (definition?.branding?.show_clerk_branding === true) {
    requireValue(display?.branded === true, 'Clerk branding is unexpectedly disabled');
  }

  const loginResponse = await fetchImpl(new URL('/login', webUrl), {
    headers: { 'user-agent': 'Lemonize-Clerk-Drift-Check/1.0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  requireValue(loginResponse.ok, `deployed login page returned HTTP ${loginResponse.status}`);
  const expectedPrefix = expectedInstanceEnvironment === 'production' ? 'pk_live_' : 'pk_test_';
  const frontendHosts = publishableKeyHosts(await loginResponse.text(), expectedPrefix);
  requireValue(
    frontendHosts.has(issuerUrl.hostname.toLowerCase()),
    'deployed Vercel publishable key does not target the configured Clerk issuer',
  );

  const dashboardResponse = await fetchImpl(new URL('/dashboard', webUrl), {
    headers: { 'user-agent': 'Lemonize-Clerk-Drift-Check/1.0' },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  const redirectLocation = dashboardResponse.headers.get('location');
  requireValue(
    [302, 303, 307, 308].includes(dashboardResponse.status) &&
      redirectLocation !== null &&
      new URL(redirectLocation, webUrl).toString() === new URL('/login', webUrl).toString(),
    'unauthenticated dashboard does not redirect to the stable login page',
  );

  return {
    instanceEnvironment: expectedInstanceEnvironment,
    issuer: issuerUrl.origin,
    webOrigin: webUrl.origin,
  };
}

async function main() {
  const [definitionPath, issuer, webBaseUrl, expectedInstanceEnvironment] = process.argv.slice(2);
  if (!definitionPath || !issuer || !webBaseUrl || !expectedInstanceEnvironment) {
    throw new Error(
      'Usage: node verify-clerk-public-config.mjs <definition.json> <issuer> <web-origin> <production|development>',
    );
  }
  const definition = JSON.parse(await readFile(definitionPath, 'utf8'));
  const result = await verifyClerkPublicConfig({
    definition,
    issuer,
    webBaseUrl,
    expectedInstanceEnvironment,
  });
  console.log(
    `Verified public Clerk and deployed web configuration for ${result.instanceEnvironment}.`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
