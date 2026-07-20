'use strict';

const express = require('express');
const { db } = require('./db');
const { requireAuth } = require('./auth');
const { getListing, visibleTo } = require('./listings');

const router = express.Router();

// All money movements happen inside synchronous better-sqlite3 transactions:
// a balance check and the deduction it guards can never interleave with
// another request's, so concurrent acceptances that would overdraw a buyer
// serialize and only those the balance covers succeed.

class OpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function offerJson(o) {
  return {
    id: o.id,
    listing: { id: o.listing_id, title: o.listing_title, status: o.listing_status },
    buyer: { id: o.buyer_id, display_name: o.buyer_name },
    seller: { id: o.owner_id, display_name: o.owner_name },
    amount: o.amount,
    status: o.status,
    buyer_confirmed: !!o.buyer_confirmed,
    seller_confirmed: !!o.seller_confirmed,
    created_at: o.created_at,
    updated_at: o.updated_at,
  };
}

function fullOffer(id) {
  return db
    .prepare(
      `SELECT o.*, l.title AS listing_title, l.status AS listing_status, l.owner_id,
              b.display_name AS buyer_name, ow.display_name AS owner_name
       FROM offers o
       JOIN listings l ON l.id = o.listing_id
       JOIN members b ON b.id = o.buyer_id
       JOIN members ow ON ow.id = l.owner_id
       WHERE o.id = ?`
    )
    .get(id);
}

const createOfferTx = db.transaction((listingId, buyerId, amount) => {
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
  if (!l) throw new OpError(404, 'listing not found');
  if (l.owner_id === buyerId) throw new OpError(400, 'cannot make an offer on your own listing');
  if (l.status !== 'active') throw new OpError(409, `listing is ${l.status}, not open to offers`);
  if (!Number.isInteger(amount) || amount < 1) throw new OpError(400, 'offer must be a positive whole number of credits');
  if (amount > l.price_credits) throw new OpError(400, 'offers must be at or below the asking price');
  // A new offer from the same buyer supersedes their previous pending one.
  db.prepare(
    `UPDATE offers SET status = 'superseded', updated_at = ${now}
     WHERE listing_id = ? AND buyer_id = ? AND status = 'pending'`
  ).run(listingId, buyerId);
  const info = db
    .prepare('INSERT INTO offers (listing_id, buyer_id, amount) VALUES (?, ?, ?)')
    .run(listingId, buyerId, amount);
  return info.lastInsertRowid;
});

const acceptTx = db.transaction((offerId, actorId) => {
  const o = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
  if (!o) throw new OpError(404, 'offer not found');
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(o.listing_id);
  if (l.owner_id !== actorId) throw new OpError(403, 'only the listing owner may accept offers');
  if (o.status !== 'pending') throw new OpError(409, `offer is ${o.status}`);
  if (l.status !== 'active') throw new OpError(409, `listing is ${l.status}`);
  const buyer = db.prepare('SELECT balance FROM members WHERE id = ?').get(o.buyer_id);
  if (buyer.balance < o.amount) {
    throw new OpError(409, 'buyer balance does not cover this offer');
  }
  db.prepare('UPDATE members SET balance = balance - ? WHERE id = ?').run(o.amount, o.buyer_id);
  db.prepare('INSERT INTO escrows (offer_id, amount) VALUES (?, ?)').run(o.id, o.amount);
  db.prepare(
    "INSERT INTO ledger_entries (kind, member_id, offer_id, delta) VALUES ('escrow_hold', ?, ?, ?)"
  ).run(o.buyer_id, o.id, -o.amount);
  db.prepare(`UPDATE offers SET status = 'accepted', updated_at = ${now} WHERE id = ?`).run(o.id);
  db.prepare("UPDATE listings SET status = 'reserved' WHERE id = ?").run(l.id);
  db.prepare(
    `UPDATE offers SET status = 'superseded', updated_at = ${now}
     WHERE listing_id = ? AND status = 'pending' AND id != ?`
  ).run(l.id, o.id);
});

const declineTx = db.transaction((offerId, actorId) => {
  const o = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
  if (!o) throw new OpError(404, 'offer not found');
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(o.listing_id);
  if (l.owner_id !== actorId) throw new OpError(403, 'only the listing owner may decline offers');
  if (o.status !== 'pending') throw new OpError(409, `offer is ${o.status}`);
  db.prepare(`UPDATE offers SET status = 'declined', updated_at = ${now} WHERE id = ?`).run(o.id);
});

// Cancel: a buyer may cancel their own pending offer; either party may cancel
// an accepted (reserved) deal before completion — escrow refunds the buyer in
// full and the listing returns to active.
const cancelTx = db.transaction((offerId, actorId) => {
  const o = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
  if (!o) throw new OpError(404, 'offer not found');
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(o.listing_id);
  const isBuyer = o.buyer_id === actorId;
  const isSeller = l.owner_id === actorId;
  if (!isBuyer && !isSeller) throw new OpError(403, 'not your offer');
  if (o.status === 'pending') {
    if (!isBuyer) throw new OpError(403, 'only the buyer may cancel a pending offer');
    db.prepare(`UPDATE offers SET status = 'cancelled', updated_at = ${now} WHERE id = ?`).run(o.id);
    return { refunded: false };
  }
  if (o.status === 'accepted') {
    const e = db.prepare("SELECT * FROM escrows WHERE offer_id = ? AND status = 'held'").get(o.id);
    if (!e) throw new OpError(500, 'escrow missing for accepted offer');
    db.prepare(`UPDATE escrows SET status = 'refunded', updated_at = ${now} WHERE id = ?`).run(e.id);
    db.prepare('UPDATE members SET balance = balance + ? WHERE id = ?').run(e.amount, o.buyer_id);
    db.prepare(
      "INSERT INTO ledger_entries (kind, member_id, offer_id, delta) VALUES ('escrow_refund', ?, ?, ?)"
    ).run(o.buyer_id, o.id, e.amount);
    db.prepare(`UPDATE offers SET status = 'cancelled', updated_at = ${now} WHERE id = ?`).run(o.id);
    db.prepare("UPDATE listings SET status = 'active' WHERE id = ?").run(l.id);
    return { refunded: true };
  }
  throw new OpError(409, `offer is ${o.status}`);
});

// Completion requires both parties to confirm; on the second confirmation the
// escrow releases to the seller and the listing completes — atomically.
const completeTx = db.transaction((offerId, actorId) => {
  const o = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
  if (!o) throw new OpError(404, 'offer not found');
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(o.listing_id);
  const isBuyer = o.buyer_id === actorId;
  const isSeller = l.owner_id === actorId;
  if (!isBuyer && !isSeller) throw new OpError(403, 'not your deal');
  if (o.status !== 'accepted') throw new OpError(409, `offer is ${o.status}`);
  const col = isBuyer ? 'buyer_confirmed' : 'seller_confirmed';
  db.prepare(`UPDATE offers SET ${col} = 1, updated_at = ${now} WHERE id = ?`).run(o.id);
  const fresh = db.prepare('SELECT * FROM offers WHERE id = ?').get(o.id);
  if (fresh.buyer_confirmed && fresh.seller_confirmed) {
    const e = db.prepare("SELECT * FROM escrows WHERE offer_id = ? AND status = 'held'").get(o.id);
    if (!e) throw new OpError(500, 'escrow missing for accepted offer');
    db.prepare(`UPDATE escrows SET status = 'released', updated_at = ${now} WHERE id = ?`).run(e.id);
    db.prepare('UPDATE members SET balance = balance + ? WHERE id = ?').run(e.amount, l.owner_id);
    db.prepare(
      "INSERT INTO ledger_entries (kind, member_id, offer_id, delta) VALUES ('escrow_release', ?, ?, ?)"
    ).run(l.owner_id, o.id, e.amount);
    db.prepare(`UPDATE offers SET status = 'completed', updated_at = ${now} WHERE id = ?`).run(o.id);
    db.prepare("UPDATE listings SET status = 'completed' WHERE id = ?").run(l.id);
    return { completed: true };
  }
  return { completed: false };
});

function handle(res, fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof OpError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}

router.post('/api/listings/:id/offers', requireAuth, (req, res) => {
  const l = getListing(req.params.id);
  if (!visibleTo(l, req.member)) return res.status(404).json({ error: 'listing not found' });
  handle(res, () => {
    const amount = Number((req.body || {}).amount);
    const id = createOfferTx(l.id, req.member.id, amount);
    res.status(201).json({ offer: offerJson(fullOffer(id)) });
  });
});

router.get('/api/listings/:id/offers', requireAuth, (req, res) => {
  const l = getListing(req.params.id);
  if (!l) return res.status(404).json({ error: 'listing not found' });
  if (l.owner_id !== req.member.id) {
    return res.status(403).json({ error: 'only the listing owner may view its offers' });
  }
  const rows = db
    .prepare(
      `SELECT o.*, l.title AS listing_title, l.status AS listing_status, l.owner_id,
              b.display_name AS buyer_name, ow.display_name AS owner_name
       FROM offers o JOIN listings l ON l.id = o.listing_id
       JOIN members b ON b.id = o.buyer_id JOIN members ow ON ow.id = l.owner_id
       WHERE o.listing_id = ? ORDER BY o.id DESC`
    )
    .all(l.id);
  res.json({ offers: rows.map(offerJson) });
});

router.get('/api/offers', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT o.*, l.title AS listing_title, l.status AS listing_status, l.owner_id,
              b.display_name AS buyer_name, ow.display_name AS owner_name
       FROM offers o JOIN listings l ON l.id = o.listing_id
       JOIN members b ON b.id = o.buyer_id JOIN members ow ON ow.id = l.owner_id
       WHERE o.buyer_id = ? OR l.owner_id = ? ORDER BY o.updated_at DESC`
    )
    .all(req.member.id, req.member.id);
  res.json({ offers: rows.map(offerJson) });
});

router.post('/api/offers/:id/accept', requireAuth, (req, res) =>
  handle(res, () => {
    acceptTx(Number(req.params.id), req.member.id);
    res.json({ offer: offerJson(fullOffer(req.params.id)) });
  })
);

router.post('/api/offers/:id/decline', requireAuth, (req, res) =>
  handle(res, () => {
    declineTx(Number(req.params.id), req.member.id);
    res.json({ offer: offerJson(fullOffer(req.params.id)) });
  })
);

router.post('/api/offers/:id/cancel', requireAuth, (req, res) =>
  handle(res, () => {
    const r = cancelTx(Number(req.params.id), req.member.id);
    res.json({ ...r, offer: offerJson(fullOffer(req.params.id)) });
  })
);

router.post('/api/offers/:id/complete', requireAuth, (req, res) =>
  handle(res, () => {
    const r = completeTx(Number(req.params.id), req.member.id);
    res.json({ ...r, offer: offerJson(fullOffer(req.params.id)) });
  })
);

// Public aggregate invariant checkpoint. Computed in a single statement, so
// the snapshot is consistent even under concurrent writes.
router.get('/api/ledger/checkpoint', (req, res) => {
  const r = db
    .prepare(
      `SELECT
        (SELECT COALESCE(SUM(balance), 0) FROM members) AS sum_balances,
        (SELECT COALESCE(SUM(amount), 0) FROM escrows WHERE status = 'held') AS escrow_held,
        (SELECT total_seeded FROM ledger_meta WHERE id = 1) AS total_seeded,
        (SELECT COUNT(*) FROM members WHERE balance < 0) AS negative_balances`
    )
    .get();
  res.json({
    ...r,
    zero_sum: r.sum_balances + r.escrow_held === r.total_seeded,
    checked_at: new Date().toISOString(),
  });
});

router.get('/api/me', requireAuth, (req, res) => {
  const m = db
    .prepare('SELECT id, login, display_name, balance, is_harness, created_at FROM members WHERE id = ?')
    .get(req.member.id);
  res.json({ member: m });
});

module.exports = { router };
