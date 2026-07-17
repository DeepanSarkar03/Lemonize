import { homedir } from 'node:os';
import { join } from 'node:path';

export const LEM_HOME = process.env.LEMONIZE_HOME ?? join(homedir(), '.lemonize');
export const CONFIG_PATH = join(LEM_HOME, 'config.json');
export const CACHE_DIR = join(LEM_HOME, 'cache');
export const DEFAULT_REGISTRY = 'https://registry.lemonize.cyou';
export const LOCKFILE_NAME = 'lemonize-lock.json';
