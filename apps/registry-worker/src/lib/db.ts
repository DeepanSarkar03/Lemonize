import type { D1Database } from '@cloudflare/workers-types';
import { ulid } from '@lemonize/shared';

export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  created_at: string;
}

export interface TokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  label: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface PackageRow {
  id: string;
  name: string;
  normalized_name: string;
  scope: string | null;
  owner_user_id: string;
  organization_id: string | null;
  description: string | null;
  readme: string | null;
  visibility: string;
  latest_version: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface VersionRow {
  id: string;
  package_id: string;
  version: string;
  tarball_key: string;
  integrity: string;
  shasum: string;
  unpacked_size: number;
  tarball_size: number;
  file_count: number;
  manifest_json: string;
  module_type: string | null;
  node_engine: string | null;
  bin_json: string | null;
  published_by: string;
  published_at: string;
  deprecated_message: string | null;
  yanked_at: string | null;
}

const now = () => new Date().toISOString();

export class Repo {
  constructor(private readonly db: D1Database) {}

  // ---------------- users ----------------
  async getUserByUsername(username: string): Promise<UserRow | null> {
    return this.db
      .prepare('SELECT * FROM users WHERE username = ?1')
      .bind(username)
      .first<UserRow>();
  }
  async getUserById(id: string): Promise<UserRow | null> {
    return this.db.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first<UserRow>();
  }
  async createUser(username: string, email?: string): Promise<UserRow> {
    const row: UserRow = { id: ulid(), username, email: email ?? null, created_at: now() };
    await this.db
      .prepare('INSERT INTO users (id, username, email, created_at) VALUES (?1,?2,?3,?4)')
      .bind(row.id, row.username, row.email, row.created_at)
      .run();
    return row;
  }
  async upsertUser(username: string, email?: string): Promise<UserRow> {
    return (await this.getUserByUsername(username)) ?? (await this.createUser(username, email));
  }

  // ---------------- tokens ----------------
  async createToken(input: {
    userId: string;
    tokenHash: string;
    label: string;
    prefix: string;
    expiresAt: string | null;
  }): Promise<TokenRow> {
    const row: TokenRow = {
      id: ulid(),
      user_id: input.userId,
      token_hash: input.tokenHash,
      label: input.label,
      prefix: input.prefix,
      created_at: now(),
      last_used_at: null,
      expires_at: input.expiresAt,
      revoked_at: null,
    };
    await this.db
      .prepare(
        `INSERT INTO api_tokens (id,user_id,token_hash,label,prefix,created_at,last_used_at,expires_at,revoked_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
      )
      .bind(
        row.id,
        row.user_id,
        row.token_hash,
        row.label,
        row.prefix,
        row.created_at,
        null,
        row.expires_at,
        null,
      )
      .run();
    return row;
  }
  async getTokenByHash(hash: string): Promise<TokenRow | null> {
    return this.db
      .prepare('SELECT * FROM api_tokens WHERE token_hash = ?1')
      .bind(hash)
      .first<TokenRow>();
  }
  async touchToken(id: string): Promise<void> {
    await this.db
      .prepare('UPDATE api_tokens SET last_used_at = ?2 WHERE id = ?1')
      .bind(id, now())
      .run();
  }
  async listTokens(userId: string): Promise<TokenRow[]> {
    const res = await this.db
      .prepare('SELECT * FROM api_tokens WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC')
      .bind(userId)
      .all<TokenRow>();
    return res.results ?? [];
  }
  async revokeToken(userId: string, id: string): Promise<boolean> {
    const res = await this.db
      .prepare('UPDATE api_tokens SET revoked_at = ?3 WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL')
      .bind(id, userId, now())
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  // ---------------- packages ----------------
  async getPackageByNormalized(normalized: string): Promise<PackageRow | null> {
    return this.db
      .prepare('SELECT * FROM packages WHERE normalized_name = ?1 AND deleted_at IS NULL')
      .bind(normalized)
      .first<PackageRow>();
  }
  async createPackage(input: {
    name: string;
    normalized: string;
    scope: string | null;
    ownerUserId: string;
    description: string | null;
    visibility: string;
  }): Promise<PackageRow> {
    const ts = now();
    const row: PackageRow = {
      id: ulid(),
      name: input.name,
      normalized_name: input.normalized,
      scope: input.scope,
      owner_user_id: input.ownerUserId,
      organization_id: null,
      description: input.description,
      readme: null,
      visibility: input.visibility,
      latest_version: null,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
    };
    await this.db
      .prepare(
        `INSERT INTO packages (id,name,normalized_name,scope,owner_user_id,organization_id,description,readme,visibility,latest_version,created_at,updated_at,deleted_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
      )
      .bind(
        row.id, row.name, row.normalized_name, row.scope, row.owner_user_id, null,
        row.description, null, row.visibility, null, row.created_at, row.updated_at, null,
      )
      .run();
    // owner is a maintainer
    await this.db
      .prepare('INSERT INTO package_maintainers (id,package_id,user_id,role,created_at) VALUES (?1,?2,?3,?4,?5)')
      .bind(ulid(), row.id, input.ownerUserId, 'owner', ts)
      .run();
    return row;
  }
  async isMaintainer(packageId: string, userId: string): Promise<boolean> {
    const r = await this.db
      .prepare('SELECT 1 AS ok FROM package_maintainers WHERE package_id = ?1 AND user_id = ?2')
      .bind(packageId, userId)
      .first<{ ok: number }>();
    return !!r;
  }
  async getVersion(packageId: string, version: string): Promise<VersionRow | null> {
    return this.db
      .prepare('SELECT * FROM package_versions WHERE package_id = ?1 AND version = ?2')
      .bind(packageId, version)
      .first<VersionRow>();
  }
  async listVersions(packageId: string): Promise<VersionRow[]> {
    const res = await this.db
      .prepare('SELECT * FROM package_versions WHERE package_id = ?1 ORDER BY published_at ASC')
      .bind(packageId)
      .all<VersionRow>();
    return res.results ?? [];
  }
  async getDistTags(packageId: string): Promise<Record<string, string>> {
    const res = await this.db
      .prepare('SELECT tag, version FROM dist_tags WHERE package_id = ?1')
      .bind(packageId)
      .all<{ tag: string; version: string }>();
    const out: Record<string, string> = {};
    for (const r of res.results ?? []) out[r.tag] = r.version;
    return out;
  }
  async listMaintainers(packageId: string): Promise<string[]> {
    const res = await this.db
      .prepare(
        `SELECT u.username AS username FROM package_maintainers m
         JOIN users u ON u.id = m.user_id WHERE m.package_id = ?1`,
      )
      .bind(packageId)
      .all<{ username: string }>();
    return (res.results ?? []).map((r) => r.username);
  }

  raw(): D1Database {
    return this.db;
  }
}

export { now };
