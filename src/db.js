'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Simple forward-only migrations. Each entry runs once, in order, tracked in
// schema_migrations. Later releases append entries; existing rows are never edited.
const migrations = [
  {
    id: '001-members-sessions',
    sql: `
      CREATE TABLE members (
        id INTEGER PRIMARY KEY,
        github_id INTEGER UNIQUE,
        login TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        is_harness INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        member_id INTEGER NOT NULL REFERENCES members(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at TEXT NOT NULL
      );
      CREATE TABLE device_logins (
        id TEXT PRIMARY KEY,
        device_code TEXT NOT NULL,
        interval_s INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
  {
    id: '002-listings',
    sql: `
      CREATE TABLE listings (
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES members(id),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 140),
        description TEXT NOT NULL CHECK (length(description) <= 5000),
        category TEXT NOT NULL,
        price_credits INTEGER NOT NULL CHECK (price_credits >= 1),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','reserved','completed','withdrawn')),
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_listings_browse ON listings (status, hidden, created_at DESC);
      CREATE INDEX idx_listings_owner ON listings (owner_id);
      CREATE TABLE listing_photos (
        id INTEGER PRIMARY KEY,
        listing_id INTEGER NOT NULL REFERENCES listings(id),
        storage_key TEXT NOT NULL UNIQUE,
        content_type TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_photos_listing ON listing_photos (listing_id, position);
      CREATE TABLE reports (
        listing_id INTEGER NOT NULL REFERENCES listings(id),
        reporter_id INTEGER NOT NULL REFERENCES members(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (listing_id, reporter_id)
      );
    `,
  },
];

db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`);

const applied = new Set(
  db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id)
);
for (const m of migrations) {
  if (applied.has(m.id)) continue;
  db.transaction(() => {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(m.id);
  })();
}

module.exports = { db, migrations };
