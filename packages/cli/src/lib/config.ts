import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_PATH, LEM_HOME, DEFAULT_REGISTRY } from './paths.js';

export interface LemConfig {
  registry: string;
  tokens: Record<string, string>; // registry -> token
  [key: string]: unknown;
}

const DEFAULT: LemConfig = { registry: DEFAULT_REGISTRY, tokens: {} };

export function loadConfig(): LemConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT, tokens: {} };
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<LemConfig>;
    return { ...DEFAULT, ...parsed, tokens: { ...(parsed.tokens ?? {}) } };
  } catch {
    return { ...DEFAULT, tokens: {} };
  }
}

export function saveConfig(cfg: LemConfig): void {
  mkdirSync(LEM_HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* non-posix fs */
  }
}

/** Read a project-level .lemrc (JSON) from cwd if present. */
function readLemrc(cwd: string): Partial<LemConfig> {
  const p = join(cwd, '.lemrc');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Partial<LemConfig>;
  } catch {
    return {};
  }
}

export interface ResolveOptions {
  registryFlag?: string;
  cwd?: string;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function hasAsciiWhitespaceOrControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parse and canonicalize a registry URL before it is used for requests or as a
 * credential key. Registries must use TLS, with an HTTP exception only for
 * local development on an actual loopback hostname.
 */
export function validateRegistryUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    hasAsciiWhitespaceOrControl(value)
  ) {
    throw new Error('Registry must be a valid HTTPS URL.');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid registry URL: ${value}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Registry URL must use HTTPS: ${value}`);
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('Registry URL must use HTTPS unless it is localhost, 127.0.0.1, or [::1].');
  }
  if (url.username || url.password) {
    throw new Error('Registry URL must not contain credentials.');
  }
  if (value.includes('?') || value.includes('#')) {
    throw new Error('Registry URL must not contain a query string or fragment.');
  }

  return url.href.replace(/\/+$/, '');
}

/** Resolve the active registry using flag > env > .lemrc > config > default. */
export function resolveRegistry(opts: ResolveOptions = {}): string {
  const cwd = opts.cwd ?? process.cwd();
  const fromRc = readLemrc(cwd).registry;
  const registry =
    opts.registryFlag ||
    process.env.LEMONIZE_REGISTRY ||
    fromRc ||
    loadConfig().registry ||
    DEFAULT_REGISTRY;
  return validateRegistryUrl(registry);
}

export function getToken(registry: string): string | null {
  const normalizedRegistry = validateRegistryUrl(registry);
  const envToken = process.env.LEMONIZE_TOKEN;
  if (envToken) {
    // An environment token is deliberately scoped to an explicit environment
    // registry, or to the default registry when no override was supplied. This
    // prevents a repository-controlled .lemrc or --registry from retargeting it.
    const tokenRegistry = validateRegistryUrl(process.env.LEMONIZE_REGISTRY || DEFAULT_REGISTRY);
    if (new URL(tokenRegistry).origin === new URL(normalizedRegistry).origin) return envToken;
  }
  return loadConfig().tokens[normalizedRegistry] ?? null;
}

export function setToken(registry: string, token: string): void {
  const cfg = loadConfig();
  cfg.tokens[validateRegistryUrl(registry)] = token;
  saveConfig(cfg);
}

export function clearToken(registry: string): void {
  const cfg = loadConfig();
  delete cfg.tokens[validateRegistryUrl(registry)];
  saveConfig(cfg);
}
