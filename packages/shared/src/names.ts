/**
 * Package name validation and normalization.
 * Rules are original to Lemonize but follow common package-manager conventions:
 *  - optional scope: @scope/name
 *  - lowercase, url-safe, no leading dot/underscore
 *  - length limits and reserved-name protection
 */

export const RESERVED_NAMES = new Set([
  'lemonize',
  'lem',
  'admin',
  'support',
  'system',
  'api',
]);

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

export interface ParsedName {
  /** Full name as provided, lowercased. e.g. "@deepan/utils" */
  full: string;
  /** Scope without the @, or null. e.g. "deepan" */
  scope: string | null;
  /** Unscoped name. e.g. "utils" */
  name: string;
}

export interface NameValidation {
  ok: boolean;
  errors: string[];
  parsed?: ParsedName;
}

export function parsePackageName(input: string): ParsedName | null {
  const lower = input.trim().toLowerCase();
  if (lower.startsWith('@')) {
    const slash = lower.indexOf('/');
    if (slash <= 1) return null;
    const scope = lower.slice(1, slash);
    const name = lower.slice(slash + 1);
    if (!scope || !name) return null;
    return { full: `@${scope}/${name}`, scope, name };
  }
  return { full: lower, scope: null, name: lower };
}

export function validatePackageName(input: string): NameValidation {
  const errors: string[] = [];
  if (!input || input.length > 214) {
    errors.push('Name must be between 1 and 214 characters.');
  }
  if (input && input !== input.toLowerCase()) {
    errors.push('Name must be lowercase.');
  }
  const parsed = parsePackageName(input);
  if (!parsed) {
    errors.push('Invalid scoped name. Expected "@scope/name".');
    return { ok: false, errors };
  }
  const check = (seg: string, label: string) => {
    if (!SEGMENT.test(seg)) {
      errors.push(`${label} "${seg}" must be lowercase and url-safe (a-z, 0-9, . _ -), not starting with . or -.`);
    }
    if (seg.startsWith('.') || seg.startsWith('_')) {
      errors.push(`${label} must not start with "." or "_".`);
    }
  };
  if (parsed.scope !== null) check(parsed.scope, 'Scope');
  check(parsed.name, 'Name');

  const reservedTarget = parsed.scope ?? parsed.name;
  if (RESERVED_NAMES.has(reservedTarget) || RESERVED_NAMES.has(parsed.name)) {
    errors.push(`"${reservedTarget}" is a reserved name.`);
  }
  return { ok: errors.length === 0, errors, parsed: errors.length === 0 ? parsed : undefined };
}

/**
 * Normalized name used for uniqueness and confusable-collision prevention.
 * Collapses separators so that "my.utils", "my-utils", "my_utils" collide.
 */
export function normalizePackageName(input: string): string {
  const parsed = parsePackageName(input);
  if (!parsed) return input.trim().toLowerCase();
  const collapse = (s: string) => s.replace(/[._-]+/g, '-');
  return parsed.scope !== null
    ? `@${collapse(parsed.scope)}/${collapse(parsed.name)}`
    : collapse(parsed.name);
}

/**
 * Safe R2 object-key path component for a (possibly scoped) name.
 * Scoped names keep the @scope/name shape but are guaranteed traversal-free.
 */
export function toObjectKeyName(input: string): string {
  const parsed = parsePackageName(input);
  if (!parsed) throw new Error('Cannot build object key for invalid name');
  const guard = (s: string) => {
    if (s.includes('..') || s.includes('/') || s.includes('\\')) {
      throw new Error('Path traversal detected in package name');
    }
    return s;
  };
  return parsed.scope !== null
    ? `@${guard(parsed.scope)}/${guard(parsed.name)}`
    : guard(parsed.name);
}
