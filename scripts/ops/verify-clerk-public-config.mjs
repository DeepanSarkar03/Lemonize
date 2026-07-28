import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ENVIRONMENTS_URL = new URL('../../infrastructure/clerk/environments.json', import.meta.url);
const DEFAULT_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

class RetryableCheckError extends Error {}

class AliasPropagationError extends RetryableCheckError {}

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

function exactHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    drift(`${label} must be an absolute URL`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.toString() !== value ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    drift(`${label} must be an exact HTTPS URL without credentials, query, or fragment`);
  }
  return parsed;
}

function requireValue(condition, message) {
  if (!condition) drift(message);
}

function definitionBoolean(value, label) {
  requireValue(typeof value === 'boolean', `checked definition ${label} must be a boolean`);
  return value;
}

function definitionString(value, label) {
  requireValue(
    typeof value === 'string' && value.length > 0,
    `checked definition ${label} is missing`,
  );
  return value;
}

function definitionInteger(value, label) {
  requireValue(
    Number.isSafeInteger(value) && value >= 0,
    `checked definition ${label} must be a non-negative integer`,
  );
  return value;
}

function definitionStrings(value, label) {
  requireValue(
    Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => typeof entry === 'string' && entry.length > 0) &&
      new Set(value).size === value.length,
    `checked definition ${label} must be a non-empty unique string array`,
  );
  return value;
}

function sameStrings(actual, expected) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    !actual.every((entry) => typeof entry === 'string')
  ) {
    return false;
  }
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.every((entry, index) => entry === expectedSorted[index]);
}

function exactOriginList(value, label) {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',').map((entry) => entry.trim())
      : [];
  requireValue(entries.length > 0, `${label} must contain at least one HTTPS origin`);
  const origins = entries.map(
    (entry, index) => exactHttpsOrigin(entry, `${label} entry ${index + 1}`).origin,
  );
  requireValue(new Set(origins).size === origins.length, `${label} must not contain duplicates`);
  return origins;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function webProbeHeaders(probeUrl, webUrl, vercelAutomationBypassSecret) {
  const headers = { 'user-agent': 'Lemonize-Clerk-Drift-Check/1.0' };
  if (probeUrl.origin === webUrl.origin) {
    requireValue(
      vercelAutomationBypassSecret === undefined,
      'Vercel automation bypass secret must be used only for a separate deployment probe origin',
    );
    return headers;
  }

  requireValue(
    probeUrl.hostname !== 'vercel.app' && probeUrl.hostname.endsWith('.vercel.app'),
    'separate deployment probe origin must be a Vercel deployment hostname',
  );
  requireValue(
    typeof vercelAutomationBypassSecret === 'string' &&
      vercelAutomationBypassSecret.length >= 16 &&
      vercelAutomationBypassSecret.length <= 1024 &&
      vercelAutomationBypassSecret.trim() === vercelAutomationBypassSecret &&
      !hasControlCharacter(vercelAutomationBypassSecret),
    'separate deployment probe origin requires a valid Vercel automation bypass secret',
  );
  headers['x-vercel-protection-bypass'] = vercelAutomationBypassSecret;
  return headers;
}

function retrySettings(options = {}) {
  const maxAttempts = options.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  requireValue(
    Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 8,
    'retry maxAttempts must be between 1 and 8',
  );
  requireValue(
    Number.isSafeInteger(baseDelayMs) && baseDelayMs >= 0 && baseDelayMs <= 5_000,
    'retry baseDelayMs must be between 0 and 5000',
  );
  requireValue(typeof sleep === 'function', 'retry sleep must be a function');
  return { maxAttempts, baseDelayMs, sleep };
}

async function retryOperation(operation, label, settings) {
  let lastError;
  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof RetryableCheckError)) throw error;
      lastError = error;
      if (attempt === settings.maxAttempts) break;
      const delay = Math.min(5_000, settings.baseDelayMs * 2 ** (attempt - 1));
      await settings.sleep(delay);
    }
  }
  drift(
    `${label} did not stabilize after ${settings.maxAttempts} attempts: ${lastError?.message ?? 'transient failure'}`,
  );
}

async function fetchPublic(fetchImpl, url, init, label) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new RetryableCheckError(`${label} request failed`);
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    throw new RetryableCheckError(`${label} returned transient HTTP ${response.status}`);
  }
  return response;
}

function expectedWebTarget(value, webUrl, label) {
  const path = definitionString(value, `paths.${label}`);
  requireValue(
    path.startsWith('/') && !path.startsWith('//'),
    `paths.${label} must be site-relative`,
  );
  const target = new URL(path, webUrl);
  requireValue(
    target.origin === webUrl.origin && !target.search && !target.hash,
    `paths.${label} must stay on the deployed web origin without query or fragment`,
  );
  return target.toString();
}

function enumerationProtectionEnabled(value) {
  const mode = definitionString(value, 'auth_attack_protection.enumeration_protection');
  if (mode === 'strict') return true;
  if (mode === 'off' || mode === 'disabled') return false;
  drift(`unsupported enumeration-protection mode in checked definition: ${mode}`);
}

async function validateSigningJwks(jwks) {
  requireValue(Array.isArray(jwks?.keys), 'JWKS response does not contain a key array');
  const signingKeys = jwks.keys.filter((key) => key?.kty === 'RSA' && key?.alg === 'RS256');
  requireValue(signingKeys.length > 0, 'JWKS does not expose an RSA/RS256 signing key');

  const keyIds = new Set();
  for (const key of signingKeys) {
    requireValue(
      typeof key.kid === 'string' && key.kid.length > 0 && !keyIds.has(key.kid),
      'JWKS RSA/RS256 signing keys must have unique non-empty key IDs',
    );
    keyIds.add(key.kid);
    requireValue(key.use === 'sig', `JWKS signing key ${key.kid} does not declare signature use`);
    requireValue(
      typeof key.n === 'string' && /^[A-Za-z0-9_-]+$/.test(key.n),
      `JWKS signing key ${key.kid} has an invalid RSA modulus`,
    );
    requireValue(
      typeof key.e === 'string' && /^[A-Za-z0-9_-]+$/.test(key.e),
      `JWKS signing key ${key.kid} has an invalid RSA exponent`,
    );
    const modulus = Buffer.from(key.n, 'base64url');
    const exponent = Buffer.from(key.e, 'base64url');
    requireValue(
      modulus.toString('base64url') === key.n && modulus.byteLength > 0,
      `JWKS signing key ${key.kid} has a non-canonical RSA modulus`,
    );
    const modulusBits = BigInt(`0x${modulus.toString('hex')}`).toString(2).length;
    requireValue(
      modulusBits >= 2048,
      `JWKS signing key ${key.kid} must use an RSA modulus of at least 2048 bits`,
    );
    const exponentValue = exponent.byteLength > 0 ? BigInt(`0x${exponent.toString('hex')}`) : 0n;
    requireValue(
      exponent.toString('base64url') === key.e &&
        exponent.byteLength > 0 &&
        exponentValue >= 3n &&
        exponentValue % 2n === 1n,
      `JWKS signing key ${key.kid} has an invalid RSA exponent`,
    );
    try {
      await crypto.subtle.importKey(
        'jwk',
        key,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
    } catch {
      drift(`JWKS signing key ${key.kid} cannot be imported for RS256 verification`);
    }
  }
}

async function jsonResponse(fetchImpl, url, label, settings) {
  return retryOperation(
    async () => {
      const response = await fetchPublic(
        fetchImpl,
        url,
        {
          headers: {
            accept: 'application/json',
            'user-agent': 'Lemonize-Clerk-Drift-Check/1.0',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        },
        label,
      );
      if (!response.ok) drift(`${label} returned HTTP ${response.status}`);
      requireValue(
        response.headers.get('content-type')?.toLowerCase().includes('application/json'),
        `${label} did not return a JSON content type`,
      );
      try {
        return await response.json();
      } catch {
        drift(`${label} did not return valid JSON`);
      }
    },
    label,
    settings,
  );
}

function publishableKeyHosts(html, expectedPrefix) {
  const oppositePrefix = expectedPrefix === 'pk_live_' ? 'pk_test_' : 'pk_live_';
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
  return { hosts, hasOppositeKeyType: html.includes(oppositePrefix) };
}

function validatePinnedEnvironment({
  issuerUrl,
  webUrl,
  authorizedParties,
  expectedInstanceEnvironment,
  pinnedEnvironment,
}) {
  requireValue(
    pinnedEnvironment && typeof pinnedEnvironment === 'object' && !Array.isArray(pinnedEnvironment),
    'checked environment pin is missing',
  );
  const pinnedIssuer = exactHttpsOrigin(
    definitionString(pinnedEnvironment.issuer, 'environment pin issuer'),
    'environment pin issuer',
  );
  const pinnedWebOrigin = exactHttpsOrigin(
    definitionString(pinnedEnvironment.web_origin, 'environment pin web_origin'),
    'environment pin web origin',
  );
  const pinnedInstanceEnvironment = definitionString(
    pinnedEnvironment.instance_environment,
    'environment pin instance_environment',
  );
  const pinnedAuthorizedParties = exactOriginList(
    pinnedEnvironment.authorized_parties,
    'environment pin authorized_parties',
  );

  requireValue(
    issuerUrl.origin === pinnedIssuer.origin,
    'issuer does not match the checked environment pin',
  );
  requireValue(
    webUrl.origin === pinnedWebOrigin.origin,
    'web origin does not match the checked environment pin',
  );
  requireValue(
    expectedInstanceEnvironment === pinnedInstanceEnvironment,
    'instance environment does not match the checked environment pin',
  );
  requireValue(
    authorizedParties.includes(webUrl.origin),
    'authorized parties do not contain the stable web origin',
  );
  requireValue(
    sameStrings(authorizedParties, pinnedAuthorizedParties),
    'authorized parties do not match the checked environment pin',
  );
}

export function verifyClerkEnvironmentPin({
  issuer,
  webBaseUrl,
  authorizedParties,
  expectedInstanceEnvironment,
  pinnedEnvironment,
}) {
  const issuerUrl = exactHttpsOrigin(issuer, 'issuer');
  const webUrl = exactHttpsOrigin(webBaseUrl, 'web base URL');
  const authorizedPartyOrigins = exactOriginList(authorizedParties, 'authorized parties');
  requireValue(
    expectedInstanceEnvironment === 'production' || expectedInstanceEnvironment === 'development',
    'expected instance environment must be production or development',
  );
  validatePinnedEnvironment({
    issuerUrl,
    webUrl,
    authorizedParties: authorizedPartyOrigins,
    expectedInstanceEnvironment,
    pinnedEnvironment,
  });
  return {
    instanceEnvironment: expectedInstanceEnvironment,
    issuer: issuerUrl.origin,
    webOrigin: webUrl.origin,
    authorizedParties: authorizedPartyOrigins,
  };
}

async function verifyDeployedWeb({
  fetchImpl,
  issuerUrl,
  webUrl,
  probeUrl,
  probeHeaders,
  expectedInstanceEnvironment,
  settings,
}) {
  const expectedLoginUrl = new URL('/login', probeUrl);
  const probingStableAlias = probeUrl.origin === webUrl.origin;
  const retryAliasMismatch = (message) => {
    if (probingStableAlias) throw new AliasPropagationError(message);
    drift(message);
  };
  await retryOperation(
    async () => {
      const loginResponse = await fetchPublic(
        fetchImpl,
        expectedLoginUrl,
        {
          headers: probeHeaders,
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        },
        'deployed login page',
      );
      if (loginResponse.status === 404) {
        throw new AliasPropagationError('deployed login page is not available yet');
      }
      if (!loginResponse.ok) {
        drift(`deployed login page returned HTTP ${loginResponse.status}`);
      }
      requireValue(
        loginResponse.url === expectedLoginUrl.toString(),
        'deployed login page changed origin or path',
      );

      const expectedPrefix = expectedInstanceEnvironment === 'production' ? 'pk_live_' : 'pk_test_';
      const { hosts, hasOppositeKeyType } = publishableKeyHosts(
        await loginResponse.text(),
        expectedPrefix,
      );
      requireValue(
        hosts.size <= 1,
        'deployed Vercel page contains multiple Clerk publishable-key hosts',
      );
      if (hasOppositeKeyType) {
        retryAliasMismatch('deployed web app contains the wrong key type');
      }
      if (hosts.size !== 1 || !hosts.has(issuerUrl.hostname.toLowerCase())) {
        retryAliasMismatch(
          'deployed Vercel publishable-key host does not match the configured Clerk issuer',
        );
      }

      const dashboardResponse = await fetchPublic(
        fetchImpl,
        new URL('/dashboard', probeUrl),
        {
          headers: probeHeaders,
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
        },
        'unauthenticated dashboard',
      );
      if (dashboardResponse.status >= 400 && dashboardResponse.status < 500) {
        if (dashboardResponse.status === 404) {
          throw new AliasPropagationError('deployed dashboard route is not available yet');
        }
        drift(`unauthenticated dashboard returned HTTP ${dashboardResponse.status}`);
      }
      const redirectLocation = dashboardResponse.headers.get('location');
      if (![302, 303, 307, 308].includes(dashboardResponse.status) || !redirectLocation) {
        retryAliasMismatch('unauthenticated dashboard does not redirect to the probe login page');
      }
      let redirectUrl;
      try {
        redirectUrl = new URL(redirectLocation, probeUrl);
      } catch {
        drift('unauthenticated dashboard returned an invalid redirect URL');
      }
      requireValue(
        redirectUrl.origin === probeUrl.origin,
        'unauthenticated dashboard redirects outside the probed web origin',
      );
      if (redirectUrl.toString() !== expectedLoginUrl.toString()) {
        retryAliasMismatch('unauthenticated dashboard does not redirect to the probe login page');
      }
    },
    probingStableAlias ? 'deployed web alias' : 'exact Vercel deployment',
    settings,
  );
}

export async function verifyClerkPublicConfig({
  definition,
  issuer,
  webBaseUrl,
  probeBaseUrl = webBaseUrl,
  authorizedParties,
  vercelAutomationBypassSecret,
  expectedInstanceEnvironment,
  pinnedEnvironment,
  fetchImpl = fetch,
  retryOptions,
}) {
  const checkedEnvironment = verifyClerkEnvironmentPin({
    issuer,
    webBaseUrl,
    authorizedParties,
    expectedInstanceEnvironment,
    pinnedEnvironment,
  });
  const issuerUrl = new URL(checkedEnvironment.issuer);
  const webUrl = new URL(checkedEnvironment.webOrigin);
  const probeUrl = exactHttpsOrigin(probeBaseUrl, 'web probe URL');
  const probeHeaders = webProbeHeaders(probeUrl, webUrl, vercelAutomationBypassSecret);
  const settings = retrySettings(retryOptions);

  const [jwks, environment] = await Promise.all([
    jsonResponse(
      fetchImpl,
      new URL('/.well-known/jwks.json', issuerUrl),
      'Clerk JWKS endpoint',
      settings,
    ),
    jsonResponse(
      fetchImpl,
      new URL('/v1/environment', issuerUrl),
      'Clerk environment endpoint',
      settings,
    ),
  ]);
  await validateSigningJwks(jwks);

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

  const access = definition?.auth_access_control;
  const expectedSignUpMode = definitionString(
    access?.sign_up_mode,
    'auth_access_control.sign_up_mode',
  );
  requireValue(userSettings?.sign_up?.mode === expectedSignUpMode, 'sign-up mode does not match');
  const expectedAllowlist = definitionBoolean(
    access?.allowlist_enabled,
    'auth_access_control.allowlist_enabled',
  );
  requireValue(
    userSettings?.restrictions?.allowlist?.enabled === expectedAllowlist,
    'allowlist state does not match',
  );
  const expectedEnforcedOnSignIn = definitionBoolean(
    access?.allowlist_blocklist_enforced_on_sign_in,
    'auth_access_control.allowlist_blocklist_enforced_on_sign_in',
  );
  requireValue(
    userSettings?.restrictions?.allowlist_blocklist_disabled_on_sign_in?.enabled ===
      !expectedEnforcedOnSignIn,
    'allowlist/blocklist sign-in enforcement does not match',
  );
  const expectedDisposableBlocking = definitionBoolean(
    access?.block_disposable_email_domains,
    'auth_access_control.block_disposable_email_domains',
  );
  requireValue(
    userSettings?.restrictions?.block_disposable_email_domains?.enabled ===
      expectedDisposableBlocking,
    'disposable-email blocking does not match',
  );
  const expectedSubaddressBlocking = definitionBoolean(
    access?.block_email_subaddresses,
    'auth_access_control.block_email_subaddresses',
  );
  requireValue(
    userSettings?.restrictions?.block_email_subaddresses?.enabled === expectedSubaddressBlocking,
    'email-subaddress blocking does not match',
  );

  const password = definition?.auth_password;
  const expectedPasswordEnabled = definitionBoolean(password?.enabled, 'auth_password.enabled');
  const expectedPasswordRequired = definitionBoolean(password?.required, 'auth_password.required');
  const publicPassword = userSettings?.attributes?.password;
  requireValue(
    publicPassword?.enabled === expectedPasswordEnabled,
    'password enabled state does not match',
  );
  requireValue(
    publicPassword?.required === expectedPasswordRequired,
    'password required state does not match',
  );

  const email = definition?.auth_email;
  const expectedEmailSignIn = definitionBoolean(
    email?.used_for_sign_in,
    'auth_email.used_for_sign_in',
  );
  const expectedEmailSignUp = definitionBoolean(
    email?.used_for_sign_up,
    'auth_email.used_for_sign_up',
  );
  const expectedEmailRequired = definitionBoolean(
    email?.required_for_sign_up,
    'auth_email.required_for_sign_up',
  );
  const expectedEmailVerification = definitionBoolean(
    email?.verify_at_sign_up,
    'auth_email.verify_at_sign_up',
  );
  const expectedEmailSignInStrategies = definitionStrings(
    email?.sign_in_strategies,
    'auth_email.sign_in_strategies',
  );
  const expectedEmailVerificationStrategies = definitionStrings(
    email?.verification_strategies,
    'auth_email.verification_strategies',
  );
  const activeEmailSignInStrategies = expectedEmailSignIn ? expectedEmailSignInStrategies : [];
  const publicEmail = userSettings?.attributes?.email_address;
  requireValue(publicEmail?.enabled === expectedEmailSignUp, 'email sign-up state does not match');
  requireValue(
    publicEmail?.used_for_first_factor === expectedEmailSignIn,
    'email sign-in state does not match',
  );
  requireValue(
    publicEmail?.required === expectedEmailRequired,
    'email required state does not match',
  );
  requireValue(
    publicEmail?.verify_at_sign_up === expectedEmailVerification,
    'email verification-at-sign-up state does not match',
  );
  requireValue(
    sameStrings(publicEmail?.first_factors, activeEmailSignInStrategies),
    'email sign-in strategies do not match',
  );
  requireValue(
    sameStrings(publicEmail?.verifications, expectedEmailVerificationStrategies),
    'email verification strategies do not match',
  );
  requireValue(
    sameStrings(auth?.email_address_verification_strategies, expectedEmailVerificationStrategies),
    'public email verification strategies do not match',
  );

  const username = definition?.auth_username;
  const expectedUsernameSignIn = definitionBoolean(
    username?.used_for_sign_in,
    'auth_username.used_for_sign_in',
  );
  const expectedUsernameSignUp = definitionBoolean(
    username?.used_for_sign_up,
    'auth_username.used_for_sign_up',
  );
  const expectedUsernameRequired = definitionBoolean(
    username?.required_for_sign_up,
    'auth_username.required_for_sign_up',
  );
  const expectedUsernameImmutable = definitionBoolean(
    username?.immutable,
    'auth_username.immutable',
  );
  const publicUsername = userSettings?.attributes?.username;
  requireValue(
    publicUsername?.enabled === expectedUsernameSignUp,
    'username sign-up state does not match',
  );
  requireValue(
    publicUsername?.used_for_first_factor === expectedUsernameSignIn,
    'username sign-in state does not match',
  );
  requireValue(
    publicUsername?.required === expectedUsernameRequired,
    'username required state does not match',
  );
  requireValue(
    publicUsername?.immutable === expectedUsernameImmutable,
    'username immutability does not match',
  );
  const github = definition?.connection_oauth_github;
  const expectedGithubEnabled = definitionBoolean(
    github?.enabled,
    'connection_oauth_github.enabled',
  );
  const expectedGithubAuthenticatable = definitionBoolean(
    github?.authenticatable,
    'connection_oauth_github.authenticatable',
  );
  const expectedGithubSubaddressBlocking = definitionBoolean(
    github?.block_email_subaddresses,
    'connection_oauth_github.block_email_subaddresses',
  );
  requireValue(
    !expectedGithubAuthenticatable || expectedGithubEnabled,
    'checked definition cannot make disabled GitHub OAuth authenticatable',
  );
  const publicGithub = userSettings?.social?.oauth_github;
  requireValue(
    publicGithub?.enabled === expectedGithubEnabled,
    'GitHub OAuth enabled state does not match',
  );
  requireValue(
    publicGithub?.authenticatable === expectedGithubAuthenticatable,
    'GitHub OAuth authenticatable state does not match',
  );
  requireValue(
    publicGithub?.block_email_subaddresses === expectedGithubSubaddressBlocking,
    'GitHub OAuth email-subaddress policy does not match',
  );
  const expectedIdentificationStrategies = [
    ...(expectedEmailSignIn ? ['email_address'] : []),
    ...(expectedUsernameSignIn ? ['username'] : []),
    ...(expectedGithubEnabled ? ['oauth_github'] : []),
  ];
  const expectedFirstFactors = [
    ...activeEmailSignInStrategies,
    ...(expectedPasswordEnabled ? ['password'] : []),
    ...(expectedGithubAuthenticatable ? ['oauth_github'] : []),
    // Clerk exposes ticket as its internal one-time bootstrap factor. No other
    // provider-internal or undeclared factor is accepted by this deployment gate.
    'ticket',
  ];
  requireValue(
    sameStrings(auth?.identification_strategies, expectedIdentificationStrategies),
    'top-level identification strategies do not match the checked definition',
  );
  requireValue(
    sameStrings(auth?.first_factors, expectedFirstFactors),
    'top-level first-factor strategies do not match the checked definition',
  );

  const legal = definition?.compliance?.legal_consent;
  const expectedLegalConsent = definitionBoolean(
    legal?.enabled,
    'compliance.legal_consent.enabled',
  );
  const expectedPrivacyUrl = exactHttpsUrl(
    definitionString(legal?.privacy_policy_url, 'compliance.legal_consent.privacy_policy_url'),
    'checked privacy-policy URL',
  ).toString();
  const expectedTermsUrl = exactHttpsUrl(
    definitionString(legal?.terms_of_service_url, 'compliance.legal_consent.terms_of_service_url'),
    'checked terms-of-service URL',
  ).toString();
  requireValue(
    userSettings?.sign_up?.legal_consent_enabled === expectedLegalConsent,
    'legal-consent enabled state does not match',
  );
  requireValue(
    display?.privacy_policy_url === expectedPrivacyUrl,
    'privacy-policy URL does not match the checked definition',
  );
  requireValue(
    display?.terms_url === expectedTermsUrl,
    'terms URL does not match the checked definition',
  );

  const attackProtection = definition?.auth_attack_protection;
  const botProtection = attackProtection?.bot_protection;
  const expectedCaptchaEnabled = definitionBoolean(
    botProtection?.captcha_enabled,
    'auth_attack_protection.bot_protection.captcha_enabled',
  );
  const expectedCaptchaWidget = definitionString(
    botProtection?.captcha_widget_type,
    'auth_attack_protection.bot_protection.captcha_widget_type',
  );
  requireValue(
    userSettings?.sign_up?.captcha_enabled === expectedCaptchaEnabled,
    'CAPTCHA enabled state does not match',
  );
  requireValue(
    userSettings?.sign_up?.captcha_widget_type === expectedCaptchaWidget,
    'CAPTCHA sign-up widget type does not match',
  );
  if (expectedCaptchaEnabled) {
    requireValue(Boolean(display?.captcha_provider), 'CAPTCHA provider is disabled');
    requireValue(
      display?.captcha_widget_type === expectedCaptchaWidget,
      'CAPTCHA display widget type does not match',
    );
  }
  const expectedEnumerationProtection = enumerationProtectionEnabled(
    attackProtection?.enumeration_protection,
  );
  requireValue(
    userSettings?.attack_protection?.enumeration_protection?.enabled ===
      expectedEnumerationProtection,
    'enumeration protection does not match',
  );
  const expectedPiiProtection = definitionBoolean(
    attackProtection?.pii_protection_enabled,
    'auth_attack_protection.pii_protection_enabled',
  );
  requireValue(
    userSettings?.attack_protection?.pii?.enabled === expectedPiiProtection,
    'PII protection does not match',
  );
  const expectedLockoutEnabled = definitionBoolean(
    attackProtection?.user_lockout?.enabled,
    'auth_attack_protection.user_lockout.enabled',
  );
  const expectedLockoutAttempts = definitionInteger(
    attackProtection?.user_lockout?.max_attempts,
    'auth_attack_protection.user_lockout.max_attempts',
  );
  const expectedLockoutMinutes = definitionInteger(
    attackProtection?.user_lockout?.duration_in_minutes,
    'auth_attack_protection.user_lockout.duration_in_minutes',
  );
  if (expectedLockoutEnabled) {
    requireValue(
      expectedLockoutAttempts > 0,
      'checked definition user-lockout attempt limit must be positive when enabled',
    );
    requireValue(
      expectedLockoutMinutes > 0,
      'checked definition user-lockout duration must be positive when enabled',
    );
  }
  const publicLockout = userSettings?.attack_protection?.user_lockout;
  requireValue(
    publicLockout?.enabled === expectedLockoutEnabled,
    'user-lockout enabled state does not match',
  );
  requireValue(
    publicLockout?.max_attempts === expectedLockoutAttempts,
    'user-lockout attempt limit does not match',
  );
  requireValue(
    publicLockout?.duration_in_minutes === expectedLockoutMinutes,
    'user-lockout duration does not match',
  );

  const paths = definition?.paths;
  for (const [definitionName, publicName] of [
    ['home', 'home_url'],
    ['sign_in', 'sign_in_url'],
    ['sign_up', 'sign_up_url'],
    ['after_sign_out_all', 'after_sign_out_all_url'],
  ]) {
    const expected = expectedWebTarget(paths?.[definitionName], webUrl, definitionName);
    requireValue(display?.[publicName] === expected, `${definitionName} URL does not match`);
  }

  const expectedClerkBranding = definitionBoolean(
    definition?.branding?.show_clerk_branding,
    'branding.show_clerk_branding',
  );
  requireValue(display?.branded === expectedClerkBranding, 'Clerk branding state does not match');

  await verifyDeployedWeb({
    fetchImpl,
    issuerUrl,
    webUrl,
    probeUrl,
    probeHeaders,
    expectedInstanceEnvironment,
    settings,
  });

  return {
    instanceEnvironment: expectedInstanceEnvironment,
    issuer: issuerUrl.origin,
    webOrigin: webUrl.origin,
  };
}

export async function runCli({
  args = process.argv.slice(2),
  environmentVariables = process.env,
  fetchImpl = fetch,
  retryOptions,
} = {}) {
  const pinsOnly = args.at(-1) === '--pins-only';
  const positionalArgs = pinsOnly ? args.slice(0, -1) : args;
  if (
    positionalArgs.length < 4 ||
    positionalArgs.length > 5 ||
    (pinsOnly && positionalArgs.length !== 4)
  ) {
    throw new Error(
      'Usage: node verify-clerk-public-config.mjs <staging|production> <issuer> <web-origin> <authorized-parties> [probe-origin|--pins-only]',
    );
  }
  const [deploymentEnvironment, issuer, webBaseUrl, authorizedParties, probeBaseUrl = webBaseUrl] =
    positionalArgs;
  if (!deploymentEnvironment || !issuer || !webBaseUrl || !authorizedParties) {
    throw new Error(
      'Usage: node verify-clerk-public-config.mjs <staging|production> <issuer> <web-origin> <authorized-parties> [probe-origin|--pins-only]',
    );
  }
  const environments = JSON.parse(await readFile(ENVIRONMENTS_URL, 'utf8'));
  const pinnedEnvironment = environments?.[deploymentEnvironment];
  if (!pinnedEnvironment || typeof pinnedEnvironment !== 'object') {
    throw new Error(`Unknown checked Clerk deployment environment: ${deploymentEnvironment}`);
  }
  if (pinsOnly) {
    return verifyClerkEnvironmentPin({
      issuer,
      webBaseUrl,
      authorizedParties,
      expectedInstanceEnvironment: pinnedEnvironment.instance_environment,
      pinnedEnvironment,
    });
  }
  const definitionPath = definitionString(
    pinnedEnvironment.definition,
    'environment pin definition',
  );
  requireValue(
    /^infrastructure\/clerk\/[a-z0-9-]+\.json$/.test(definitionPath),
    'environment pin definition must be a checked Clerk JSON path',
  );
  const definition = JSON.parse(
    await readFile(new URL(`../../${definitionPath}`, import.meta.url), 'utf8'),
  );
  const result = await verifyClerkPublicConfig({
    definition,
    issuer,
    webBaseUrl,
    probeBaseUrl,
    authorizedParties,
    vercelAutomationBypassSecret: environmentVariables.VERCEL_AUTOMATION_BYPASS_SECRET,
    expectedInstanceEnvironment: pinnedEnvironment.instance_environment,
    pinnedEnvironment,
    fetchImpl,
    retryOptions,
  });
  return result;
}

async function main() {
  const result = await runCli();
  const scope =
    process.argv.at(-1) === '--pins-only'
      ? 'checked Clerk environment pins'
      : 'public Clerk and deployed web configuration';
  console.log(`Verified ${scope} for ${result.instanceEnvironment}.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
