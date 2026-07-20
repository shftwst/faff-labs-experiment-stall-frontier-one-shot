'use strict';

const express = require('express');
const multer = require('multer');
const config = require('./config');
const { db } = require('./db');
const { requireAuth } = require('./auth');
const storage = require('./storage');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxPhotoBytes, files: config.maxPhotosPerListing },
  fileFilter: (req, file, cb) => {
    cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype));
  },
});

function photosFor(listingId) {
  return db
    .prepare('SELECT id, storage_key, content_type, position FROM listing_photos WHERE listing_id = ? ORDER BY position, id')
    .all(listingId);
}

function listingJson(l, viewer) {
  return {
    id: l.id,
    owner: { id: l.owner_id, login: l.owner_login, display_name: l.owner_display_name },
    title: l.title,
    description: l.description,
    category: l.category,
    price_credits: l.price_credits,
    status: l.status,
    created_at: l.created_at,
    photos: photosFor(l.id).map((p) => ({ id: p.id, url: `/photos/${p.storage_key}` })),
    is_owner: !!viewer && viewer.id === l.owner_id,
  };
}

function getListing(id) {
  return db
    .prepare(
      `SELECT l.*, m.login AS owner_login, m.display_name AS owner_display_name
       FROM listings l JOIN members m ON m.id = l.owner_id WHERE l.id = ?`
    )
    .get(id);
}

// A listing is visible to a viewer if it is not hidden-by-reports and not
// withdrawn — unless the viewer owns it. Enforced here, server-side, for every
// single-listing read; browse/search apply the same predicate in SQL.
function visibleTo(l, viewer) {
  if (!l) return false;
  if (viewer && viewer.id === l.owner_id) return true;
  if (l.hidden) return false;
  if (l.status === 'withdrawn') return false;
  return true;
}

function validateFields(body) {
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const category = String(body.category || '').trim();
  const price = Number.parseInt(body.price_credits, 10);
  if (!title || title.length > 140) return { error: 'title required (max 140 chars)' };
  if (!description || description.length > 5000) return { error: 'description required (max 5000 chars)' };
  if (!config.categories.includes(category)) return { error: 'invalid category' };
  if (!Number.isInteger(price) || price < 1 || price > 1_000_000) {
    return { error: 'price must be a whole number of credits (min 1)' };
  }
  return { title, description, category, price };
}

function requireOwner(req, res) {
  const l = getListing(req.params.id);
  if (!l) {
    res.status(404).json({ error: 'listing not found' });
    return null;
  }
  if (l.owner_id !== req.member.id) {
    res.status(403).json({ error: 'only the listing owner may do this' });
    return null;
  }
  return l;
}

// --- Browse / search (JSON). Newest first by default.
function browseQuery(params, viewer) {
  const where = ["l.hidden = 0", "l.status IN ('active','reserved')"];
  const args = [];
  if (params.category && config.categories.includes(params.category)) {
    where.push('l.category = ?');
    args.push(params.category);
  }
  const min = Number.parseInt(params.min, 10);
  const max = Number.parseInt(params.max, 10);
  if (Number.isInteger(min)) { where.push('l.price_credits >= ?'); args.push(min); }
  if (Number.isInteger(max)) { where.push('l.price_credits <= ?'); args.push(max); }
  const q = String(params.q || '').trim();
  const hasFts = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'listings_fts'")
    .get();
  let joinFts = '';
  if (q && hasFts) {
    joinFts = 'JOIN listings_fts f ON f.rowid = l.id';
    where.push('listings_fts MATCH ?');
    // Escape each term as a quoted FTS string; AND semantics, prefix match.
    const ftsQuery = q
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
      .map((t) => `"${t.replaceAll('"', '""')}"*`)
      .join(' ');
    args.push(ftsQuery);
  }
  const limit = Math.min(Number.parseInt(params.limit, 10) || 60, 100);
  const sql = `SELECT l.*, m.login AS owner_login, m.display_name AS owner_display_name
    FROM listings l JOIN members m ON m.id = l.owner_id ${joinFts}
    WHERE ${where.join(' AND ')}
    ORDER BY l.created_at DESC, l.id DESC LIMIT ${limit}`;
  return db.prepare(sql).all(...args).map((l) => listingJson(l, viewer));
}

router.get('/api/listings', (req, res) => {
  try {
    res.json({ listings: browseQuery(req.query, req.member) });
  } catch (e) {
    res.status(400).json({ error: 'bad query' });
  }
});

router.get('/api/listings/:id', (req, res) => {
  const l = getListing(req.params.id);
  if (!visibleTo(l, req.member)) return res.status(404).json({ error: 'listing not found' });
  res.json({ listing: listingJson(l, req.member) });
});

router.post('/api/listings', requireAuth, upload.array('photos'), async (req, res) => {
  const v = validateFields(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const info = db
    .prepare(
      'INSERT INTO listings (owner_id, title, description, category, price_credits) VALUES (?, ?, ?, ?, ?)'
    )
    .run(req.member.id, v.title, v.description, v.category, v.price);
  const id = info.lastInsertRowid;
  try {
    let pos = 0;
    for (const f of req.files || []) {
      const key = await storage.putPhoto(f.buffer, f.mimetype);
      db.prepare(
        'INSERT INTO listing_photos (listing_id, storage_key, content_type, position) VALUES (?, ?, ?, ?)'
      ).run(id, key, f.mimetype, pos++);
    }
  } catch (e) {
    return res.status(502).json({ error: 'photo storage failed', listing_id: id });
  }
  res.status(201).json({ listing: listingJson(getListing(id), req.member) });
});

router.patch('/api/listings/:id', requireAuth, (req, res) => {
  const l = requireOwner(req, res);
  if (!l) return;
  if (l.status !== 'active') {
    return res.status(409).json({ error: `cannot edit a ${l.status} listing` });
  }
  const v = validateFields({ ...l, ...req.body });
  if (v.error) return res.status(400).json({ error: v.error });
  db.prepare(
    `UPDATE listings SET title = ?, description = ?, category = ?, price_credits = ?,
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).run(v.title, v.description, v.category, v.price, l.id);
  res.json({ listing: listingJson(getListing(l.id), req.member) });
});

router.post('/api/listings/:id/withdraw', requireAuth, (req, res) => {
  const l = requireOwner(req, res);
  if (!l) return;
  if (l.status !== 'active') {
    return res.status(409).json({ error: `cannot withdraw a ${l.status} listing` });
  }
  db.prepare("UPDATE listings SET status = 'withdrawn' WHERE id = ?").run(l.id);
  res.json({ ok: true });
});

router.post('/api/listings/:id/photos', requireAuth, upload.array('photos'), async (req, res) => {
  const l = requireOwner(req, res);
  if (!l) return;
  const existing = photosFor(l.id);
  const incoming = req.files || [];
  if (existing.length + incoming.length > config.maxPhotosPerListing) {
    return res.status(400).json({ error: `max ${config.maxPhotosPerListing} photos per listing` });
  }
  let pos = existing.length;
  for (const f of incoming) {
    const key = await storage.putPhoto(f.buffer, f.mimetype);
    db.prepare(
      'INSERT INTO listing_photos (listing_id, storage_key, content_type, position) VALUES (?, ?, ?, ?)'
    ).run(l.id, key, f.mimetype, pos++);
  }
  res.json({ photos: photosFor(l.id).map((p) => ({ id: p.id, url: `/photos/${p.storage_key}` })) });
});

router.delete('/api/listings/:id/photos/:photoId', requireAuth, (req, res) => {
  const l = requireOwner(req, res);
  if (!l) return;
  const r = db
    .prepare('DELETE FROM listing_photos WHERE id = ? AND listing_id = ?')
    .run(req.params.photoId, l.id);
  if (!r.changes) return res.status(404).json({ error: 'photo not found' });
  res.json({ ok: true });
});

router.post('/api/listings/:id/report', requireAuth, (req, res) => {
  const l = getListing(req.params.id);
  if (!visibleTo(l, req.member)) return res.status(404).json({ error: 'listing not found' });
  if (l.owner_id === req.member.id) return res.status(400).json({ error: 'cannot report your own listing' });
  db.prepare('INSERT OR IGNORE INTO reports (listing_id, reporter_id) VALUES (?, ?)').run(
    l.id,
    req.member.id
  );
  const n = db.prepare('SELECT COUNT(*) c FROM reports WHERE listing_id = ?').get(l.id).c;
  if (n >= config.reportHideThreshold && !l.hidden) {
    db.prepare('UPDATE listings SET hidden = 1 WHERE id = ?').run(l.id);
  }
  res.json({ ok: true, reports: n, hidden: n >= config.reportHideThreshold });
});

router.get('/photos/:key', async (req, res) => {
  const p = await storage.getPhotoStream(req.params.key);
  if (!p) return res.status(404).end();
  res.setHeader('Content-Type', p.contentType);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  p.stream.pipe(res);
});

module.exports = { router, browseQuery, getListing, visibleTo, listingJson, photosFor };
