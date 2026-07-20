'use strict';

const express = require('express');
const config = require('./config');
const { db } = require('./db');
const { esc, timeAgo, layout } = require('./views');
const { browseQuery, getListing, visibleTo, photosFor } = require('./listings');

const router = express.Router();

function tile(l) {
  const photo = l.photos[0]
    ? `<img src="${esc(l.photos[0].url)}" alt="">`
    : '🧺';
  return `<a class="tile" href="/listings/${l.id}">
    <div class="ph">${photo}</div>
    <div class="body">
      <p class="t">${esc(l.title)}</p>
      <div class="m">${esc(l.category)} · ${timeAgo(l.created_at)}
        ${l.status === 'reserved' ? ' · <span class="badge reserved">reserved</span>' : ''}</div>
      <div class="price">${l.price_credits} cr</div>
    </div></a>`;
}

router.get('/', (req, res) => {
  const listings = browseQuery(req.query, req.member);
  const q = esc(req.query.q || '');
  const cat = String(req.query.category || '');
  const body = `
  <h1>Browse the stall</h1>
  <form class="filters" method="get" action="/">
    <div class="f fq"><label>Search</label><input type="text" name="q" value="${q}" placeholder="search titles &amp; descriptions"></div>
    <div class="f"><label>Category</label><select name="category">
      <option value="">all</option>
      ${config.categories.map((c) => `<option value="${c}" ${c === cat ? 'selected' : ''}>${c}</option>`).join('')}
    </select></div>
    <div class="f"><label>Min cr</label><input type="number" name="min" value="${esc(req.query.min || '')}"></div>
    <div class="f"><label>Max cr</label><input type="number" name="max" value="${esc(req.query.max || '')}"></div>
    <div class="f"><button>Filter</button></div>
  </form>
  ${listings.length ? `<div class="grid">${listings.map(tile).join('')}</div>` : `<p class="muted">Nothing here${q ? ' for that search' : ' yet'}. ${req.member ? '<a href="/sell">List something</a>?' : ''}</p>`}`;
  res.send(layout({ title: 'Browse', member: req.member, body }));
});

router.get('/login', (req, res) => {
  if (req.member) return res.redirect('/');
  const body = `
  <div class="card" style="max-width:520px;margin:40px auto;text-align:center">
    <h1>Sign in with GitHub</h1>
    <p class="muted">stall uses GitHub OAuth (device flow). No passwords are collected or stored — you authorize on github.com and we only read your public profile.</p>
    <div id="step1"><button id="start" style="font-size:16px">Start GitHub sign-in</button></div>
    <div id="step2" style="display:none">
      <p>Enter this code at <a id="vlink" href="" target="_blank" rel="noopener"></a>:</p>
      <div class="usercode" id="code"></div>
      <p class="muted small" id="status">Waiting for you to authorize…</p>
    </div>
  </div>
  <script>
  const $ = (id) => document.getElementById(id);
  $('start').onclick = async () => {
    $('start').disabled = true;
    const r = await fetch('/api/auth/device/start', {method:'POST'});
    if (!r.ok) { $('status').textContent = 'GitHub unreachable — try again.'; $('start').disabled = false; return; }
    const d = await r.json();
    $('step1').style.display = 'none'; $('step2').style.display = 'block';
    $('code').textContent = d.user_code;
    $('vlink').textContent = d.verification_uri; $('vlink').href = d.verification_uri;
    const poll = async () => {
      const pr = await fetch('/api/auth/device/poll', {method:'POST',
        headers:{'Content-Type':'application/json'}, body: JSON.stringify({login_id: d.login_id})});
      const pd = await pr.json();
      if (pd.status === 'ok') { location.href = '/'; return; }
      if (pd.status === 'failed') { $('status').textContent = 'Sign-in failed: ' + pd.reason; return; }
      setTimeout(poll, (d.interval + 1) * 1000);
    };
    setTimeout(poll, (d.interval + 1) * 1000);
  };
  </script>`;
  res.send(layout({ title: 'Sign in', member: null, body }));
});

router.post('/logout', async (req, res) => {
  // Delegate to the API handler semantics: clear session, go home.
  const { db } = require('./db');
  const crypto = require('crypto');
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('stall_session='));
  if (cookie) {
    const token = decodeURIComponent(cookie.split('=')[1]);
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(
      crypto.createHash('sha256').update(token).digest('hex'));
  }
  res.setHeader('Set-Cookie', 'stall_session=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/');
});

function listingForm({ action, l = {}, submitLabel, withPhotos }) {
  return `<form id="lform">
    <label>Title</label><input type="text" name="title" required maxlength="140" value="${esc(l.title || '')}">
    <label>Description</label><textarea name="description" required maxlength="5000">${esc(l.description || '')}</textarea>
    <label>Category</label><select name="category">
      ${config.categories.map((c) => `<option value="${c}" ${c === l.category ? 'selected' : ''}>${c}</option>`).join('')}
    </select>
    <label>Asking price (credits, whole number)</label>
    <input type="number" name="price_credits" required min="1" step="1" value="${esc(l.price_credits || '')}">
    ${withPhotos ? `<label>Photos (up to ${config.maxPhotosPerListing}, ${Math.round(config.maxPhotoBytes / 1048576)}MB each)</label>
    <input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple>` : ''}
    <p><button>${submitLabel}</button> <span class="muted small" id="err"></span></p>
  </form>
  <script>
  document.getElementById('lform').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const files = form.querySelector('[name=photos]');
    if (files && files.files.length > ${config.maxPhotosPerListing}) {
      document.getElementById('err').textContent = 'too many photos'; return;
    }
    const method = '${action.method}';
    let body = fd, headers = {};
    if (method === 'PATCH') { body = JSON.stringify(Object.fromEntries(fd)); headers = {'Content-Type':'application/json'}; }
    const r = await fetch('${action.url}', {method, body, headers});
    const d = await r.json();
    if (!r.ok) { document.getElementById('err').textContent = d.error || 'failed'; return; }
    location.href = '/listings/' + d.listing.id;
  };
  </script>`;
}

router.get('/sell', (req, res) => {
  if (!req.member) return res.redirect('/login');
  const body = `<h1>List an item</h1><div class="card">${listingForm({
    action: { method: 'POST', url: '/api/listings' },
    submitLabel: 'Publish listing',
    withPhotos: true,
  })}</div>`;
  res.send(layout({ title: 'Sell', member: req.member, body }));
});

router.get('/listings/:id/edit', (req, res) => {
  if (!req.member) return res.redirect('/login');
  const l = getListing(req.params.id);
  if (!l || l.owner_id !== req.member.id) return res.status(404).send('not found');
  const body = `<h1>Edit listing</h1><div class="card">${listingForm({
    action: { method: 'PATCH', url: `/api/listings/${l.id}` },
    l,
    submitLabel: 'Save changes',
    withPhotos: false,
  })}</div>`;
  res.send(layout({ title: 'Edit', member: req.member, body }));
});

function dealPanel(offer, member, ownerId) {
  const iAmBuyer = offer.buyer_id === member.id;
  const myConfirm = iAmBuyer ? offer.buyer_confirmed : offer.seller_confirmed;
  const otherConfirm = iAmBuyer ? offer.seller_confirmed : offer.buyer_confirmed;
  return `<div class="card"><h2>Deal in progress — ${offer.amount} cr in escrow</h2>
    <p class="muted small">${iAmBuyer ? 'You are buying' : `${esc(offer.buyer_name)} is buying`} for
    ${offer.amount} credits, held in escrow. Both parties must confirm completion; either can cancel
    before then (full refund to the buyer).</p>
    <p>${myConfirm ? 'You have confirmed. ' : `<button onclick="act('/api/offers/${offer.id}/complete')">Confirm completion</button> `}
    ${otherConfirm ? '<span class="badge completed">other party confirmed</span> ' : ''}
    <button class="danger" onclick="if(confirm('Cancel this deal and refund the buyer?'))act('/api/offers/${offer.id}/cancel')">Cancel deal</button></p></div>`;
}

function offersBlock(l, member, isOwner) {
  if (!member) return '';
  if (l.status === 'reserved') {
    const accepted = db
      .prepare(
        `SELECT o.*, b.display_name AS buyer_name FROM offers o
         JOIN members b ON b.id = o.buyer_id
         WHERE o.listing_id = ? AND o.status = 'accepted'`
      )
      .get(l.id);
    if (accepted && (accepted.buyer_id === member.id || l.owner_id === member.id)) {
      return dealPanel(accepted, member, l.owner_id);
    }
    return '';
  }
  if (l.status === 'completed') {
    const done = db
      .prepare(
        `SELECT o.*, ow.id AS owner_id FROM offers o
         JOIN listings li ON li.id = o.listing_id JOIN members ow ON ow.id = li.owner_id
         WHERE o.listing_id = ? AND o.status = 'completed'`
      )
      .get(l.id);
    if (!done || (done.buyer_id !== member.id && done.owner_id !== member.id)) return '';
    const already = db
      .prepare('SELECT 1 FROM reviews WHERE offer_id = ? AND reviewer_id = ?')
      .get(done.id, member.id);
    if (already) return '<div class="card"><p class="muted">Deal completed — you\'ve left your review. Reviews are immutable once posted.</p></div>';
    return `<div class="card"><h2>Deal completed — leave your review</h2>
      <p class="muted small">One review per party per transaction; immutable once posted.</p>
      <form id="revForm">
        <label>Rating</label><select name="rating">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</option>`).join('')}</select>
        <label>Review</label><textarea name="body" required maxlength="1000"></textarea>
        <p><button>Post review</button> <span class="muted small" id="rverr"></span></p>
      </form>
      <script>
      document.getElementById('revForm').onsubmit = async (e) => {
        e.preventDefault();
        const r = await fetch('/api/offers/${done.id}/review', {method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({rating: Number(e.target.rating.value), body: e.target.body.value})});
        const d = await r.json();
        if (!r.ok) { document.getElementById('rverr').textContent = d.error || 'failed'; return; }
        location.reload();
      };
      </script></div>`;
  }
  if (l.status !== 'active') return '';
  if (isOwner) {
    const pending = db
      .prepare(
        `SELECT o.*, b.display_name AS buyer_name, b.id AS bid FROM offers o
         JOIN members b ON b.id = o.buyer_id
         WHERE o.listing_id = ? AND o.status = 'pending' ORDER BY o.id DESC`
      )
      .all(l.id);
    if (!pending.length) return '';
    return `<div class="card"><h2>Offers on this listing</h2>
      ${pending.map((o) => `<p><strong>${o.amount} cr</strong> from <a href="/profile/${o.bid}">${esc(o.buyer_name)}</a>
        <button onclick="act('/api/offers/${o.id}/accept')">Accept</button>
        <button class="secondary" onclick="act('/api/offers/${o.id}/decline')">Decline</button></p>`).join('')}
      <p class="muted small">Accepting reserves the listing and moves the buyer's credits into escrow.</p></div>`;
  }
  const mine = db
    .prepare(
      `SELECT * FROM offers WHERE listing_id = ? AND buyer_id = ? AND status = 'pending'`
    )
    .get(l.id, member.id);
  const balance = db.prepare('SELECT balance FROM members WHERE id = ?').get(member.id).balance;
  return `<div class="card"><h2>Make an offer</h2>
    ${mine ? `<p>Your pending offer: <strong>${mine.amount} cr</strong>
      <button class="secondary" onclick="act('/api/offers/${mine.id}/cancel')">Cancel offer</button>
      <span class="muted small">A new offer replaces it.</span></p>` : ''}
    <form id="offerForm" class="row">
      <input type="number" name="amount" min="1" max="${l.price_credits}" step="1" required
        placeholder="≤ ${l.price_credits}" style="max-width:140px">
      <button>Offer credits</button>
      <span class="muted small">asking ${l.price_credits} cr · your balance ${balance} cr</span>
      <span class="muted small" id="oerr"></span>
    </form>
    <script>
    document.getElementById('offerForm').onsubmit = async (e) => {
      e.preventDefault();
      const r = await fetch('/api/listings/${l.id}/offers', {method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({amount: Number(e.target.amount.value)})});
      const d = await r.json();
      if (!r.ok) { document.getElementById('oerr').textContent = d.error || 'failed'; return; }
      location.reload();
    };
    </script></div>`;
}

function messagingBlock(l, member, isOwner) {
  if (!member) return '';
  if (isOwner) {
    const threads = db
      .prepare(
        `SELECT t.id, m.display_name,
                (SELECT body FROM messages ms WHERE ms.thread_id = t.id ORDER BY ms.id DESC LIMIT 1) AS last_body
         FROM threads t JOIN members m ON m.id = t.interested_id
         WHERE t.listing_id = ? ORDER BY t.id DESC`
      )
      .all(l.id);
    if (!threads.length) return '';
    return `<div class="card"><h2>Conversations about this listing</h2>
      ${threads.map((t) => `<p><a href="/threads/${t.id}">${esc(t.display_name)}</a>
        <span class="muted small">— ${esc((t.last_body || '').slice(0, 80))}</span></p>`).join('')}</div>`;
  }
  const mine = db
    .prepare('SELECT id FROM threads WHERE listing_id = ? AND interested_id = ?')
    .get(l.id, member.id);
  if (mine) {
    return `<div class="card"><p><a class="btn secondary" href="/threads/${mine.id}">View your conversation with the seller</a></p></div>`;
  }
  if (!['active', 'reserved'].includes(l.status)) return '';
  return `<div class="card"><h2>Message the seller</h2>
    <form id="startThread">
      <textarea name="body_text" required maxlength="2000" placeholder="Is this still available?"></textarea>
      <p><button>Send</button> <span class="muted small" id="terr"></span></p>
    </form>
    <script>
    document.getElementById('startThread').onsubmit = async (e) => {
      e.preventDefault();
      const r = await fetch('/api/listings/${l.id}/thread', {method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({body_text: e.target.body_text.value})});
      const d = await r.json();
      if (!r.ok) { document.getElementById('terr').textContent = d.error || 'failed'; return; }
      location.href = '/threads/' + d.thread.id;
    };
    </script></div>`;
}

router.get('/listings/:id', (req, res) => {
  const l = getListing(req.params.id);
  if (!visibleTo(l, req.member)) {
    return res.status(404).send(layout({ title: 'Not found', member: req.member, body: '<h1>Listing not found</h1>' }));
  }
  const photos = photosFor(l.id);
  const isOwner = req.member && req.member.id === l.owner_id;
  const body = `
  <p class="small"><a href="/">← browse</a></p>
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:start">
      <div>
        <h1 style="margin-bottom:4px">${esc(l.title)}</h1>
        <div class="muted small">${esc(l.category)} · listed ${timeAgo(l.created_at)} by
          <a href="/profile/${l.owner_id}">${esc(l.owner_display_name)}</a></div>
      </div>
      <div style="text-align:right">
        <div class="price" style="font-size:24px">${l.price_credits} cr</div>
        <span class="badge ${esc(l.status)}">${esc(l.status)}</span>
        ${l.hidden ? '<span class="badge">hidden by reports</span>' : ''}
      </div>
    </div>
    ${photos.length ? `<div class="photos">${photos.map((p) => `<img src="/photos/${esc(p.storage_key)}" alt="photo">`).join('')}</div>` : ''}
    <p style="white-space:pre-wrap">${esc(l.description)}</p>
    ${isOwner && l.status === 'active' ? `
      <p><a class="btn secondary" href="/listings/${l.id}/edit">Edit</a>
      <button class="danger" onclick="act('/api/listings/${l.id}/withdraw')">Withdraw</button></p>` : ''}
    ${!isOwner && req.member ? `
      <p><button class="secondary" onclick="act('/api/listings/${l.id}/report', 'Reported. Thanks — listings reported by ${config.reportHideThreshold} members are hidden.')">Report listing</button></p>` : ''}
    ${!req.member ? `<p class="muted small"><a href="/login">Sign in</a> to contact the seller.</p>` : ''}
  </div>
  ${offersBlock(l, req.member, isOwner)}
  ${messagingBlock(l, req.member, isOwner)}
  <div id="extras"></div>
  <script>
  async function act(url, msg) {
    const r = await fetch(url, {method:'POST'});
    const d = await r.json();
    if (!r.ok) { alert(d.error || 'failed'); return; }
    if (msg) alert(msg);
    location.reload();
  }
  </script>`;
  res.send(layout({ title: l.title, member: req.member, body }));
});

function reviewsSection(memberId) {
  const hasReviews = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reviews'")
    .get();
  if (!hasReviews) return '';
  const rows = db
    .prepare(
      `SELECT r.*, rv.display_name AS reviewer_name, l.title AS listing_title, l.id AS lid
       FROM reviews r JOIN members rv ON rv.id = r.reviewer_id
       JOIN offers o ON o.id = r.offer_id JOIN listings l ON l.id = o.listing_id
       WHERE r.subject_id = ? ORDER BY r.id DESC LIMIT 50`
    )
    .all(memberId);
  const avg = db.prepare('SELECT AVG(rating) a, COUNT(*) n FROM reviews WHERE subject_id = ?').get(memberId);
  return `<h2>Reviews ${avg.n ? `<span class="stars">${'★'.repeat(Math.round(avg.a))}</span>
    <span class="muted small">${Math.round(avg.a * 10) / 10} from ${avg.n}</span>` : ''}</h2>
  ${rows.length ? rows.map((r) => `<div class="card" style="padding:12px 16px">
      <span class="stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>
      <strong>${esc(r.reviewer_name)}</strong>
      <span class="muted small">on <a href="/listings/${r.lid}">${esc(r.listing_title)}</a> · ${timeAgo(r.created_at)}</span>
      <p style="margin:6px 0 0">${esc(r.body)}</p>
    </div>`).join('') : '<p class="muted">No reviews yet.</p>'}`;
}

router.get('/profile/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).send(layout({ title: 'Not found', member: req.member, body: '<h1>No such member</h1>' }));
  const listings = db
    .prepare(
      `SELECT l.*, m.login AS owner_login, m.display_name AS owner_display_name
       FROM listings l JOIN members m ON m.id = l.owner_id
       WHERE l.owner_id = ? AND l.status = 'active' AND l.hidden = 0
       ORDER BY l.created_at DESC`
    )
    .all(m.id)
    .map((l) => ({ ...l, photos: photosFor(l.id).map((p) => ({ url: `/photos/${p.storage_key}` })) }));
  const body = `
  <div class="card row">
    ${m.avatar_url ? `<img class="avatar" src="${esc(m.avatar_url)}" style="width:64px;height:64px">` : ''}
    <div><h1 style="margin:0">${esc(m.display_name)}</h1>
    <div class="muted small">@${esc(m.login)} · member since ${esc(m.created_at.slice(0, 10))}</div></div>
  </div>
  <h2>Active listings</h2>
  ${listings.length ? `<div class="grid">${listings.map(tile).join('')}</div>` : '<p class="muted">None right now.</p>'}
  ${reviewsSection(m.id)}`;
  res.send(layout({ title: m.display_name, member: req.member, body }));
});

router.get('/me', (req, res) => {
  if (!req.member) return res.redirect('/login');
  const mine = db
    .prepare(
      `SELECT l.*, m.login AS owner_login, m.display_name AS owner_display_name
       FROM listings l JOIN members m ON m.id = l.owner_id
       WHERE l.owner_id = ? ORDER BY l.created_at DESC`
    )
    .all(req.member.id);
  const wallet = db.prepare('SELECT balance FROM members WHERE id = ?').get(req.member.id);
  const inEscrow = db
    .prepare(
      `SELECT COALESCE(SUM(e.amount), 0) held FROM escrows e
       JOIN offers o ON o.id = e.offer_id
       WHERE e.status = 'held' AND o.buyer_id = ?`
    )
    .get(req.member.id).held;
  const deals = db
    .prepare(
      `SELECT o.*, l.title AS listing_title, l.owner_id, b.display_name AS buyer_name,
              ow.display_name AS owner_name
       FROM offers o JOIN listings l ON l.id = o.listing_id
       JOIN members b ON b.id = o.buyer_id JOIN members ow ON ow.id = l.owner_id
       WHERE (o.buyer_id = ? OR l.owner_id = ?)
         AND o.status IN ('pending','accepted','completed')
       ORDER BY o.updated_at DESC LIMIT 40`
    )
    .all(req.member.id, req.member.id);
  const dealRow = (o) => {
    const mineAsBuyer = o.buyer_id === req.member.id;
    const role = mineAsBuyer ? 'buying' : 'selling';
    const other = mineAsBuyer ? o.owner_name : o.buyer_name;
    return `<tr><td><a href="/listings/${o.listing_id}">${esc(o.listing_title)}</a></td>
      <td>${role} · ${esc(other)}</td><td>${o.amount} cr</td>
      <td><span class="badge ${o.status === 'accepted' ? 'reserved' : esc(o.status)}">${esc(o.status)}</span>
      ${o.status === 'accepted' ? `<span class="muted small">${o.buyer_confirmed ? '✓buyer' : ''} ${o.seller_confirmed ? '✓seller' : ''}</span>` : ''}</td></tr>`;
  };
  const body = `
  <h1>My stall</h1>
  <div class="card row" style="justify-content:space-between">
    <div><h2 style="margin:0">Wallet</h2>
      <span class="price" style="font-size:26px">${wallet.balance} cr</span>
      <span class="muted small">available${inEscrow ? ` · ${inEscrow} cr in escrow on your purchases` : ''}</span>
    </div>
    <a class="btn secondary" href="/api/ledger/checkpoint">ledger checkpoint ↗</a>
  </div>
  ${deals.length ? `<h2>My deals</h2><table>
    <tr><th>Listing</th><th>With</th><th>Amount</th><th>Status</th></tr>
    ${deals.map(dealRow).join('')}</table>` : ''}
  <h2>My listings</h2>
  ${mine.length ? `<table><tr><th>Title</th><th>Price</th><th>Status</th><th>Listed</th></tr>
    ${mine.map((l) => `<tr><td><a href="/listings/${l.id}">${esc(l.title)}</a>${l.hidden ? ' <span class="badge">hidden</span>' : ''}</td>
      <td>${l.price_credits} cr</td><td><span class="badge ${esc(l.status)}">${esc(l.status)}</span></td>
      <td class="muted small">${timeAgo(l.created_at)}</td></tr>`).join('')}</table>` : `<p class="muted">Nothing listed yet. <a href="/sell">Sell something</a>.</p>`}
  <div id="deals-slot"></div>`;
  res.send(layout({ title: 'My stall', member: req.member, body }));
});

router.get('/threads', (req, res) => {
  if (!req.member) return res.redirect('/login');
  const rows = db
    .prepare(
      `SELECT t.*, l.title AS listing_title, l.owner_id,
              io.display_name AS interested_name, o.display_name AS owner_name,
              (SELECT body FROM messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_body,
              (SELECT created_at FROM messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_at
       FROM threads t JOIN listings l ON l.id = t.listing_id
       JOIN members io ON io.id = t.interested_id JOIN members o ON o.id = l.owner_id
       WHERE t.interested_id = ? OR l.owner_id = ? ORDER BY last_at DESC`
    )
    .all(req.member.id, req.member.id);
  const body = `<h1>Messages</h1>
  ${rows.length ? rows.map((t) => {
    const other = t.owner_id === req.member.id ? t.interested_name : t.owner_name;
    return `<div class="card" style="padding:12px 16px">
      <a href="/threads/${t.id}"><strong>${esc(other)}</strong> · ${esc(t.listing_title)}</a>
      <div class="muted small">${esc((t.last_body || '').slice(0, 100))} · ${t.last_at ? timeAgo(t.last_at) : ''}</div>
    </div>`;
  }).join('') : '<p class="muted">No conversations yet. Find something on the <a href="/">board</a> and message the seller.</p>'}`;
  res.send(layout({ title: 'Messages', member: req.member, body }));
});

router.get('/threads/:id', (req, res) => {
  if (!req.member) return res.redirect('/login');
  const { threadForParticipant } = require('./messages');
  const t = threadForParticipant(req.params.id, req.member.id);
  if (!t) {
    return res.status(404).send(layout({ title: 'Not found', member: req.member, body: '<h1>Thread not found</h1>' }));
  }
  const messages = db
    .prepare(
      `SELECT m.*, mem.display_name AS sender_name FROM messages m
       JOIN members mem ON mem.id = m.sender_id WHERE m.thread_id = ? ORDER BY m.id`
    )
    .all(t.id);
  const other = req.member.id === t.owner_id ? t.interested_name : t.owner_name;
  const body = `
  <p class="small"><a href="/threads">← all messages</a></p>
  <h1>${esc(other)} · <a href="/listings/${t.listing_id}">${esc(t.listing_title)}</a></h1>
  <div class="card">
    ${messages.map((m) => `<div class="msg ${m.sender_id === req.member.id ? 'mine' : 'theirs'}">
      <div class="who">${esc(m.sender_name)} · ${timeAgo(m.created_at)}</div>${esc(m.body)}</div>`).join('')}
    <form id="reply" style="margin-top:14px">
      <textarea name="body_text" required maxlength="2000" placeholder="Reply…"></textarea>
      <p><button>Send</button> <span class="muted small" id="rerr"></span></p>
    </form>
  </div>
  <script>
  document.getElementById('reply').onsubmit = async (e) => {
    e.preventDefault();
    const r = await fetch('/api/threads/${t.id}/messages', {method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({body_text: e.target.body_text.value})});
    if (!r.ok) { const d = await r.json(); document.getElementById('rerr').textContent = d.error || 'failed'; return; }
    location.reload();
  };
  </script>`;
  res.send(layout({ title: `Chat · ${t.listing_title}`, member: req.member, body }));
});

module.exports = { router, tile };
