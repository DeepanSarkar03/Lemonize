import { DurableObject } from 'cloudflare:workers';

export type OriginRouteClass = 'metadata' | 'search' | 'audit' | 'tarball';

export interface AdmissionCandidate {
  clientIpHash: string;
  routeClass: OriginRouteClass;
}

export interface AdmissionDecision {
  allowed: boolean;
  reason?:
    | 'client_route_minute'
    | 'client_route_day'
    | 'per_ip_minute'
    | 'global_minute'
    | 'global_day'
    | 'route_minute'
    | 'route_day';
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
  NPM_ORIGIN_CLIENT_METADATA_MINUTE?: string;
  NPM_ORIGIN_CLIENT_METADATA_DAY?: string;
  NPM_ORIGIN_CLIENT_SEARCH_MINUTE?: string;
  NPM_ORIGIN_CLIENT_SEARCH_DAY?: string;
  NPM_ORIGIN_CLIENT_AUDIT_MINUTE?: string;
  NPM_ORIGIN_CLIENT_AUDIT_DAY?: string;
  NPM_ORIGIN_CLIENT_TARBALL_MINUTE?: string;
  NPM_ORIGIN_CLIENT_TARBALL_DAY?: string;
}

type RouteCounters = Record<OriginRouteClass, number>;

interface AdmissionLimits {
  perIpMinute: number;
  globalMinute: number;
  globalDay: number;
  routeMinute: RouteCounters;
  routeDay: RouteCounters;
  clientRouteMinute: RouteCounters;
  clientRouteDay: RouteCounters;
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

interface ClientAdmissionLedger {
  schema: 1;
  minuteBucket: number;
  dayBucket: number;
  routeMinute: RouteCounters;
  routeDay: RouteCounters;
}

const LEDGER_KEY = 'origin-admission-ledger-v1';
const CLIENT_LEDGER_KEY = 'origin-client-admission-ledger-v1';
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const CLIENT_LEDGER_CLEANUP_DELAY_MS = 5 * MINUTE_MS;
const MAX_CONFIGURED_LIMIT = 1_000_000;
const IP_HASH_PATTERN = /^[a-f0-9]{64}$/;
const ROUTE_CLASSES: readonly OriginRouteClass[] = ['metadata', 'search', 'audit', 'tarball'];

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
  // Cache hits bypass admission. These per-client cold-miss ceilings leave at
  // least half of each global route budget available to other client identities.
  clientRouteMinute: {
    metadata: 400,
    search: 5,
    audit: 4,
    tarball: 400,
  },
  clientRouteDay: {
    metadata: 2_000,
    search: 100,
    audit: 100,
    tarball: 2_500,
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
  const limits: AdmissionLimits = {
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
    clientRouteMinute: {
      metadata: parseLimit(
        env.NPM_ORIGIN_CLIENT_METADATA_MINUTE,
        DEFAULT_LIMITS.clientRouteMinute.metadata,
      ),
      search: parseLimit(
        env.NPM_ORIGIN_CLIENT_SEARCH_MINUTE,
        DEFAULT_LIMITS.clientRouteMinute.search,
      ),
      audit: parseLimit(env.NPM_ORIGIN_CLIENT_AUDIT_MINUTE, DEFAULT_LIMITS.clientRouteMinute.audit),
      tarball: parseLimit(
        env.NPM_ORIGIN_CLIENT_TARBALL_MINUTE,
        DEFAULT_LIMITS.clientRouteMinute.tarball,
      ),
    },
    clientRouteDay: {
      metadata: parseLimit(
        env.NPM_ORIGIN_CLIENT_METADATA_DAY,
        DEFAULT_LIMITS.clientRouteDay.metadata,
      ),
      search: parseLimit(env.NPM_ORIGIN_CLIENT_SEARCH_DAY, DEFAULT_LIMITS.clientRouteDay.search),
      audit: parseLimit(env.NPM_ORIGIN_CLIENT_AUDIT_DAY, DEFAULT_LIMITS.clientRouteDay.audit),
      tarball: parseLimit(env.NPM_ORIGIN_CLIENT_TARBALL_DAY, DEFAULT_LIMITS.clientRouteDay.tarball),
    },
  };

  for (const routeClass of ROUTE_CLASSES) {
    if (
      limits.clientRouteMinute[routeClass] >= limits.routeMinute[routeClass] ||
      limits.clientRouteDay[routeClass] >= limits.routeDay[routeClass]
    ) {
      throw new Error('Per-client npm origin limits must be below global route limits.');
    }
  }
  return limits;
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

function isClientLedger(value: unknown): value is ClientAdmissionLedger {
  if (!value || typeof value !== 'object') return false;
  const ledger = value as Partial<ClientAdmissionLedger>;
  return (
    ledger.schema === 1 &&
    isNonNegativeInteger(ledger.minuteBucket) &&
    isNonNegativeInteger(ledger.dayBucket) &&
    isRouteCounters(ledger.routeMinute) &&
    isRouteCounters(ledger.routeDay)
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

function freshClientLedger(minuteBucket: number, dayBucket: number): ClientAdmissionLedger {
  return {
    schema: 1,
    minuteBucket,
    dayBucket,
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

function rollClientWindows(
  ledger: ClientAdmissionLedger,
  minuteBucket: number,
  dayBucket: number,
): void {
  if (ledger.minuteBucket !== minuteBucket) {
    ledger.minuteBucket = minuteBucket;
    ledger.routeMinute = emptyRouteCounters();
  }
  if (ledger.dayBucket !== dayBucket) {
    ledger.dayBucket = dayBucket;
    ledger.routeDay = emptyRouteCounters();
  }
}

function isCandidate(value: unknown): value is AdmissionCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AdmissionCandidate>;
  return (
    typeof candidate.clientIpHash === 'string' &&
    IP_HASH_PATTERN.test(candidate.clientIpHash) &&
    ROUTE_CLASSES.includes(candidate.routeClass as OriginRouteClass)
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
  const daily = reason === 'client_route_day' || reason === 'global_day' || reason === 'route_day';
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
  override async alarm(): Promise<void> {
    // Client ledgers have no value beyond their current daily window. Removing
    // the entire object prevents a stream of new IPs or IPv6 /64s from turning
    // rate-limit state into unbounded persistent Durable Object storage.
    await this.ctx.storage.deleteAll();
  }

  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method !== 'POST' || (pathname !== '/admit' && pathname !== '/admit-client')) {
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
      const decision =
        pathname === '/admit-client'
          ? await this.admitClient(candidate, limits, now, minuteBucket, dayBucket)
          : await this.admitGlobal(candidate, limits, now, minuteBucket, dayBucket);
      return json(decision);
    } catch (error) {
      console.error(
        'npm origin admission transaction failed',
        error instanceof Error ? error.name : 'UnknownError',
      );
      return json({ error: 'Admission controller is unavailable' }, 503);
    }
  }

  private async admitClient(
    candidate: AdmissionCandidate,
    limits: AdmissionLimits,
    now: number,
    minuteBucket: number,
    dayBucket: number,
  ): Promise<AdmissionDecision> {
    const cleanupAt = (dayBucket + 1) * DAY_MS + CLIENT_LEDGER_CLEANUP_DELAY_MS;
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null || existingAlarm < cleanupAt) {
      // Set the expiry before writing the ledger so an alarm failure cannot
      // leave newly-created client state without a cleanup path.
      await this.ctx.storage.setAlarm(cleanupAt);
    }
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(CLIENT_LEDGER_KEY);
      if (stored !== undefined && !isClientLedger(stored)) {
        throw new Error('Npm client admission ledger is invalid.');
      }
      const ledger = stored ?? freshClientLedger(minuteBucket, dayBucket);
      rollClientWindows(ledger, minuteBucket, dayBucket);

      if (
        ledger.routeMinute[candidate.routeClass] >= limits.clientRouteMinute[candidate.routeClass]
      ) {
        return denied('client_route_minute', now, minuteBucket, dayBucket);
      }
      if (ledger.routeDay[candidate.routeClass] >= limits.clientRouteDay[candidate.routeClass]) {
        return denied('client_route_day', now, minuteBucket, dayBucket);
      }

      ledger.routeMinute[candidate.routeClass] += 1;
      ledger.routeDay[candidate.routeClass] += 1;
      await transaction.put(CLIENT_LEDGER_KEY, ledger);
      return { allowed: true, retryAfterSeconds: 0 } satisfies AdmissionDecision;
    });
  }

  private async admitGlobal(
    candidate: AdmissionCandidate,
    limits: AdmissionLimits,
    now: number,
    minuteBucket: number,
    dayBucket: number,
  ): Promise<AdmissionDecision> {
    return this.ctx.storage.transaction(async (transaction) => {
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
  }
}

function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets as [number, number, number, number];
}

function parseIpv6(value: string): number[] | null {
  if (!value || value.includes('%')) return null;
  let normalized = value;
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    if (lastColon < 0) return null;
    const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
    if (!ipv4) return null;
    const high = (ipv4[0] << 8) | ipv4[1];
    const low = (ipv4[2] << 8) | ipv4[3];
    normalized = `${normalized.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const parts = half.split(':');
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  return omitted >= 1 ? [...left, ...Array.from({ length: omitted }, () => 0), ...right] : null;
}

function clientIdentity(raw: string | null): string {
  const value = raw?.trim();
  if (!value || value.length > 64) return 'unknown';
  const ipv4 = parseIpv4(value);
  if (ipv4) return `ipv4:${ipv4.join('.')}`;

  const ipv6 = parseIpv6(value);
  if (!ipv6) return 'unknown';
  const isIpv4Mapped = ipv6.slice(0, 5).every((part) => part === 0) && ipv6[5] === 0xffff;
  if (isIpv4Mapped) {
    return `ipv4:${ipv6[6]! >> 8}.${ipv6[6]! & 0xff}.${ipv6[7]! >> 8}.${ipv6[7]! & 0xff}`;
  }
  return `ipv6:${ipv6
    .slice(0, 4)
    .map((part) => part.toString(16).padStart(4, '0'))
    .join(':')}/64`;
}

export async function hashClientIp(request: Request): Promise<string> {
  // Cloudflare supplies and overwrites CF-Connecting-IP at the edge. Missing
  // or malformed values deliberately share one fail-safe identity. IPv6
  // privacy addresses are grouped by their network /64 before hashing.
  const identity = clientIdentity(request.headers.get('cf-connecting-ip'));
  const bytes = new TextEncoder().encode(identity);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}
