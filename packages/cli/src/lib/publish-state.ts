import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { LEM_HOME } from './paths.js';

const STATE_PATH = join(LEM_HOME, 'publish-state.json');

export interface PublishState {
  registry: string;
  name: string;
  version: string;
  integrity: string;
  idempotencyKey: string;
  uploadUrl: string;
  uploadToken: string;
  expiresAt: string;
  phase: 'awaiting_upload' | 'uploaded';
}

export function loadPublishState(): PublishState | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const value = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<PublishState>;
    if (
      typeof value.registry !== 'string' ||
      typeof value.name !== 'string' ||
      typeof value.version !== 'string' ||
      typeof value.integrity !== 'string' ||
      typeof value.idempotencyKey !== 'string' ||
      typeof value.uploadUrl !== 'string' ||
      typeof value.uploadToken !== 'string' ||
      typeof value.expiresAt !== 'string' ||
      (value.phase !== 'awaiting_upload' && value.phase !== 'uploaded')
    ) {
      return null;
    }
    return value as PublishState;
  } catch {
    return null;
  }
}

export function savePublishState(state: PublishState): void {
  mkdirSync(LEM_HOME, { recursive: true });
  const temporary = `${STATE_PATH}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, STATE_PATH);
    try {
      chmodSync(STATE_PATH, 0o600);
    } catch {
      // Windows does not implement POSIX modes.
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function clearPublishState(): void {
  rmSync(STATE_PATH, { force: true });
}
