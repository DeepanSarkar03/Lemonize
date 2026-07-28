import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { runCli, verifyClerkPublicConfig } from './verify-clerk-public-config.mjs';

const ISSUER = 'https://clerk-review.example';
const WEB_ORIGIN = 'https://web-review.example';
const PROBE_ORIGIN = 'https://lemonize-review-deployment.vercel.app';
const VERCEL_BYPASS_SECRET = 'review-bypass-secret-12345';
const definition = JSON.parse(
  await readFile(new URL('../../infrastructure/clerk/production.json', import.meta.url), 'utf8'),
);
const developmentDefinition = JSON.parse(
  await readFile(new URL('../../infrastructure/clerk/development.json', import.meta.url), 'utf8'),
);
const checkedEnvironments = JSON.parse(
  await readFile(new URL('../../infrastructure/clerk/environments.json', import.meta.url), 'utf8'),
);
const pinnedEnvironment = {
  definition: 'infrastructure/clerk/production.json',
  issuer: ISSUER,
  web_origin: WEB_ORIGIN,
  authorized_parties: [WEB_ORIGIN],
  instance_environment: 'production',
};
const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicExponent: 0x10001,
});
const signingJwk = {
  ...publicKey.export({ format: 'jwk' }),
  alg: 'RS256',
  kid: 'clerk-review-key',
  use: 'sig',
};

function publishableKey(prefix, host) {
  return `${prefix}${Buffer.from(`${host}$`).toString('base64url')}`;
}

function validEnvironment() {
  return {
    auth_config: {
      test_mode: false,
      identification_strategies: ['email_address', 'oauth_github'],
      first_factors: ['email_code', 'oauth_github', 'ticket'],
      email_address_verification_strategies: ['email_code'],
    },
    display_config: {
      instance_environment_type: 'production',
      branded: true,
      captcha_provider: 'turnstile',
      captcha_widget_type: 'smart',
      privacy_policy_url: definition.compliance.legal_consent.privacy_policy_url,
      terms_url: definition.compliance.legal_consent.terms_of_service_url,
      home_url: `${WEB_ORIGIN}/`,
      sign_in_url: `${WEB_ORIGIN}/login`,
      sign_up_url: `${WEB_ORIGIN}/login`,
      after_sign_out_all_url: `${WEB_ORIGIN}/`,
    },
    user_settings: {
      attributes: {
        password: {
          enabled: false,
          required: false,
        },
        email_address: {
          enabled: true,
          required: true,
          used_for_first_factor: true,
          first_factors: ['email_code'],
          verifications: ['email_code'],
          verify_at_sign_up: true,
        },
        username: {
          enabled: false,
          required: false,
          used_for_first_factor: false,
          immutable: true,
        },
      },
      social: {
        oauth_github: {
          enabled: true,
          authenticatable: true,
          block_email_subaddresses: true,
        },
      },
      sign_up: {
        mode: 'public',
        legal_consent_enabled: true,
        captcha_enabled: true,
        captcha_widget_type: 'smart',
      },
      restrictions: {
        allowlist: { enabled: false },
        allowlist_blocklist_disabled_on_sign_in: { enabled: true },
        block_disposable_email_domains: { enabled: true },
        block_email_subaddresses: { enabled: true },
      },
      attack_protection: {
        enumeration_protection: { enabled: true },
        pii: { enabled: true },
        user_lockout: {
          enabled: true,
          max_attempts: 10,
          duration_in_minutes: 60,
        },
      },
    },
  };
}

function responseAt(response, url) {
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function fakeFetch({
  environment = validEnvironment(),
  jwks = { keys: [signingJwk] },
  loginHtml = publishableKey('pk_live_', 'clerk-review.example'),
  loginUrl,
  dashboardStatus = 307,
  dashboardLocation = '/login',
} = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url: url.toString(), init });
    if (url.pathname === '/.well-known/jwks.json') return Response.json(jwks);
    if (url.pathname === '/v1/environment') return Response.json(environment);
    if (url.pathname === '/login') {
      return responseAt(new Response(loginHtml, { status: 200 }), loginUrl ?? url.toString());
    }
    if (url.pathname === '/dashboard') {
      return new Response(null, {
        status: dashboardStatus,
        headers: dashboardLocation === null ? undefined : { location: dashboardLocation },
      });
    }
    return new Response(null, { status: 404 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function verify({
  checkedDefinition = structuredClone(definition),
  environment = validEnvironment(),
  issuer = ISSUER,
  webBaseUrl = WEB_ORIGIN,
  probeBaseUrl = webBaseUrl,
  authorizedParties = [WEB_ORIGIN],
  vercelAutomationBypassSecret,
  expectedInstanceEnvironment = 'production',
  checkedEnvironment = structuredClone(pinnedEnvironment),
  jwks,
  loginHtml,
  loginUrl,
  dashboardStatus,
  dashboardLocation,
  fetchImpl: suppliedFetch,
  retryOptions = { maxAttempts: 3, baseDelayMs: 0, sleep: async () => {} },
} = {}) {
  const fetchImpl =
    suppliedFetch ??
    fakeFetch({
      environment,
      ...(jwks === undefined ? {} : { jwks }),
      ...(loginHtml === undefined ? {} : { loginHtml }),
      ...(loginUrl === undefined ? {} : { loginUrl }),
      ...(dashboardStatus === undefined ? {} : { dashboardStatus }),
      ...(dashboardLocation === undefined ? {} : { dashboardLocation }),
    });
  return {
    fetchImpl,
    result: verifyClerkPublicConfig({
      definition: checkedDefinition,
      issuer,
      webBaseUrl,
      probeBaseUrl,
      authorizedParties,
      vercelAutomationBypassSecret,
      expectedInstanceEnvironment,
      pinnedEnvironment: checkedEnvironment,
      fetchImpl,
      retryOptions,
    }),
  };
}

test('accepts the complete expected public Clerk and web configuration', async () => {
  const { fetchImpl, result } = verify();
  assert.deepEqual(await result, {
    instanceEnvironment: 'production',
    issuer: ISSUER,
    webOrigin: WEB_ORIGIN,
  });
  const loginCall = fetchImpl.calls.find(({ url }) => url === `${WEB_ORIGIN}/login`);
  assert.equal(loginCall?.init.redirect, 'error');
});

test('probes a separate protected Vercel deployment without changing stable Clerk paths', async () => {
  const { fetchImpl, result } = verify({
    probeBaseUrl: PROBE_ORIGIN,
    vercelAutomationBypassSecret: VERCEL_BYPASS_SECRET,
  });
  assert.equal((await result).webOrigin, WEB_ORIGIN);

  const webCalls = fetchImpl.calls.filter(({ url }) => new URL(url).origin === PROBE_ORIGIN);
  assert.deepEqual(
    webCalls.map(({ url }) => new URL(url).pathname),
    ['/login', '/dashboard'],
  );
  for (const { init } of webCalls) {
    assert.equal(init.headers['x-vercel-protection-bypass'], VERCEL_BYPASS_SECRET);
  }
  const providerCalls = fetchImpl.calls.filter(({ url }) => new URL(url).origin === ISSUER);
  assert.equal(providerCalls.length, 2);
  for (const { init } of providerCalls) {
    assert.equal(init.headers['x-vercel-protection-bypass'], undefined);
  }
});

test('requires a bypass secret for a separate protected deployment probe', async () => {
  await assert.rejects(
    verify({ probeBaseUrl: PROBE_ORIGIN }).result,
    /requires a valid Vercel automation bypass secret/,
  );
});

test('never sends a Vercel bypass secret to a non-Vercel probe origin', async () => {
  await assert.rejects(
    verify({
      probeBaseUrl: 'https://attacker.example',
      vercelAutomationBypassSecret: VERCEL_BYPASS_SECRET,
    }).result,
    /must be a Vercel deployment hostname/,
  );
});

test('rejects a bypass secret when checking the stable public origin', async () => {
  await assert.rejects(
    verify({ vercelAutomationBypassSecret: VERCEL_BYPASS_SECRET }).result,
    /must be used only for a separate deployment probe origin/,
  );
});

test('CLI wiring forwards the exact probe origin and bypass header while retaining production pins', async () => {
  const productionPin = checkedEnvironments.production;
  const productionWebOrigin = productionPin.web_origin;
  const productionIssuer = productionPin.issuer;
  const environment = validEnvironment();
  environment.display_config.home_url = `${productionWebOrigin}/`;
  environment.display_config.sign_in_url = `${productionWebOrigin}/login`;
  environment.display_config.sign_up_url = `${productionWebOrigin}/login`;
  environment.display_config.after_sign_out_all_url = `${productionWebOrigin}/`;
  const fetchImpl = fakeFetch({
    environment,
    loginHtml: publishableKey('pk_live_', new URL(productionIssuer).hostname),
  });

  const result = await runCli({
    args: [
      'production',
      productionIssuer,
      productionWebOrigin,
      productionPin.authorized_parties.join(','),
      PROBE_ORIGIN,
    ],
    environmentVariables: { VERCEL_AUTOMATION_BYPASS_SECRET: VERCEL_BYPASS_SECRET },
    fetchImpl,
    retryOptions: { maxAttempts: 1, baseDelayMs: 0, sleep: async () => {} },
  });
  assert.equal(result.webOrigin, productionWebOrigin);
  const webCalls = fetchImpl.calls.filter(({ url }) => new URL(url).origin === PROBE_ORIGIN);
  assert.equal(webCalls.length, 2);
  assert.ok(
    webCalls.every(
      ({ init }) => init.headers['x-vercel-protection-bypass'] === VERCEL_BYPASS_SECRET,
    ),
  );
});

test('CLI pins-only mode validates checked inputs without making a network request', async () => {
  const productionPin = checkedEnvironments.production;
  let networkCalls = 0;
  const result = await runCli({
    args: [
      'production',
      productionPin.issuer,
      productionPin.web_origin,
      productionPin.authorized_parties.join(','),
      '--pins-only',
    ],
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error('pins-only mode must not fetch');
    },
  });
  assert.equal(result.instanceEnvironment, 'production');
  assert.equal(result.issuer, productionPin.issuer);
  assert.equal(result.webOrigin, productionPin.web_origin);
  assert.deepEqual(result.authorizedParties, productionPin.authorized_parties);
  assert.equal(networkCalls, 0);
});

test('accepts the real development.json only with test mode and a test publishable key', async () => {
  const environment = validEnvironment();
  environment.auth_config.test_mode = true;
  environment.display_config.instance_environment_type = 'development';
  const fetchImpl = fakeFetch({
    environment,
    loginHtml: publishableKey('pk_test_', 'clerk-review.example'),
  });
  const result = await verify({
    checkedDefinition: structuredClone(developmentDefinition),
    expectedInstanceEnvironment: 'development',
    checkedEnvironment: {
      ...structuredClone(pinnedEnvironment),
      definition: 'infrastructure/clerk/development.json',
      instance_environment: 'development',
    },
    fetchImpl,
  }).result;
  assert.equal(result.instanceEnvironment, 'development');
});

const publicDriftCases = [
  [
    'instance environment type',
    (value) => (value.display_config.instance_environment_type = 'development'),
  ],
  ['test-mode state', (value) => (value.auth_config.test_mode = true)],
  ['sign-up mode', (value) => (value.user_settings.sign_up.mode = 'restricted')],
  ['allowlist', (value) => (value.user_settings.restrictions.allowlist.enabled = true)],
  [
    'allowlist/blocklist sign-in enforcement',
    (value) =>
      (value.user_settings.restrictions.allowlist_blocklist_disabled_on_sign_in.enabled = false),
  ],
  [
    'disposable-email blocking',
    (value) => (value.user_settings.restrictions.block_disposable_email_domains.enabled = false),
  ],
  [
    'email-subaddress blocking',
    (value) => (value.user_settings.restrictions.block_email_subaddresses.enabled = false),
  ],
  ['password enabled state', (value) => (value.user_settings.attributes.password.enabled = true)],
  ['password required state', (value) => (value.user_settings.attributes.password.required = true)],
  [
    'email sign-up state',
    (value) => (value.user_settings.attributes.email_address.enabled = false),
  ],
  [
    'email sign-in state',
    (value) => (value.user_settings.attributes.email_address.used_for_first_factor = false),
  ],
  [
    'email required state',
    (value) => (value.user_settings.attributes.email_address.required = false),
  ],
  [
    'email verification-at-sign-up state',
    (value) => (value.user_settings.attributes.email_address.verify_at_sign_up = false),
  ],
  [
    'email sign-in strategies',
    (value) => (value.user_settings.attributes.email_address.first_factors = ['email_link']),
  ],
  [
    'email verification strategies',
    (value) => (value.user_settings.attributes.email_address.verifications = ['email_link']),
  ],
  ['username sign-up state', (value) => (value.user_settings.attributes.username.enabled = true)],
  [
    'username sign-in state',
    (value) => (value.user_settings.attributes.username.used_for_first_factor = true),
  ],
  ['username required state', (value) => (value.user_settings.attributes.username.required = true)],
  ['username immutability', (value) => (value.user_settings.attributes.username.immutable = false)],
  ['GitHub enabled state', (value) => (value.user_settings.social.oauth_github.enabled = false)],
  [
    'GitHub authenticatable state',
    (value) => (value.user_settings.social.oauth_github.authenticatable = false),
  ],
  [
    'GitHub email-subaddress policy',
    (value) => (value.user_settings.social.oauth_github.block_email_subaddresses = false),
  ],
  [
    'broadened phone identification strategy',
    (value) => value.auth_config.identification_strategies.push('phone_number'),
  ],
  [
    'broadened password identification strategy',
    (value) => value.auth_config.identification_strategies.push('password'),
  ],
  ['broadened phone first factor', (value) => value.auth_config.first_factors.push('phone_code')],
  [
    'missing provider-internal ticket factor',
    (value) =>
      (value.auth_config.first_factors = value.auth_config.first_factors.filter(
        (item) => item !== 'ticket',
      )),
  ],
  [
    'legal-consent enabled state',
    (value) => (value.user_settings.sign_up.legal_consent_enabled = false),
  ],
  [
    'privacy-policy URL',
    (value) => (value.display_config.privacy_policy_url = 'https://lemonize.cyou/wrong-privacy'),
  ],
  [
    'terms-of-service URL',
    (value) => (value.display_config.terms_url = 'https://lemonize.cyou/wrong-terms'),
  ],
  ['CAPTCHA enabled state', (value) => (value.user_settings.sign_up.captcha_enabled = false)],
  [
    'CAPTCHA widget type',
    (value) => (value.user_settings.sign_up.captcha_widget_type = 'invisible'),
  ],
  [
    'enumeration protection',
    (value) => (value.user_settings.attack_protection.enumeration_protection.enabled = false),
  ],
  ['PII protection', (value) => (value.user_settings.attack_protection.pii.enabled = false)],
  [
    'user-lockout enabled state',
    (value) => (value.user_settings.attack_protection.user_lockout.enabled = false),
  ],
  [
    'user-lockout attempt limit',
    (value) => (value.user_settings.attack_protection.user_lockout.max_attempts = 11),
  ],
  [
    'user-lockout duration',
    (value) => (value.user_settings.attack_protection.user_lockout.duration_in_minutes = 30),
  ],
  [
    'home path',
    (value) => (value.display_config.home_url = 'https://clerk.example/default-redirect'),
  ],
  ['sign-in path', (value) => (value.display_config.sign_in_url = 'https://clerk.example/sign-in')],
  ['sign-up path', (value) => (value.display_config.sign_up_url = 'https://clerk.example/sign-up')],
  [
    'after-sign-out path',
    (value) => (value.display_config.after_sign_out_all_url = 'https://clerk.example/sign-in'),
  ],
  ['Clerk branding state', (value) => (value.display_config.branded = false)],
];

for (const [name, mutate] of publicDriftCases) {
  test(`rejects ${name} drift`, async () => {
    const environment = validEnvironment();
    mutate(environment);
    await assert.rejects(verify({ environment }).result, /Clerk public configuration drift/);
  });
}

test('rejects a checked definition that silently omits a required security setting', async () => {
  const checkedDefinition = structuredClone(definition);
  delete checkedDefinition.auth_attack_protection.user_lockout.max_attempts;
  await assert.rejects(
    verify({ checkedDefinition }).result,
    /checked definition auth_attack_protection\.user_lockout\.max_attempts/,
  );
});

test('rejects a legal-consent definition without an explicit boolean enabled state', async () => {
  const checkedDefinition = structuredClone(definition);
  delete checkedDefinition.compliance.legal_consent.enabled;
  await assert.rejects(
    verify({ checkedDefinition }).result,
    /checked definition compliance\.legal_consent\.enabled must be a boolean/,
  );
});

test('accepts explicitly disabled legal consent only when the live state is also disabled', async () => {
  const checkedDefinition = structuredClone(definition);
  checkedDefinition.compliance.legal_consent.enabled = false;
  const environment = validEnvironment();
  environment.user_settings.sign_up.legal_consent_enabled = false;
  await verify({ checkedDefinition, environment }).result;
});

test('rejects live legal consent when the checked definition explicitly disables it', async () => {
  const checkedDefinition = structuredClone(definition);
  checkedDefinition.compliance.legal_consent.enabled = false;
  await assert.rejects(
    verify({ checkedDefinition }).result,
    /legal-consent enabled state does not match/,
  );
});

test('rejects invalid configured legal URLs before accepting matching live strings', async () => {
  const checkedDefinition = structuredClone(definition);
  checkedDefinition.compliance.legal_consent.privacy_policy_url = 'http://lemonize.cyou/privacy';
  const environment = validEnvironment();
  environment.display_config.privacy_policy_url = 'http://lemonize.cyou/privacy';
  await assert.rejects(verify({ checkedDefinition, environment }).result, /exact HTTPS URL/);
});

for (const [field, label] of [
  ['max_attempts', 'attempt limit'],
  ['duration_in_minutes', 'duration'],
]) {
  test(`rejects a zero user-lockout ${label} while lockout is enabled`, async () => {
    const checkedDefinition = structuredClone(definition);
    checkedDefinition.auth_attack_protection.user_lockout[field] = 0;
    await assert.rejects(verify({ checkedDefinition }).result, /must be positive when enabled/);
  });
}

test('requires authorized parties to contain the exact stable web origin', async () => {
  await assert.rejects(
    verify({ authorizedParties: ['https://another-web.example'] }).result,
    /do not contain the stable web origin/,
  );
});

test('rejects authorized-party expansion beyond the checked environment pin', async () => {
  await assert.rejects(
    verify({ authorizedParties: [WEB_ORIGIN, 'https://extra.example'] }).result,
    /authorized parties do not match the checked environment pin/,
  );
});

test('rejects non-origin authorized-party values', async () => {
  await assert.rejects(
    verify({ authorizedParties: `${WEB_ORIGIN}/login` }).result,
    /must be an exact HTTPS origin/,
  );
});

test('checked environment pins reject a coordinated wrong issuer and web origin before fetching', async () => {
  const fetchImpl = fakeFetch();
  await assert.rejects(
    verify({
      issuer: 'https://wrong-clerk.example',
      webBaseUrl: 'https://wrong-web.example',
      authorizedParties: ['https://wrong-web.example'],
      fetchImpl,
    }).result,
    /issuer does not match the checked environment pin/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('checked infrastructure environment map pins both deployable environments', () => {
  assert.deepEqual(checkedEnvironments, {
    staging: {
      definition: 'infrastructure/clerk/development.json',
      issuer: 'https://hip-goshawk-51.clerk.accounts.dev',
      web_origin: 'https://lemonize-staging.vercel.app',
      authorized_parties: ['https://lemonize-staging.vercel.app'],
      instance_environment: 'development',
    },
    production: {
      definition: 'infrastructure/clerk/production.json',
      issuer: 'https://clerk.lemonize.cyou',
      web_origin: 'https://lemonize.cyou',
      authorized_parties: ['https://lemonize.cyou', 'https://www.lemonize.cyou'],
      instance_environment: 'production',
    },
  });
});

const invalidJwkCases = [
  ['missing modulus', { ...signingJwk, n: undefined }],
  ['missing exponent', { ...signingJwk, e: undefined }],
  ['invalid modulus encoding', { ...signingJwk, n: 'not+base64url' }],
  ['encryption use', { ...signingJwk, use: 'enc' }],
  ['undersized RSA material', { ...signingJwk, n: 'AQ', e: 'AQAB' }],
  ['incompatible key operations', { ...signingJwk, key_ops: ['encrypt'] }],
];

for (const [name, key] of invalidJwkCases) {
  test(`rejects a JWKS key with ${name}`, async () => {
    await assert.rejects(
      verify({ jwks: { keys: [key] } }).result,
      /Clerk public configuration drift/,
    );
  });
}

test('rejects duplicate signing-key IDs', async () => {
  await assert.rejects(
    verify({ jwks: { keys: [signingJwk, { ...signingJwk }] } }).result,
    /unique non-empty key IDs/,
  );
});

test('rejects a login response that changes origin', async () => {
  await assert.rejects(
    verify({ loginUrl: 'https://attacker.example/login' }).result,
    /login page changed origin or path/,
  );
});

test('rejects a login response that changes path or adds a query', async () => {
  await assert.rejects(
    verify({ loginUrl: `${WEB_ORIGIN}/login?continue=1` }).result,
    /login page changed origin or path/,
  );
});

test('rejects multiple distinct same-environment publishable-key hosts', async () => {
  const loginHtml = [
    publishableKey('pk_live_', 'attacker-clerk.example'),
    publishableKey('pk_live_', 'clerk-review.example'),
  ].join(' ');
  await assert.rejects(verify({ loginHtml }).result, /multiple Clerk publishable-key hosts/);
});

test('rejects an opposite-environment publishable key', async () => {
  const loginHtml = [
    publishableKey('pk_test_', 'clerk-review.example'),
    publishableKey('pk_live_', 'clerk-review.example'),
  ].join(' ');
  await assert.rejects(verify({ loginHtml }).result, /wrong key type/);
});

test('permits repeated keys only when every decoded key uses the one expected host', async () => {
  const key = publishableKey('pk_live_', 'clerk-review.example');
  await verify({ loginHtml: `${key} ${key}` }).result;
});

test('rejects an unauthenticated dashboard redirect outside the probed login page', async () => {
  await assert.rejects(
    verify({ dashboardLocation: 'https://attacker.example/login' }).result,
    /dashboard redirects outside the probed web origin/,
  );
});

test('retries transient provider network, 429, and 5xx failures with bounded backoff', async () => {
  const baseFetch = fakeFetch();
  let environmentAttempts = 0;
  const sleeps = [];
  const fetchImpl = async (input, init) => {
    if (new URL(input).pathname === '/v1/environment') {
      environmentAttempts += 1;
      if (environmentAttempts === 1) throw new Error('temporary network failure');
      if (environmentAttempts === 2) return new Response(null, { status: 429 });
      if (environmentAttempts === 3) return new Response(null, { status: 503 });
    }
    return baseFetch(input, init);
  };
  await verify({
    fetchImpl,
    retryOptions: {
      maxAttempts: 5,
      baseDelayMs: 10,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    },
  }).result;
  assert.equal(environmentAttempts, 4);
  assert.deepEqual(sleeps, [10, 20, 40]);
});

test('does not retry deterministic provider HTTP failures', async () => {
  const baseFetch = fakeFetch();
  let environmentAttempts = 0;
  const fetchImpl = async (input, init) => {
    if (new URL(input).pathname === '/v1/environment') {
      environmentAttempts += 1;
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    return baseFetch(input, init);
  };
  await assert.rejects(verify({ fetchImpl }).result, /environment endpoint returned HTTP 401/);
  assert.equal(environmentAttempts, 1);
});

test('rejects a missing JSON content type without retrying', async () => {
  const baseFetch = fakeFetch();
  let environmentAttempts = 0;
  const fetchImpl = async (input, init) => {
    if (new URL(input).pathname === '/v1/environment') {
      environmentAttempts += 1;
      return new Response('{}', { status: 200 });
    }
    return baseFetch(input, init);
  };
  await assert.rejects(verify({ fetchImpl }).result, /did not return a JSON content type/);
  assert.equal(environmentAttempts, 1);
});

test('rejects malformed provider JSON without retrying deterministic parsing drift', async () => {
  const baseFetch = fakeFetch();
  let environmentAttempts = 0;
  const fetchImpl = async (input, init) => {
    if (new URL(input).pathname === '/v1/environment') {
      environmentAttempts += 1;
      return new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return baseFetch(input, init);
  };
  await assert.rejects(verify({ fetchImpl }).result, /did not return valid JSON/);
  assert.equal(environmentAttempts, 1);
});

test('does not retry deterministic public-policy drift', async () => {
  const environment = validEnvironment();
  environment.user_settings.attack_protection.pii.enabled = false;
  const fetchImpl = fakeFetch({ environment });
  const sleeps = [];
  await assert.rejects(
    verify({
      fetchImpl,
      retryOptions: {
        maxAttempts: 5,
        baseDelayMs: 10,
        sleep: async (milliseconds) => sleeps.push(milliseconds),
      },
    }).result,
    /PII protection does not match/,
  );
  assert.equal(
    fetchImpl.calls.filter(({ url }) => new URL(url).pathname === '/v1/environment').length,
    1,
  );
  assert.deepEqual(sleeps, []);
});

test('does not retry deterministic drift on an immutable exact deployment', async () => {
  const fetchImpl = fakeFetch({
    loginHtml: publishableKey('pk_live_', 'wrong-clerk.example'),
  });
  const sleeps = [];
  await assert.rejects(
    verify({
      probeBaseUrl: PROBE_ORIGIN,
      vercelAutomationBypassSecret: VERCEL_BYPASS_SECRET,
      fetchImpl,
      retryOptions: {
        maxAttempts: 5,
        baseDelayMs: 10,
        sleep: async (milliseconds) => sleeps.push(milliseconds),
      },
    }).result,
    /publishable-key host does not match/,
  );
  assert.equal(fetchImpl.calls.filter(({ url }) => new URL(url).pathname === '/login').length, 1);
  assert.deepEqual(sleeps, []);
});

test('retries bounded alias propagation until the expected login key appears', async () => {
  const baseFetch = fakeFetch();
  let loginAttempts = 0;
  const sleeps = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/login') {
      loginAttempts += 1;
      if (loginAttempts < 3) return responseAt(new Response('old deployment'), url.toString());
    }
    return baseFetch(input, init);
  };
  await verify({
    fetchImpl,
    retryOptions: {
      maxAttempts: 4,
      baseDelayMs: 5,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    },
  }).result;
  assert.equal(loginAttempts, 3);
  assert.deepEqual(sleeps, [5, 10]);
});

test('fails after the bounded alias propagation retry budget', async () => {
  const fetchImpl = fakeFetch({ loginHtml: 'old deployment' });
  const sleeps = [];
  await assert.rejects(
    verify({
      fetchImpl,
      retryOptions: {
        maxAttempts: 3,
        baseDelayMs: 5,
        sleep: async (milliseconds) => sleeps.push(milliseconds),
      },
    }).result,
    /deployed web alias did not stabilize after 3 attempts/,
  );
  assert.equal(fetchImpl.calls.filter(({ url }) => new URL(url).pathname === '/login').length, 3);
  assert.deepEqual(sleeps, [5, 10]);
});
