import type { Env } from './env.js';

export interface ClerkEmailAddress {
  id?: unknown;
  email_address?: unknown;
}

export interface ClerkExternalAccount {
  provider?: unknown;
  username?: unknown;
  provider_user_id?: unknown;
  external_id?: unknown;
}

export interface ClerkUserResponse {
  primary_email_address_id?: unknown;
  email_addresses?: unknown;
  external_accounts?: unknown;
  private_metadata?: unknown;
  banned?: unknown;
  locked?: unknown;
}

/** Fetch current server-only Clerk user state. Never cache entitlement decisions here. */
export async function fetchClerkUser(
  env: Pick<Env, 'CLERK_SECRET_KEY'>,
  clerkId: string,
): Promise<ClerkUserResponse | null> {
  if (!env.CLERK_SECRET_KEY) throw new Error('Clerk backend key is not configured.');
  const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkId)}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Clerk user lookup failed.');
  return (await response.json()) as ClerkUserResponse;
}
