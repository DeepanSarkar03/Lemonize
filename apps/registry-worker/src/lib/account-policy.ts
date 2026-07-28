import type { Config, RegistryRole } from './env.js';

/** Effective date of the terms currently presented by the web application. */
export const CURRENT_TERMS_VERSION = '2026-07-17';

export function roleForAccount(
  config: Pick<Config, 'adminClerkIds' | 'registryMode'>,
  input: {
    clerkId: string;
    githubId?: string | null;
    existingRole?: string | null;
  },
): RegistryRole {
  if (config.adminClerkIds.includes(input.clerkId)) return 'admin';

  // Every active Clerk account is eligible for public publishing in public
  // mode. Read-only keeps the same role assignment so enabling the global
  // write circuit breaker never requires an account migration. GitHub remains
  // optional profile data and can authorize explicitly configured extra
  // package scopes, but it is no longer a prerequisite for the user's own
  // immutable namespace.
  if (config.registryMode === 'public' || config.registryMode === 'read_only') {
    return 'publisher';
  }

  // Invite-only remains useful as an operator-controlled rollout gate.
  if (input.existingRole === 'publisher') return 'publisher';
  return 'consumer';
}

export function hasCurrentTerms(input: { acceptedTermsVersion?: string | null }): boolean {
  return input.acceptedTermsVersion === CURRENT_TERMS_VERSION;
}

export function shouldAdoptGithubNamespace(input: {
  namespaceClaimedAt?: string | null;
  previousGithubId?: string | null;
  nextGithubId?: string | null;
  packageCount: number;
}): boolean {
  return (
    !input.namespaceClaimedAt &&
    !input.previousGithubId &&
    Boolean(input.nextGithubId) &&
    input.packageCount === 0
  );
}
