import { LemonizeClient } from '@lemonize/shared';
import { resolveRegistry, getToken } from './config.js';
import { createSecureRegistryFetch } from './http.js';
import { CLI_VERSION } from '../version.js';

export interface ClientContext {
  registry: string;
  token: string | null;
  client: LemonizeClient;
}

export function makeClient(registryFlag?: string, requireToken = false): ClientContext {
  const registry = resolveRegistry({ registryFlag });
  const token = getToken(registry);
  if (requireToken && !token) {
    throw new Error(`Not logged in to ${registry}. Run "lem login" first.`);
  }
  const client = new LemonizeClient({
    registry,
    token,
    fetchImpl: createSecureRegistryFetch(registry),
    userAgent: `lem-cli/${CLI_VERSION}`,
  });
  return { registry, token, client };
}
