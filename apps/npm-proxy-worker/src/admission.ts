import { DurableObject } from 'cloudflare:workers';

export type OriginRouteClass = 'metadata' | 'search' | 'audit' | 'tarball';

export interface AdmissionCandidate {
  clientIpHash: string;
  routeClass: OriginRouteClass;
}

export interface AdmissionDecision {
  allowed: boolean;
  reason?: 'per_ip_minute' | 'global_minute' | 'global_day' | 'route_minute' | 'route_day';
  retryAfterSeconds: number;
}

export interface AdmissionEnv {
  NPM_ORIGIN_PER_IP_MINUTE?: string;
  NPM_ORIGIN_GLOBAL_MINUTE?: string;
  NPM_ORIGIN_GLOBAL_DAY?: string;
  NPM_ORIGIN_METADATA_MINUTE?: string;
  NPM_ORIGIN_METADATA_DAY?: string;
  NPM_ORIGIN_SEARCH_MINUTE?: string;
  NPM_ORIGIN_SEARCH_DAY?: string;
  NPM_ORIGIN_AUDIT_MINUTE?: string;
  NPM_ORIGIN_AUDIT_DAY?: string;
  NPM_ORIGIN_TARBALL_MINUTE?: string;
  NPM_ORIGIN_TARBALL_DAY?: string;
}

type RouteCounters = Record<OriginRouteClass, number>;

interface AdmissionLimits {
  perIpMinute: number;
  globalMinute: number;
  globalDay: number;
  routeMinute: RouteCounters;
  routeDay: RouteCounters;
}

interface AdmissionLedger {
  schema: 1;
  minuteBucket: number;
  dayBucket: number;
  globalMinute: number;
  globalDay: number;
  perIpMinute: Record<string, number>;
  routeMinute: RouteCounters;
  routeDay: RouteCounters;
}

const LEDGER_KEY = 'origin-admission-ledger-v1';
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_CONFIGURED_LIMIT = 1_000_000;
const IP_HASH_PATTERN = /^[a-f0-9]{64}$/;

const DEFAULT_LIMITS: AdmissionLimits = {
  // A normal package-manager install may burst, so the per-client ceiling is
  // intentionally above npm's usual concurrency while remaining below the
  // global circuit breaker.
  perIpMinute: 1_200,
  globalMinute: 1_500,
  globalDay: 10_000,
  routeMinute: {
    metadata: 800,
    search: 15,
    audit: 10,
    tarball: 800,
  },
  routeDay: {
    metadata: 4_500,
    search: 250,
    audit: 250,
    tarball: 5_000,
  },
};

function emptyRouteCounters(): RouteCounters {
  return { metadata: 0, search: 0, audit: 0, tarball: 0 };
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error('Invalid npm origin admission limit.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CONFIGURED_LIMIT) {
    throw new Error('Invalid npm origin admission limit.');
  }
  return parsed;
}

function readLimits(env: AdmissionEnv): AdmissionLimits {
  return {
    perIpMinute: parseLimit(env.NPM_ORIGIN_PER_IP_MINUTE, DEFAULT_LIMITS.perIpMinute),
    globalMinute: parseLimit(env.NPM_ORIGIN_GLOBAL_MINUTE, DEFAULT_LIMITS.globalMinute),
    globalDay: parseLimit(env.NPM_ORIGIN_GLOBAL_DAY, DEFAULT_LIMITS.globalDay),
    routeMinute: {
      metadata: parseLimit(env.NPM_ORIGIN_METADATA_MINUTE, DEFAULT_LIMITS.routeMinute.metadata),
      search: parseLimit(env.NPM_ORIGIN_SEARCH_MINUTE, DEFAULT_LIMITS.routeMinute.search),
      audit: parseLimit(env.NPM_ORIGIN_AUDIT_MINUTE, DEFAULT_LIMITS.routeMinute.audit),
      tarball: parseLimit(env.NPM_ORIGIN_TARBALL_MINUTE, DEFAULT_LIMITS.routeMinute.tarball),
    },
    routeDay: {
      metadata: parseLimit(env.NPM_ORIGIN_METADATA_DAY, DEFAULT_LIMITS.routeDay.metadata),
      search: parseLimit(env.NPM_ORIGIN_SEARCH_DAY, DEFAULT_LIMITS.routeDay.search),
      audit: parseLimit(env.NPM_ORIGIN_AUDIT_DAY, DEFAULT_LIMITS.routeDay.audit),
      tarball: parseLimit(env.NPM_ORIGIN_TARBALL_DAY, DEFAULT_LIMITS.routeDay.tarball),
    },
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRouteCounters(value: unknown): value is RouteCounters {
  if (!value || typeof value !== 'object') return false;
  const counters = value as Partial<RouteCounters>;
  return (
    isNonNegativeInteger(counters.metadata) &&
    isNonNegativeInteger(counters.search) &&
    isNonNegativeInteger(counters.audit) &&
    isNonNegativeInteger(counters.tarball)
  );
}

function isLedger(value: unknown): value is AdmissionLedger {
  if (!value || typeof value !== 'object') return false;
  const ledger = value as Partial<AdmissionLedger>;
  if (
    ledger.schema !== 1 ||
    !isNonNegativeInteger(ledger.minuteBucket) ||
    !isNonNegativeInteger(ledger.dayBucket) ||
    !isNonNegativeInteger(ledger.globalMinute) ||
    !isNonNegativeInteger(ledger.globalDay) ||
    !isRouteCounters(ledger.routeMinute) ||
    !isRouteCounters(ledger.routeDay) ||
    !ledger.perIpMinute ||
    typeof ledger.perIpMinute !== 'object' ||
    Array.isArray(ledger.perIpMinute)
  ) {
    return false;
  }
  return Object.entries(ledger.perIpMinute).every(
    ([key, count]) => IP_HASH_PATTERN.test(key) && isNonNegativeInteger(count),
  );
}

function freshLedger(minuteBucket: number, dayBucket: number): AdmissionLedger {
  return {
    schema: 1,
    minuteBucket,
    dayBucket,
    globalMinute: 0,
    globalDay: 0,
    perIpMinute: {},
    routeMinute: emptyRouteCounters(),
    routeDay: emptyRouteCounters(),
  };
}

function rollWindows(ledger: AdmissionLedger, minuteBucket: number, dayBucket: number): void {
  if (ledger.minuteBucket !== minuteBucket) {
    ledger.minuteBucket = minuteBucket;
    ledger.globalMinute = 0;
    ledger.perIpMinute = {};
    ledger.routeMinute = emptyRouteCounters();
  }
  if (ledger.dayBucket !== dayBucket) {
    ledger.dayBucket = dayBucket;
    ledger.globalDay = 0;
    ledger.routeDay = emptyRouteCounters();
  }
}

function isCandidate(value: unknown): value is AdmissionCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AdmissionCandidate>;
  return (
    typeof candidate.clientIpHash === 'string' &&
    IP_HASH_PATTERN.test(candidate.clientIpHash) &&
    (candidate.routeClass === 'metadata' ||
      candidate.routeClass === 'search' ||
      candidate.routeClass === 'audit' ||
      candidate.routeClass === 'tarball')
  );
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function denied(
  reason: Exclude<AdmissionDecision['reason'], undefined>,
  now: number,
  minuteBucket: number,
  dayBucket: number,
): AdmissionDecision {
  const daily = reason === 'global_day' || reason === 'route_day';
  const boundary = daily ? (dayBucket + 1) * DAY_MS : (minuteBucket + 1) * MINUTE_MS;
  return {
    allowed: false,
    reason,
    retryAfterSeconds: Math.max(1, Math.ceil((boundary - now) / 1_000)),
  };
}

/**
 * Global, transactional admission ledger for npm-origin requests.
 *
 * The class is reachable only through its Durable Object binding. The public
 * Worker never forwards arbitrary requests to it.
 */
export class NpmAdmissionController extends DurableObject<AdmissionEnv> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/admit') {
      return json({ error: 'Not found' }, 404);
    }

    let candidate: unknown;
    try {
      candidate = await request.json();
    } catch {
      return json({ error: 'Invalid request' }, 400);
    }
    if (!isCandidate(candidate)) return json({ error: 'Invalid request' }, 400);

    let limits: AdmissionLimits;
    try {
      limits = readLimits(this.env);
    } catch {
      return json({ error: 'Admission controller is misconfigured' }, 503);
    }

    const now = Date.now();
    const minuteBucket = Math.floor(now / MINUTE_MS);
    const dayBucket = Math.floor(now / DAY_MS);

    try {
      const decision = await this.ctx.storage.transaction(async (transaction) => {
        const stored = await transaction.get<unknown>(LEDGER_KEY);
        if (stored !== undefined && !isLedger(stored)) {
          throw new Error('Npm admission ledger is invalid.');
        }
        const ledger = stored ?? freshLedger(minuteBucket, dayBucket);
        rollWindows(ledger, minuteBucket, dayBucket);

        const clientCount = ledger.perIpMinute[candidate.clientIpHash] ?? 0;
        if (clientCount >= limits.perIpMinute) {
          return denied('per_ip_minute', now, minuteBucket, dayBucket);
        }
        if (ledger.globalMinute >= limits.globalMinute) {
          return denied('global_minute', now, minuteBucket, dayBucket);
        }
        if (ledger.globalDay >= limits.globalDay) {
          return denied('global_day', now, minuteBucket, dayBucket);
        }
        if (ledger.routeMinute[candidate.routeClass] >= limits.routeMinute[candidate.routeClass]) {
          return denied('route_minute', now, minuteBucket, dayBucket);
        }
        if (ledger.routeDay[candidate.routeClass] >= limits.routeDay[candidate.routeClass]) {
          return denied('route_day', now, minuteBucket, dayBucket);
        }

        ledger.perIpMinute[candidate.clientIpHash] = clientCount + 1;
        ledger.globalMinute += 1;
        ledger.globalDay += 1;
        ledger.routeMinute[candidate.routeClass] += 1;
        ledger.routeDay[candidate.routeClass] += 1;
        await transaction.put(LEDGER_KEY, ledger);
        return {
          allowed: true,
          retryAfterSeconds: 0,
        } satisfies AdmissionDecision;
      });
      return json(decision);
    } catch (error) {
      console.error('npm origin admission transaction failed', error instanceof Error ? error.name : 'UnknownError');
      return json({ error: 'Admission controller is unavailable' }, 503);
    }
  }
}

export async function hashClientIp(request: Request): Promise<string> {
  const raw = request.headers.get('cf-connecting-ip')?.trim();
  // Cloudflare supplies and overwrites CF-Connecting-IP at the edge. Missing
  // or malformed values deliberately share one fail-safe identity.
  const identity = raw && raw.length <= 64 && /^[0-9a-f:.]+$/i.test(raw) ? raw.toLowerCase() : 'unknown';
  const bytes = new TextEncoder().encode(identity);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}
