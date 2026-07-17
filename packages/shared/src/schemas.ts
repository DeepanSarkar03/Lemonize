import { z } from 'zod';

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isSafeManifestPath(value: string): boolean {
  const withoutCurrentDirectory = value.startsWith('./') ? value.slice(2) : value;
  const normalized = withoutCurrentDirectory.endsWith('/')
    ? withoutCurrentDirectory.slice(0, -1)
    : withoutCurrentDirectory;
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(withoutCurrentDirectory) ||
    hasControlCharacters(value)
  ) {
    return false;
  }
  return normalized
    .split('/')
    .every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        !part.includes(':') &&
        !part.endsWith('.') &&
        !part.endsWith(' '),
    );
}

const manifestPathSchema = z
  .string()
  .refine(isSafeManifestPath, 'Expected a safe relative package path');
const dependencySpecSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => value.trim().length > 0, 'Dependency spec must not be blank');

export const binMapSchema = z.union([manifestPathSchema, z.record(manifestPathSchema)]);

export const manifestSchema = z
  .object({
    name: z.string().min(1).max(214),
    version: z.string().min(1),
    description: z.string().max(2048).optional(),
    main: manifestPathSchema.optional(),
    types: manifestPathSchema.optional(),
    module: manifestPathSchema.optional(),
    type: z.enum(['module', 'commonjs']).optional(),
    bin: binMapSchema.optional(),
    files: z.array(manifestPathSchema).max(10_000).optional(),
    engines: z.object({ node: z.string().optional() }).partial().optional(),
    dependencies: z.record(dependencySpecSchema).optional(),
    optionalDependencies: z.record(dependencySpecSchema).optional(),
    peerDependencies: z.record(dependencySpecSchema).optional(),
    peerDependenciesMeta: z
      .record(z.object({ optional: z.boolean().optional() }).passthrough())
      .optional(),
    devDependencies: z.record(dependencySpecSchema).optional(),
    lemonizeDependencies: z.record(dependencySpecSchema).optional(),
    lemonize: z
      .object({
        access: z.enum(['public', 'private']).optional(),
        tag: z.string().min(1).max(64).optional(),
      })
      .optional(),
  })
  .passthrough();

export const publishIntentSchema = z.object({
  manifest: manifestSchema,
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/, 'Expected sha512 SRI'),
  shasum: z.string().regex(/^[a-f0-9]{64}$/, 'Expected sha256 hex'),
  tarballSize: z.number().int().positive(),
  unpackedSize: z.number().int().nonnegative(),
  fileCount: z.number().int().positive(),
  access: z.enum(['public', 'private']).optional(),
  tag: z.string().min(1).max(64).optional(),
});

export const createPackageSchema = z.object({
  name: z.string().min(1).max(214),
  description: z.string().max(2048).optional(),
  visibility: z.enum(['public', 'private']).default('public'),
});

export const distTagSchema = z.object({
  tag: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i),
  version: z.string().min(1),
});

export const deprecateSchema = z.object({
  version: z.string().min(1),
  message: z.string().max(1024),
});

export const unpublishSchema = z.object({
  version: z.string().min(1),
  force: z.boolean().default(false),
});

export const securityBlockSchema = z.object({
  version: z.string().min(1),
  reason: z.string().trim().min(1).max(1024),
});

export const createTokenSchema = z.object({
  label: z.string().min(1).max(128),
  // Registry tokens are intentionally short lived. A Clerk session can mint a
  // replacement without keeping a permanent credential on developer machines.
  expiresInDays: z.number().int().positive().max(90).default(90),
  scopes: z
    .array(z.enum(['read', 'publish', 'manage:packages', 'manage:tokens']))
    .min(1)
    .max(4)
    .default(['read', 'publish', 'manage:packages']),
});

export const deviceStartSchema = z.object({
  username: z.string().min(1).max(64).optional(),
});

export const devicePollSchema = z.object({
  deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

// Identity is derived exclusively from the verified Clerk bearer token. Never
// accept a username or email supplied by the browser here.
export const deviceApproveSchema = z
  .object({ userCode: z.string().regex(/^LEMN-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/) })
  .strict();

export type ManifestInput = z.infer<typeof manifestSchema>;
export type PublishIntentInput = z.infer<typeof publishIntentSchema>;
