import { forbidden } from '@lemonize/shared';
import type { RegistryMode, RegistryRole } from './env.js';

export function assertRegistryMutable(mode: RegistryMode): void {
  if (mode === 'read_only') {
    throw forbidden('Package metadata changes are temporarily disabled for this registry.');
  }
}

export function assertMaintainerIdentity(input: {
  role?: RegistryRole;
  userId?: string;
  authorizedPackageScopes?: readonly string[];
  packageOwnerId: string;
  packageScope: string;
}): void {
  if (input.role !== 'publisher' && input.role !== 'admin') {
    throw forbidden('Your account is not approved to maintain packages.');
  }
  if (input.role === 'admin') return;
  if (!input.userId || input.packageOwnerId !== input.userId) {
    throw forbidden('You are not the owner of this package.');
  }
  const packageScope = input.packageScope.toLowerCase();
  if (
    !packageScope ||
    !input.authorizedPackageScopes?.some(
      (authorizedScope) => authorizedScope.toLowerCase() === packageScope,
    )
  ) {
    throw forbidden('You may only maintain packages in an authorized namespace.');
  }
}
