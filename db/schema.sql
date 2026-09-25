-- content-approval-webflow: local persistence schema (SQLite dialect; see server/db.ts adapter)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS installations (
  site_id           TEXT PRIMARY KEY,
  access_token_enc  TEXT NOT NULL,               -- AES-256-GCM, see services/token-store.ts
  refresh_token_enc TEXT,
  scopes            TEXT NOT NULL,
  admin_token_hash  TEXT NOT NULL DEFAULT '',    -- sha256 of the owner's App Panel token
  installed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS site_settings (
  site_id             TEXT PRIMARY KEY,
  reminder_lead_hours INTEGER NOT NULL DEFAULT 24 CHECK (reminder_lead_hours >= 1),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_registrations (
  site_id            TEXT NOT NULL,
  trigger_type       TEXT NOT NULL,
  webflow_webhook_id TEXT NOT NULL,
  PRIMARY KEY (site_id, trigger_type)
);

-- Team members. The installing user is the owner (implicitly holds every role). Members authenticate
-- to the App Panel with a personal token issued by the owner (only its SHA-256 is stored).
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    TEXT NOT NULL,
  email      TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  roles      TEXT NOT NULL DEFAULT '[]',          -- JSON array of role names, e.g. ["legal","editor"]
  is_owner   INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site_id, email)
);
CREATE INDEX IF NOT EXISTS idx_members_token ON members (site_id, token_hash);

-- One workflow per collection: ordered stages; the last stage is the publishable "approved" stage.
CREATE TABLE IF NOT EXISTS workflows (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id          TEXT NOT NULL,
  collection_id    TEXT NOT NULL,
  collection_name  TEXT NOT NULL DEFAULT '',
  revert_stage_key TEXT NOT NULL,                 -- where items go when edited after approval
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site_id, collection_id)
);

CREATE TABLE IF NOT EXISTS workflow_stages (
  workflow_id    INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  stage_key      TEXT NOT NULL,
  name           TEXT NOT NULL,
  required_roles TEXT NOT NULL DEFAULT '[]',      -- JSON array: roles allowed to move items out of this stage
  PRIMARY KEY (workflow_id, position),
  UNIQUE (workflow_id, stage_key)
);

-- Every tracked CMS item and its current stage.
CREATE TABLE IF NOT EXISTS items (
  site_id                TEXT NOT NULL,
  collection_id          TEXT NOT NULL,
  item_id                TEXT NOT NULL,
  title                  TEXT NOT NULL DEFAULT '',
  slug                   TEXT NOT NULL DEFAULT '',
  stage_key              TEXT NOT NULL,
  field_data_json        TEXT NOT NULL DEFAULT '{}',   -- last seen Webflow fieldData
  approved_snapshot_json TEXT,                          -- fieldData at last approval (diff baseline)
  approved_hash          TEXT,
  approved_at            TEXT,
  approved_by            TEXT,
  flagged                INTEGER NOT NULL DEFAULT 0,    -- edited after approval; owner must acknowledge
  flag_reason            TEXT,
  published_at           TEXT,                          -- last publish performed through this app
  webflow_last_updated   TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (site_id, collection_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_items_stage ON items (site_id, collection_id, stage_key);

-- Append-only stage transition log (updates blocked; deletes only allowed after uninstall purge).
CREATE TABLE IF NOT EXISTS transitions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id       TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  from_stage    TEXT,
  to_stage      TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('advance','reject','request_changes','auto_revert','publish','track','reset')),
  actor_email   TEXT NOT NULL,
  actor_role    TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transitions_item ON transitions (site_id, collection_id, item_id, id);

CREATE TRIGGER IF NOT EXISTS transitions_no_update BEFORE UPDATE ON transitions
BEGIN
  SELECT RAISE(ABORT, 'transitions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS transitions_no_delete BEFORE DELETE ON transitions
WHEN EXISTS (SELECT 1 FROM installations WHERE site_id = OLD.site_id)
BEGIN
  SELECT RAISE(ABORT, 'transitions is append-only');
END;

-- Append-only general audit log (comments, reviews, publishes, flags, team and workflow changes).
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id       TEXT NOT NULL,
  actor_email   TEXT NOT NULL,
  event         TEXT NOT NULL,
  collection_id TEXT,
  item_id       TEXT,
  detail_json   TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_site ON audit_log (site_id, id);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
WHEN EXISTS (SELECT 1 FROM installations WHERE site_id = OLD.site_id)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- Comment threads: field_slug NULL = whole item; parent_id NULL = thread root. resolved lives on the root.
CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id       TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  field_slug    TEXT,
  parent_id     INTEGER REFERENCES comments(id),
  author_email  TEXT NOT NULL,
  body          TEXT NOT NULL,
  mentions      TEXT NOT NULL DEFAULT '[]',        -- JSON array of member emails
  resolved      INTEGER NOT NULL DEFAULT 0,
  resolved_by   TEXT,
  resolved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_item ON comments (site_id, collection_id, item_id);

CREATE TABLE IF NOT EXISTS review_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id        TEXT NOT NULL,
  collection_id  TEXT NOT NULL,
  item_id        TEXT NOT NULL,
  stage_key      TEXT NOT NULL,
  requested_by   TEXT NOT NULL,
  assignee_email TEXT NOT NULL,
  due_at         TEXT,                              -- ISO-8601 UTC
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  note           TEXT NOT NULL DEFAULT '',
  reminder_sent_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_open ON review_requests (site_id, status, due_at);

-- Every message handed to services/mailer.ts (the stub logs instead of sending).
CREATE TABLE IF NOT EXISTS mail_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    TEXT NOT NULL,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
