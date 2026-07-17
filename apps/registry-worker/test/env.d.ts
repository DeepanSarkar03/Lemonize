declare module 'cloudflare:test' {
  import type { Env } from '../src/lib/env.js';
  type D1Migration = { name: string; queries: string[] };
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
  export const env: ProvidedEnv;
  export const SELF: { fetch: typeof fetch };
  export function applyD1Migrations(db: unknown, migrations: D1Migration[]): Promise<void>;
  export function runInDurableObject<R>(
    stub: DurableObjectStub,
    callback: (instance: unknown, state: DurableObjectState) => R | Promise<R>,
  ): Promise<R>;
  export function runDurableObjectAlarm(stub: DurableObjectStub): Promise<boolean>;
}
