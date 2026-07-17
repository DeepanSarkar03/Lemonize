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
  namespace?: string;
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
  const namespace = input.namespace?.toLowerCase();
  if (!namespace || !input.packageScope || input.packageScope.toLowerCase() !== namespace) {
    throw forbidden('You may only maintain packages in your own namespace.');
  }
}
