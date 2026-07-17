import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { AdmissionCandidate, AdmissionDecision } from '../src/admission.js';

function actor(name: string): DurableObjectStub {
  const id = env.NPM_ADMISSION_CONTROLLER.idFromName(name);
  return env.NPM_ADMISSION_CONTROLLER.get(id);
}

async function admit(
  stub: DurableObjectStub,
  candidate: AdmissionCandidate,
): Promise<AdmissionDecision> {
  const response = await stub.fetch(
    new Request('https://npm-admission.internal/admit', {
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

  it('does not expose a generic public Durable Object endpoint', async () => {
    const stub = actor(`private-${crypto.randomUUID()}`);
    const response = await stub.fetch('https://npm-admission.internal/');
    expect(response.status).toBe(404);
  });
});
