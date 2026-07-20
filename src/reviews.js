'use strict';

const express = require('express');
const { db } = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();

// One review per party per completed transaction, only after completion,
// immutable once posted (DB triggers enforce immutability independently).

router.post('/api/offers/:id/review', requireAuth, (req, res) => {
  const o = db
    .prepare(
      `SELECT o.*, l.owner_id FROM offers o JOIN listings l ON l.id = o.listing_id WHERE o.id = ?`
    )
    .get(req.params.id);
  if (!o) return res.status(404).json({ error: 'offer not found' });
  const isBuyer = o.buyer_id === req.member.id;
  const isSeller = o.owner_id === req.member.id;
  if (!isBuyer && !isSeller) return res.status(403).json({ error: 'you were not party to this transaction' });
  if (o.status !== 'completed') {
    return res.status(409).json({ error: 'reviews are only allowed after the transaction completes' });
  }
  const rating = Number((req.body || {}).rating);
  const body = String((req.body || {}).body || '').trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating must be an integer 1–5' });
  }
  if (!body || body.length > 1000) {
    return res.status(400).json({ error: 'review body required (max 1000 chars)' });
  }
  const subject = isBuyer ? o.owner_id : o.buyer_id;
  try {
    const info = db
      .prepare(
        'INSERT INTO reviews (offer_id, reviewer_id, subject_id, rating, body) VALUES (?, ?, ?, ?, ?)'
      )
      .run(o.id, req.member.id, subject, rating, body);
    const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ review: r });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'you have already reviewed this transaction' });
    }
    throw e;
  }
});

router.get('/api/members/:id/reviews', (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.id, r.rating, r.body, r.created_at,
              rv.id AS reviewer_id, rv.display_name AS reviewer_name,
              l.id AS listing_id, l.title AS listing_title
       FROM reviews r
       JOIN members rv ON rv.id = r.reviewer_id
       JOIN offers o ON o.id = r.offer_id
       JOIN listings l ON l.id = o.listing_id
       WHERE r.subject_id = ? ORDER BY r.id DESC LIMIT 100`
    )
    .all(req.params.id);
  const avg = db
    .prepare('SELECT AVG(rating) a, COUNT(*) n FROM reviews WHERE subject_id = ?')
    .get(req.params.id);
  res.json({ reviews: rows, average_rating: avg.n ? Math.round(avg.a * 10) / 10 : null, count: avg.n });
});

// Immutability is intentional: there are no update or delete routes, and the
// DB refuses UPDATE/DELETE outright. These respond explicitly for probes.
router.all('/api/reviews/:id', (req, res) => {
  if (req.method === 'GET') {
    const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(req.params.id);
    return r ? res.json({ review: r }) : res.status(404).json({ error: 'not found' });
  }
  res.status(405).json({ error: 'reviews are immutable once posted' });
});

module.exports = { router };
