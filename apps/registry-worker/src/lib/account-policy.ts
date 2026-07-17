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

  // Public eligibility follows proof that the Clerk account controls a GitHub
  // account. The external account id is stable when usernames and emails move.
  if (input.githubId) {
    if (config.registryMode === 'public' || config.registryMode === 'read_only') {
      return 'publisher';
    }
    // Invite-only remains useful as a rollout gate for already-approved rows.
    if (input.existingRole === 'publisher') return 'publisher';
  }
  return 'consumer';
}

export function hasCurrentTerms(input: {
  acceptedTermsVersion?: string | null;
}): boolean {
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
