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
  <div id="reviews-slot"></div>`;
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
  const body = `
  <h1>My stall</h1>
  <div id="wallet-slot"></div>
  <h2>My listings</h2>
  ${mine.length ? `<table><tr><th>Title</th><th>Price</th><th>Status</th><th>Listed</th></tr>
    ${mine.map((l) => `<tr><td><a href="/listings/${l.id}">${esc(l.title)}</a>${l.hidden ? ' <span class="badge">hidden</span>' : ''}</td>
      <td>${l.price_credits} cr</td><td><span class="badge ${esc(l.status)}">${esc(l.status)}</span></td>
      <td class="muted small">${timeAgo(l.created_at)}</td></tr>`).join('')}</table>` : `<p class="muted">Nothing listed yet. <a href="/sell">Sell something</a>.</p>`}
  <div id="deals-slot"></div>`;
  res.send(layout({ title: 'My stall', member: req.member, body }));
});

module.exports = { router, tile };
