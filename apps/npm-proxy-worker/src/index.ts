import { Hono } from 'hono';
import type {
  AdmissionCandidate,
  AdmissionDecision,
  AdmissionEnv,
} from './admission.js';
import {
  handleProxyRequest,
  METADATA_AUDIT_TIMEOUT_MS,
  TARBALL_TIMEOUT_MS,
  type ProxyDependencies,
  type ProxyRuntime,
} from './proxy.js';

export { NpmAdmissionController } from './admission.js';

export interface Env extends AdmissionEnv {
  NPM_ADMISSION_CONTROLLER?: DurableObjectNamespace;
  NPM_PROXY_ENABLED?: string;
  NPM_PROXY_PUBLIC_ORIGIN?: string;
  NPM_PROXY_PACKUMENT_MODE?: string;
}

const ADMISSION_TIMEOUT_MS = 2_000;

function isAdmissionDecision(value: unknown): value is AdmissionDecision {
  if (!value || typeof value !== 'object') return false;
  const decision = value as Partial<AdmissionDecision>;
  if (typeof decision.allowed !== 'boolean') return false;
  if (
    !Number.isSafeInteger(decision.retryAfterSeconds) ||
    (decision.retryAfterSeconds ?? -1) < 0 ||
    (decision.retryAfterSeconds ?? 0) > 86_400
  ) {
    return false;
  }
  if (decision.allowed) return decision.retryAfterSeconds === 0;
  return (
    decision.reason === 'per_ip_minute' ||
    decision.reason === 'global_minute' ||
    decision.reason === 'global_day' ||
    decision.reason === 'route_minute' ||
    decision.reason === 'route_day'
  );
}

async function requestAdmission(
  namespace: DurableObjectNamespace | undefined,
  candidate: AdmissionCandidate,
): Promise<AdmissionDecision> {
  if (!namespace) throw new Error('Npm admission controller binding is missing.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('admission timeout'), ADMISSION_TIMEOUT_MS);
  try {
    const id = namespace.idFromName('npm-origin-global-v1');
    const response = await namespace.get(id).fetch(
      new Request('https://npm-admission.internal/admit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(candidate),
        signal: controller.signal,
      }),
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Npm admission controller rejected its internal request.');
    }
    const decision: unknown = await response.json();
    if (!isAdmissionDecision(decision)) {
      throw new Error('Npm admission controller returned an invalid decision.');
    }
    return decision;
  } finally {
    clearTimeout(timeout);
  }
}

function defaultDependencies(): ProxyDependencies {
  return {
    fetch: (request) => globalThis.fetch(request),
    getCache: () => caches.default,
    admitOrigin: async () => {
      throw new Error('Npm admission controller binding is unavailable.');
    },
    metadataAuditTimeoutMs: METADATA_AUDIT_TIMEOUT_MS,
    tarballTimeoutMs: TARBALL_TIMEOUT_MS,
  };
}

export function createApp(overrides: Partial<ProxyDependencies> = {}): Hono<{ Bindings: Env }> {
  const defaults = defaultDependencies();
  const dependencies: ProxyDependencies = {
    fetch: overrides.fetch ?? defaults.fetch,
    getCache: overrides.getCache ?? defaults.getCache,
    admitOrigin: overrides.admitOrigin ?? defaults.admitOrigin,
    metadataAuditTimeoutMs: overrides.metadataAuditTimeoutMs ?? defaults.metadataAuditTimeoutMs,
    tarballTimeoutMs: overrides.tarballTimeoutMs ?? defaults.tarballTimeoutMs,
  };
  const app = new Hono<{ Bindings: Env }>();

  app.all('*', (context) => {
    const requestDependencies: ProxyDependencies = {
      ...dependencies,
      admitOrigin:
        overrides.admitOrigin ??
        ((candidate) => requestAdmission(context.env?.NPM_ADMISSION_CONTROLLER, candidate)),
    };
    const runtime: ProxyRuntime = {
      waitUntil(promise) {
        context.executionCtx.waitUntil(promise);
      },
    };
    return handleProxyRequest(
      context.req.raw,
      requestDependencies,
      runtime,
      context.env?.NPM_PROXY_ENABLED === 'true',
      crypto.randomUUID(),
      context.env?.NPM_PROXY_PUBLIC_ORIGIN,
      context.env?.NPM_PROXY_PACKUMENT_MODE,
    );
  });

  return app;
}

const app = createApp();

export default { fetch: app.fetch };
