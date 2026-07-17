declare module 'cloudflare:test' {
  import type { Env } from '../src/index.js';

  interface ProvidedEnv extends Env {
    NPM_ADMISSION_CONTROLLER: DurableObjectNamespace;
  }

  export const env: ProvidedEnv;
  export function runInDurableObject<R>(
    stub: DurableObjectStub,
    callback: (instance: unknown, state: DurableObjectState) => R | Promise<R>,
  ): Promise<R>;
}
