import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ProjectPackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  lemonizeDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export function readProjectPkg(cwd: string): ProjectPackageJson {
  const p = join(cwd, 'package.json');
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf8')) as ProjectPackageJson;
}

export function writeProjectPkg(cwd: string, pkg: ProjectPackageJson): void {
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}
