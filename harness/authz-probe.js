'use strict';

// Authorization probe: authenticates as real, distinct members and attempts —
// via the public API directly — the cross-member reads and mutations the PRD
// forbids. Every attempt must be refused server-side.

const { Checks } = require('./lib');

async function run(client, runId) {
  const c = new Checks('authz');
  console.log('\n== Authorization probe ==');

  const owner = await client.login(`${runId}-owner`);
  const mallory = await client.login(`${runId}-mallory`);
  const cleanup = [];

  // Owner creates a listing (positive control).
  const created = await owner.post('/api/listings', {
    title: `Harness bicycle ${runId}`,
    description: 'A bicycle that exists only to be probed.',
    category: 'sports',
    price_credits: 120,
  });
  c.expect('owner can create a listing', created.status, 201);
  const lid = created.data.listing && created.data.listing.id;
  if (lid) cleanup.push({ member: owner, lid });

  // Unauthenticated mutations are refused.
  const anonCreate = await client.raw('POST', '/api/listings', {
    body: { title: 'x', description: 'x', category: 'other', price_credits: 1 },
  });
  c.expect('unauthenticated create is refused', anonCreate.status, 401);
  const anonEdit = await client.raw('PATCH', `/api/listings/${lid}`, { body: { title: 'stolen' } });
  c.expect('unauthenticated edit is refused', anonEdit.status, 401);

  // Another member cannot edit, withdraw, or add/remove photos on a listing
  // they do not own.
  const edit = await mallory.req('PATCH', `/api/listings/${lid}`, { title: 'now mine' });
  c.expect("edit of another member's listing is refused", edit.status, 403);
  const withdraw = await mallory.post(`/api/listings/${lid}/withdraw`);
  c.expect("withdraw of another member's listing is refused", withdraw.status, 403);
  const delPhoto = await mallory.req('DELETE', `/api/listings/${lid}/photos/1`);
  c.expect("photo removal on another member's listing is refused", delPhoto.status, 403);

  // The refused edit must not have taken effect.
  const after = await owner.get(`/api/listings/${lid}`);
  c.add(
    'refused edit did not change the listing',
    after.status === 200 && after.data.listing.title.startsWith('Harness bicycle'),
    JSON.stringify(after.data.listing && after.data.listing.title)
  );

  // Owner CAN edit their own (positive control that 403s above are authz, not breakage).
  const ownEdit = await owner.req('PATCH', `/api/listings/${lid}`, { title: `Harness bicycle ${runId} (tuned)` });
  c.expect('owner can edit their own listing', ownEdit.status, 200);

  // Owners cannot report their own listing; others can, and at the stated
  // threshold the listing is hidden from browse and non-owner reads.
  const selfReport = await owner.post(`/api/listings/${lid}/report`);
  c.expect('reporting your own listing is refused', selfReport.status, 400);

  const victim = await owner.post('/api/listings', {
    title: `Harness gnome ${runId}`,
    description: 'Reportable garden gnome.',
    category: 'garden',
    price_credits: 30,
  });
  const vid = victim.data.listing.id;
  cleanup.push({ member: owner, lid: vid });
  const reporters = [];
  for (let i = 0; i < 3; i++) reporters.push(await client.login(`${runId}-reporter-${i}`));
  for (let i = 0; i < 2; i++) await reporters[i].post(`/api/listings/${vid}/report`);
  const visibleBefore = await mallory.get(`/api/listings/${vid}`);
  c.expect('listing below report threshold is still visible', visibleBefore.status, 200);
  const third = await reporters[2].post(`/api/listings/${vid}/report`);
  c.add('third distinct report hides the listing', third.status === 200 && third.data.hidden === true, JSON.stringify(third.data));
  const hiddenRead = await mallory.get(`/api/listings/${vid}`);
  c.expect('hidden listing is not readable by non-owners', hiddenRead.status, 404);
  const browse = await mallory.get('/api/listings?limit=100');
  c.add(
    'hidden listing is absent from browse',
    browse.status === 200 && !browse.data.listings.some((l) => l.id === vid),
    'hidden listing appeared in browse'
  );
  const ownerRead = await owner.get(`/api/listings/${vid}`);
  c.expect('owner can still read their hidden listing', ownerRead.status, 200);

  // ---- messaging authz (present from v0.2) ----
  const feat = await client.raw('GET', '/api/features');
  const features = feat.status === 200 ? feat.data : {};
  if (features.messaging) {
    const buyer = await client.login(`${runId}-buyer`);
    const t = await buyer.post(`/api/listings/${lid}/thread`, { body_text: 'Is this available?' });
    c.expect('interested member can open a thread', t.status, 201);
    const tid = t.data.thread && t.data.thread.id;
    const readByOwner = await owner.get(`/api/threads/${tid}`);
    c.expect('listing owner can read the thread', readByOwner.status, 200);
    const snoop = await mallory.get(`/api/threads/${tid}`);
    c.add("read of another member's thread is refused", snoop.status === 403 || snoop.status === 404, `got ${snoop.status}`);
    const snoopPost = await mallory.post(`/api/threads/${tid}/messages`, { body_text: 'let me in' });
    c.add('posting into another member\'s thread is refused', snoopPost.status === 403 || snoopPost.status === 404, `got ${snoopPost.status}`);
    const anonRead = await client.raw('GET', `/api/threads/${tid}`);
    c.expect('unauthenticated thread read is refused', anonRead.status, 401);
    const listThreads = await mallory.get('/api/threads');
    c.add(
      'thread listing only shows own threads',
      listThreads.status === 200 && !listThreads.data.threads.some((th) => th.id === tid),
      'foreign thread visible in index'
    );
  }

  // ---- offer authz (present from v0.3) ----
  if (features.offers) {
    const buyer = await client.login(`${runId}-offer-buyer`);
    const off = await buyer.post(`/api/listings/${lid}/offers`, { amount: 50 });
    c.expect('member can make an offer', off.status, 201);
    const oid = off.data.offer && off.data.offer.id;
    const acceptByMallory = await mallory.post(`/api/offers/${oid}/accept`);
    c.add(
      "accepting an offer on another member's listing is refused",
      acceptByMallory.status === 403 || acceptByMallory.status === 404,
      `got ${acceptByMallory.status}`
    );
    const acceptByBuyer = await buyer.post(`/api/offers/${oid}/accept`);
    c.add(
      'buyer cannot accept their own offer',
      acceptByBuyer.status === 403 || acceptByBuyer.status === 404,
      `got ${acceptByBuyer.status}`
    );
    const declineByMallory = await mallory.post(`/api/offers/${oid}/decline`);
    c.add(
      "declining an offer on another member's listing is refused",
      declineByMallory.status === 403 || declineByMallory.status === 404,
      `got ${declineByMallory.status}`
    );
    const foreignOffers = await mallory.get(`/api/listings/${lid}/offers`);
    c.add(
      "reading another listing's offers as a third party is refused or empty",
      foreignOffers.status === 403 || foreignOffers.status === 404 ||
        (foreignOffers.status === 200 && (foreignOffers.data.offers || []).length === 0),
      `got ${foreignOffers.status}`
    );
    await owner.post(`/api/offers/${oid}/decline`);
  }

  // Cleanup: withdraw harness listings so the public instance stays tidy.
  for (const { member, lid: id } of cleanup) {
    await member.post(`/api/listings/${id}/withdraw`);
  }

  return c.results;
}

module.exports = { run };
