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
  {
    id: '003-search-and-messaging',
    sql: `
      CREATE VIRTUAL TABLE listings_fts USING fts5(
        title, description, content='listings', content_rowid='id'
      );
      INSERT INTO listings_fts (rowid, title, description)
        SELECT id, title, description FROM listings;
      CREATE TRIGGER listings_ai AFTER INSERT ON listings BEGIN
        INSERT INTO listings_fts (rowid, title, description)
        VALUES (new.id, new.title, new.description);
      END;
      CREATE TRIGGER listings_ad AFTER DELETE ON listings BEGIN
        INSERT INTO listings_fts (listings_fts, rowid, title, description)
        VALUES ('delete', old.id, old.title, old.description);
      END;
      CREATE TRIGGER listings_au AFTER UPDATE OF title, description ON listings BEGIN
        INSERT INTO listings_fts (listings_fts, rowid, title, description)
        VALUES ('delete', old.id, old.title, old.description);
        INSERT INTO listings_fts (rowid, title, description)
        VALUES (new.id, new.title, new.description);
      END;

      CREATE TABLE threads (
        id INTEGER PRIMARY KEY,
        listing_id INTEGER NOT NULL REFERENCES listings(id),
        interested_id INTEGER NOT NULL REFERENCES members(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (listing_id, interested_id)
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        thread_id INTEGER NOT NULL REFERENCES threads(id),
        sender_id INTEGER NOT NULL REFERENCES members(id),
        body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_messages_thread ON messages (thread_id, id);
      CREATE INDEX idx_threads_interested ON threads (interested_id);
      CREATE INDEX idx_threads_listing ON threads (listing_id);
    `,
  },
  {
    id: '004-credits-offers-escrow',
    sql: `
      -- Integer credits. Every member is seeded 1000 credits; ledger_meta
      -- tracks the total ever seeded so the zero-sum invariant is checkable:
      -- SUM(members.balance) + SUM(held escrow) == ledger_meta.total_seeded.
      ALTER TABLE members ADD COLUMN balance INTEGER NOT NULL DEFAULT 1000
        CHECK (balance >= 0);
      CREATE TABLE ledger_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        seed_credits INTEGER NOT NULL,
        total_seeded INTEGER NOT NULL
      );
      INSERT INTO ledger_meta (id, seed_credits, total_seeded)
        SELECT 1, 1000, 1000 * COUNT(*) FROM members;
      CREATE TABLE ledger_entries (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('seed','escrow_hold','escrow_refund','escrow_release')),
        member_id INTEGER NOT NULL REFERENCES members(id),
        offer_id INTEGER,
        delta INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      INSERT INTO ledger_entries (kind, member_id, delta)
        SELECT 'seed', id, 1000 FROM members;
      -- Seeding is a trigger so every member-creation path stays zero-sum.
      CREATE TRIGGER members_seed AFTER INSERT ON members BEGIN
        UPDATE ledger_meta SET total_seeded = total_seeded + seed_credits WHERE id = 1;
        INSERT INTO ledger_entries (kind, member_id, delta)
          VALUES ('seed', new.id, (SELECT seed_credits FROM ledger_meta WHERE id = 1));
      END;

      CREATE TABLE offers (
        id INTEGER PRIMARY KEY,
        listing_id INTEGER NOT NULL REFERENCES listings(id),
        buyer_id INTEGER NOT NULL REFERENCES members(id),
        amount INTEGER NOT NULL CHECK (amount >= 1),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
          ('pending','accepted','declined','superseded','cancelled','completed')),
        buyer_confirmed INTEGER NOT NULL DEFAULT 0,
        seller_confirmed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_offers_listing ON offers (listing_id, status);
      CREATE INDEX idx_offers_buyer ON offers (buyer_id, status);

      CREATE TABLE escrows (
        id INTEGER PRIMARY KEY,
        offer_id INTEGER NOT NULL UNIQUE REFERENCES offers(id),
        amount INTEGER NOT NULL CHECK (amount >= 1),
        status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','released','refunded')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
