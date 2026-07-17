-- Lemonize D1 schema — initial migration.
-- IDs are ULIDs/opaque strings generated in the Worker. All writes use
-- prepared statements. Soft-deletion (deleted_at / yanked_at) is preferred.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  email       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,   -- sha256 hex of the raw token
  label        TEXT NOT NULL,
  prefix       TEXT NOT NULL,          -- visible prefix, e.g. lem_live_ab12
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_members (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
  created_at  TEXT NOT NULL,
  UNIQUE (org_id, user_id),
  FOREIGN KEY (org_id) REFERENCES organizations(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(org_id);

CREATE TABLE IF NOT EXISTS packages (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,          -- display name, e.g. @deepan/utils
  normalized_name TEXT NOT NULL UNIQUE,          -- confusable-collision guard
  scope           TEXT,                          -- "deepan" or NULL
  owner_user_id   TEXT NOT NULL,
  organization_id TEXT,
  description     TEXT,
  readme          TEXT,
  visibility      TEXT NOT NULL DEFAULT 'public', -- public | private
  latest_version  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);
CREATE INDEX IF NOT EXISTS idx_packages_normalized ON packages(normalized_name);
CREATE INDEX IF NOT EXISTS idx_packages_owner ON packages(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_packages_visibility ON packages(visibility);
CREATE INDEX IF NOT EXISTS idx_packages_updated ON packages(updated_at);

CREATE TABLE IF NOT EXISTS package_maintainers (
  id          TEXT PRIMARY KEY,
  package_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'maintainer', -- owner | maintainer
  created_at  TEXT NOT NULL,
  UNIQUE (package_id, user_id),
  FOREIGN KEY (package_id) REFERENCES packages(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_maintainers_package ON package_maintainers(package_id);

CREATE TABLE IF NOT EXISTS package_versions (
  id                 TEXT PRIMARY KEY,
  package_id         TEXT NOT NULL,
  version            TEXT NOT NULL,
  tarball_key        TEXT NOT NULL,       -- R2 object key
  integrity          TEXT NOT NULL,       -- sha512 SRI
  shasum             TEXT NOT NULL,       -- sha256 hex
  unpacked_size      INTEGER NOT NULL,
  tarball_size       INTEGER NOT NULL,
  file_count         INTEGER NOT NULL,
  manifest_json      TEXT NOT NULL,
  module_type        TEXT,                -- module | commonjs
  node_engine        TEXT,
  bin_json           TEXT,
  published_by       TEXT NOT NULL,
  published_at       TEXT NOT NULL,
  deprecated_message TEXT,
  yanked_at          TEXT,
  UNIQUE (package_id, version),
  FOREIGN KEY (package_id) REFERENCES packages(id),
  FOREIGN KEY (published_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_versions_package ON package_versions(package_id);
CREATE INDEX IF NOT EXISTS idx_versions_pkg_ver ON package_versions(package_id, version);

CREATE TABLE IF NOT EXISTS dist_tags (
  id          TEXT PRIMARY KEY,
  package_id  TEXT NOT NULL,
  tag         TEXT NOT NULL,     -- latest | next | beta | canary | custom
  version     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (package_id, tag),
  FOREIGN KEY (package_id) REFERENCES packages(id)
);
CREATE INDEX IF NOT EXISTS idx_dist_tags_package ON dist_tags(package_id);

CREATE TABLE IF NOT EXISTS downloads_daily (
  package_id  TEXT NOT NULL,
  version     TEXT NOT NULL,
  day         TEXT NOT NULL,     -- YYYY-MM-DD
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (package_id, version, day),
  FOREIGN KEY (package_id) REFERENCES packages(id)
);
CREATE INDEX IF NOT EXISTS idx_downloads_day ON downloads_daily(day);

CREATE TABLE IF NOT EXISTS publish_audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  package_id  TEXT,
  action      TEXT NOT NULL,     -- package.create | version.publish | version.deprecate | ...
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_package ON publish_audit_log(package_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON publish_audit_log(created_at);

CREATE TABLE IF NOT EXISTS package_deprecations (
  id          TEXT PRIMARY KEY,
  package_id  TEXT NOT NULL,
  version     TEXT NOT NULL,
  message     TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (package_id) REFERENCES packages(id)
);
CREATE INDEX IF NOT EXISTS idx_deprecations_package ON package_deprecations(package_id);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id           TEXT PRIMARY KEY,
  subject      TEXT NOT NULL,    -- token id or IP
  kind         TEXT NOT NULL,    -- read | write | auth
  window_start TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_events_subject ON rate_limit_events(subject);
