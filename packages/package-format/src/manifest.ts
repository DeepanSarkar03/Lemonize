import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  manifestSchema,
  validatePackageName,
  isValidVersion,
  type PackageManifest,
  type BinMap,
} from '@lemonize/shared';

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
  manifest?: PackageManifest;
}

/** Read and validate a package.json for publishing. */
export async function readManifest(dir: string): Promise<ManifestValidationResult> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'package.json'), 'utf8');
  } catch {
    return { ok: false, errors: ['No package.json found in the current directory.'] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`package.json is not valid JSON: ${(e as Error).message}`] };
  }
  return validateManifest(json);
}

export function validateManifest(json: unknown): ManifestValidationResult {
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const m = parsed.data as PackageManifest;
  const errors: string[] = [];

  const nameCheck = validatePackageName(m.name);
  if (!nameCheck.ok) errors.push(...nameCheck.errors);
  if (!isValidVersion(m.version)) errors.push(`Invalid semver version: "${m.version}".`);
  for (const name of Object.keys(m.lemonizeDependencies ?? {})) {
    const dependencyName = validatePackageName(name);
    if (!dependencyName.ok) {
      errors.push(
        ...dependencyName.errors.map((error) => `lemonizeDependencies.${name}: ${error}`),
      );
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors: [], manifest: m };
}

/** Normalize a bin field (string or map) into a BinMap keyed by command name. */
export function normalizeBin(m: PackageManifest): BinMap {
  if (!m.bin) return {};
  if (typeof m.bin === 'string') {
    const cmd = m.name.startsWith('@') ? m.name.split('/')[1]! : m.name;
    return { [cmd]: m.bin };
  }
  return m.bin;
}
