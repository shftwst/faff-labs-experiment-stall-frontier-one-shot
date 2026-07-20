'use strict';

// Reviews probe: reviews only after completion, exactly one per party per
// completed transaction, immutable once posted.

const { Checks } = require('./lib');

async function run(client, runId) {
  const c = new Checks('reviews');
  console.log('\n== Reviews probe ==');

  const seller = await client.login(`${runId}-rev-seller`);
  const buyer = await client.login(`${runId}-rev-buyer`);
  const mallory = await client.login(`${runId}-rev-mallory`);

  async function makeDeal(suffix) {
    const l = await seller.post('/api/listings', {
      title: `Review fixture ${suffix} ${runId}`,
      description: 'Fixture for the reviews probe.',
      category: 'other',
      price_credits: 20,
    });
    const o = await buyer.post(`/api/listings/${l.data.listing.id}/offers`, { amount: 15 });
    await seller.post(`/api/offers/${o.data.offer.id}/accept`);
    return { listing: l.data.listing.id, offer: o.data.offer.id };
  }

  // Reviewing an uncompleted (reserved) transaction is refused.
  const pendingDeal = await makeDeal('pending');
  const early = await buyer.post(`/api/offers/${pendingDeal.offer}/review`, { rating: 5, body: 'too early' });
  c.expect('review before completion is refused', early.status, 409);

  // Complete it, then review properly.
  await buyer.post(`/api/offers/${pendingDeal.offer}/complete`);
  await seller.post(`/api/offers/${pendingDeal.offer}/complete`);

  const nonParty = await mallory.post(`/api/offers/${pendingDeal.offer}/review`, { rating: 1, body: 'drive-by' });
  c.expect('review by a non-party is refused', nonParty.status, 403);

  const first = await buyer.post(`/api/offers/${pendingDeal.offer}/review`, { rating: 5, body: 'Great seller!' });
  c.expect('party can review after completion', first.status, 201);
  const second = await buyer.post(`/api/offers/${pendingDeal.offer}/review`, { rating: 1, body: 'changed my mind' });
  c.expect('second review by the same party is refused', second.status, 409);
  const bySeller = await seller.post(`/api/offers/${pendingDeal.offer}/review`, { rating: 4, body: 'Prompt payment.' });
  c.expect('the other party can post their one review', bySeller.status, 201);

  // Immutability: no mutation route exists; the posted review is unchanged.
  const rid = first.data.review && first.data.review.id;
  const patch = await buyer.req('PATCH', `/api/reviews/${rid}`, { body: 'edited!' });
  c.add('review edit attempt is refused', patch.status === 405, `got ${patch.status}`);
  const del = await buyer.req('DELETE', `/api/reviews/${rid}`);
  c.add('review delete attempt is refused', del.status === 405, `got ${del.status}`);
  const reread = await client.raw('GET', `/api/reviews/${rid}`);
  c.add(
    'posted review is unchanged after mutation attempts',
    reread.status === 200 && reread.data.review.body === 'Great seller!' && reread.data.review.rating === 5,
    JSON.stringify(reread.data.review)
  );

  // Reviews show on the subject's public profile feed.
  const sellerReviews = await client.raw('GET', `/api/members/${seller.id}/reviews`);
  c.add(
    "review appears on the subject's public review feed",
    sellerReviews.status === 200 && sellerReviews.data.reviews.some((r) => r.id === rid),
    JSON.stringify(sellerReviews.data.count)
  );

  return c.results;
}

module.exports = { run };
