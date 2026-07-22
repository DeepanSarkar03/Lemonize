import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { hashClientIp, type AdmissionCandidate, type AdmissionDecision } from '../src/admission.js';

function actor(name: string): DurableObjectStub {
  const id = env.NPM_ADMISSION_CONTROLLER.idFromName(name);
  return env.NPM_ADMISSION_CONTROLLER.get(id);
}

async function admit(
  stub: DurableObjectStub,
  candidate: AdmissionCandidate,
  endpoint: '/admit' | '/admit-client' = '/admit',
): Promise<AdmissionDecision> {
  const response = await stub.fetch(
    new Request(`https://npm-admission.internal${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(candidate),
    }),
  );
  expect(response.status).toBe(200);
  return response.json<AdmissionDecision>();
}

describe('NpmAdmissionController', () => {
  it('atomically enforces the per-IP minute limit under concurrency', async () => {
    const stub = actor(`per-ip-${crypto.randomUUID()}`);
    const candidate: AdmissionCandidate = {
      clientIpHash: 'a'.repeat(64),
      routeClass: 'metadata',
    };
    const decisions = await Promise.all(Array.from({ length: 8 }, () => admit(stub, candidate)));

    expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(3);
    expect(decisions.filter(({ allowed }) => !allowed)).toHaveLength(5);
    expect(
      decisions.filter(({ allowed }) => !allowed).every(({ reason }) => reason === 'per_ip_minute'),
    ).toBe(true);

    const otherClient = await admit(stub, {
      clientIpHash: 'b'.repeat(64),
      routeClass: 'metadata',
    });
    expect(otherClient.allowed).toBe(true);
  });

  it('applies route-class limits independently while retaining a global budget', async () => {
    const stub = actor(`route-${crypto.randomUUID()}`);
    const searches = await Promise.all(
      ['1', '2', '3'].map((digit) =>
        admit(stub, {
          clientIpHash: digit.repeat(64),
          routeClass: 'search',
        }),
      ),
    );
    expect(searches.filter(({ allowed }) => allowed)).toHaveLength(2);
    expect(searches.find(({ allowed }) => !allowed)?.reason).toBe('route_minute');

    const metadata = await admit(stub, {
      clientIpHash: '4'.repeat(64),
      routeClass: 'metadata',
    });
    expect(metadata.allowed).toBe(true);
  });

  it('atomically caps all origin classes with the global minute budget', async () => {
    const stub = actor(`global-minute-${crypto.randomUUID()}`);
    const decisions = await Promise.all(
      ['1', '2', '3', '4', '5', '6'].map((digit) =>
        admit(stub, {
          clientIpHash: digit.repeat(64),
          routeClass: 'metadata',
        }),
      ),
    );

    expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(5);
    expect(decisions.find(({ allowed }) => !allowed)?.reason).toBe('global_minute');
  });

  it('enforces persisted global and route daily budgets', async () => {
    const now = Date.now();
    const baseLedger = {
      schema: 1,
      minuteBucket: Math.floor(now / 60_000),
      dayBucket: Math.floor(now / 86_400_000),
      globalMinute: 0,
      globalDay: 0,
      perIpMinute: {},
      routeMinute: { metadata: 0, search: 0, audit: 0, tarball: 0 },
      routeDay: { metadata: 0, search: 0, audit: 0, tarball: 0 },
    };

    const globalStub = actor(`global-day-${crypto.randomUUID()}`);
    await globalStub.fetch('https://npm-admission.internal/');
    await runInDurableObject(globalStub, async (_instance, state) => {
      await state.storage.put('origin-admission-ledger-v1', {
        ...baseLedger,
        globalDay: 10,
      });
    });
    const globalDecision = await admit(globalStub, {
      clientIpHash: 'a'.repeat(64),
      routeClass: 'metadata',
    });
    expect(globalDecision).toMatchObject({ allowed: false, reason: 'global_day' });

    const routeStub = actor(`route-day-${crypto.randomUUID()}`);
    await routeStub.fetch('https://npm-admission.internal/');
    await runInDurableObject(routeStub, async (_instance, state) => {
      await state.storage.put('origin-admission-ledger-v1', {
        ...baseLedger,
        routeDay: { ...baseLedger.routeDay, search: 4 },
      });
    });
    const routeDecision = await admit(routeStub, {
      clientIpHash: 'b'.repeat(64),
      routeClass: 'search',
    });
    expect(routeDecision).toMatchObject({ allowed: false, reason: 'route_day' });
  });

  it('rolls a persisted client route daily budget at the UTC day boundary', async () => {
    const now = Date.now();
    const currentDay = Math.floor(now / 86_400_000);
    const stub = actor(`client-day-rollover-${crypto.randomUUID()}`);
    const cappedLedger = {
      schema: 1,
      minuteBucket: Math.floor(now / 60_000),
      dayBucket: currentDay,
      routeMinute: { metadata: 0, search: 0, audit: 0, tarball: 0 },
      routeDay: { metadata: 0, search: 2, audit: 0, tarball: 0 },
    };
    await stub.fetch('https://npm-admission.internal/');
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('origin-client-admission-ledger-v1', cappedLedger);
    });

    const cappedDecision = await admit(
      stub,
      { clientIpHash: 'c'.repeat(64), routeClass: 'search' },
      '/admit-client',
    );
    expect(cappedDecision).toMatchObject({ allowed: false, reason: 'client_route_day' });

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('origin-client-admission-ledger-v1', {
        ...cappedLedger,
        dayBucket: currentDay - 1,
      });
    });
    const rolledDecision = await admit(
      stub,
      { clientIpHash: 'c'.repeat(64), routeClass: 'search' },
      '/admit-client',
    );
    expect(rolledDecision).toEqual({ allowed: true, retryAfterSeconds: 0 });

    await runInDurableObject(stub, async (_instance, state) => {
      const ledger = await state.storage.get<{
        dayBucket: number;
        routeDay: Record<string, number>;
      }>('origin-client-admission-ledger-v1');
      expect(ledger?.dayBucket).toBe(currentDay);
      expect(ledger?.routeDay.search).toBe(1);
    });
  });

  it('expires per-client ledgers with a daily Durable Object alarm', async () => {
    const stub = actor(`client-expiry-${crypto.randomUUID()}`);
    const decision = await admit(
      stub,
      { clientIpHash: 'd'.repeat(64), routeClass: 'metadata' },
      '/admit-client',
    );
    expect(decision.allowed).toBe(true);

    await runInDurableObject(stub, async (instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeGreaterThan(Date.now());
      expect(await state.storage.get('origin-client-admission-ledger-v1')).toBeDefined();

      await instance.alarm();
      expect(await state.storage.get('origin-client-admission-ledger-v1')).toBeUndefined();
    });
  });

  it('aggregates IPv6 privacy addresses by /64 before hashing', async () => {
    const hash = (address: string) =>
      hashClientIp(
        new Request('https://npm.lemonize.cyou/pkg', {
          headers: { 'cf-connecting-ip': address },
        }),
      );

    const [first, sameNetwork, otherNetwork, mapped, ipv4] = await Promise.all([
      hash('2001:db8:abcd:12::1'),
      hash('2001:0db8:abcd:0012:ffff:eeee:dddd:cccc'),
      hash('2001:db8:abcd:13::1'),
      hash('::ffff:192.0.2.128'),
      hash('192.0.2.128'),
    ]);

    expect(first).toBe(sameNetwork);
    expect(first).not.toBe(otherNetwork);
    expect(mapped).toBe(ipv4);
  });

  it('does not expose a generic public Durable Object endpoint', async () => {
    const stub = actor(`private-${crypto.randomUUID()}`);
    const response = await stub.fetch('https://npm-admission.internal/');
    expect(response.status).toBe(404);
  });
});
