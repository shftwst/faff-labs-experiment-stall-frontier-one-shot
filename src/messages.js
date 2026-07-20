'use strict';

const express = require('express');
const { db } = require('./db');
const { requireAuth } = require('./auth');
const { getListing, visibleTo } = require('./listings');

const router = express.Router();

// Participant check: a thread is readable/writable only by the interested
// member and the listing owner — enforced here on every read and write.
function threadForParticipant(threadId, memberId) {
  return db
    .prepare(
      `SELECT t.*, l.owner_id, l.title AS listing_title, l.status AS listing_status,
              io.display_name AS interested_name, o.display_name AS owner_name
       FROM threads t
       JOIN listings l ON l.id = t.listing_id
       JOIN members io ON io.id = t.interested_id
       JOIN members o ON o.id = l.owner_id
       WHERE t.id = ? AND (t.interested_id = ? OR l.owner_id = ?)`
    )
    .get(threadId, memberId, memberId);
}

function threadJson(t, viewer) {
  return {
    id: t.id,
    listing: { id: t.listing_id, title: t.listing_title, status: t.listing_status },
    interested: { id: t.interested_id, display_name: t.interested_name },
    owner: { id: t.owner_id, display_name: t.owner_name },
    other_party:
      viewer.id === t.owner_id
        ? { id: t.interested_id, display_name: t.interested_name }
        : { id: t.owner_id, display_name: t.owner_name },
    created_at: t.created_at,
  };
}

function validBody(body) {
  const text = String((body || {}).body_text ?? (body || {}).body ?? '').trim();
  if (!text || text.length > 2000) return null;
  return text;
}

// Open (or reuse) a thread on a listing and post the first message.
router.post('/api/listings/:id/thread', requireAuth, (req, res) => {
  const l = getListing(req.params.id);
  if (!visibleTo(l, req.member)) return res.status(404).json({ error: 'listing not found' });
  if (l.owner_id === req.member.id) {
    return res.status(400).json({ error: 'you own this listing; reply from its threads instead' });
  }
  const text = validBody(req.body);
  if (!text) return res.status(400).json({ error: 'message body required (max 2000 chars)' });
  const t = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO threads (listing_id, interested_id) VALUES (?, ?)').run(
      l.id,
      req.member.id
    );
    const thread = db
      .prepare('SELECT id FROM threads WHERE listing_id = ? AND interested_id = ?')
      .get(l.id, req.member.id);
    db.prepare('INSERT INTO messages (thread_id, sender_id, body) VALUES (?, ?, ?)').run(
      thread.id,
      req.member.id,
      text
    );
    return thread.id;
  })();
  const full = threadForParticipant(t, req.member.id);
  res.status(201).json({ thread: threadJson(full, req.member) });
});

// My threads (as buyer or seller).
router.get('/api/threads', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.*, l.owner_id, l.title AS listing_title, l.status AS listing_status,
              io.display_name AS interested_name, o.display_name AS owner_name,
              (SELECT body FROM messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_body,
              (SELECT created_at FROM messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_at
       FROM threads t
       JOIN listings l ON l.id = t.listing_id
       JOIN members io ON io.id = t.interested_id
       JOIN members o ON o.id = l.owner_id
       WHERE t.interested_id = ? OR l.owner_id = ?
       ORDER BY last_at DESC`
    )
    .all(req.member.id, req.member.id);
  res.json({
    threads: rows.map((t) => ({
      ...threadJson(t, req.member),
      last_message: t.last_body,
      last_message_at: t.last_at,
    })),
  });
});

router.get('/api/threads/:id', requireAuth, (req, res) => {
  const t = threadForParticipant(req.params.id, req.member.id);
  if (!t) return res.status(404).json({ error: 'thread not found' });
  const messages = db
    .prepare(
      `SELECT m.id, m.sender_id, mem.display_name AS sender_name, m.body, m.created_at
       FROM messages m JOIN members mem ON mem.id = m.sender_id
       WHERE m.thread_id = ? ORDER BY m.id`
    )
    .all(t.id);
  res.json({ thread: threadJson(t, req.member), messages });
});

router.post('/api/threads/:id/messages', requireAuth, (req, res) => {
  const t = threadForParticipant(req.params.id, req.member.id);
  if (!t) return res.status(404).json({ error: 'thread not found' });
  const text = validBody(req.body);
  if (!text) return res.status(400).json({ error: 'message body required (max 2000 chars)' });
  const info = db
    .prepare('INSERT INTO messages (thread_id, sender_id, body) VALUES (?, ?, ?)')
    .run(t.id, req.member.id, text);
  const m = db
    .prepare(
      `SELECT m.id, m.sender_id, mem.display_name AS sender_name, m.body, m.created_at
       FROM messages m JOIN members mem ON mem.id = m.sender_id WHERE m.id = ?`
    )
    .get(info.lastInsertRowid);
  res.status(201).json({ message: m });
});

module.exports = { router, threadForParticipant };
