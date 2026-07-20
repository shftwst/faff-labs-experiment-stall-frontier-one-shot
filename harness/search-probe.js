'use strict';

// Search probe: creates listings with known content, then asserts that every
// search result matches the query and active filters, ordered newest first.

const { Checks } = require('./lib');

async function run(client, runId) {
  const c = new Checks('search');
  console.log('\n== Search probe ==');

  const seller = await client.login(`${runId}-searcher`);
  const uniq = `zx${runId.replace(/[^a-z0-9]/g, '')}`;
  const made = [];
  const specs = [
    { title: `Walnut ${uniq} bookshelf`, description: 'Solid walnut shelving unit', category: 'furniture', price_credits: 200 },
    { title: `Pine bookshelf`, description: `Cheap and cheerful ${uniq} shelf`, category: 'furniture', price_credits: 40 },
    { title: `${uniq} telescope`, description: 'Stargazing kit', category: 'electronics', price_credits: 350 },
  ];
  for (const s of specs) {
    const r = await seller.post('/api/listings', s);
    if (r.status !== 201) throw new Error(`search probe listing create failed: ${JSON.stringify(r.data)}`);
    made.push(r.data.listing);
    await new Promise((r) => setTimeout(r, 30));
  }

  // Query matches title OR description; all three contain the unique token.
  const all = await seller.get(`/api/listings?q=${uniq}`);
  c.add(
    'every result matches the query',
    all.status === 200 && all.data.listings.length === 3 &&
      all.data.listings.every((l) => (l.title + ' ' + l.description).includes(uniq)),
    `got ${all.data.listings && all.data.listings.length} results`
  );
  const ids = all.data.listings.map((l) => l.id);
  c.add(
    'results are ordered newest first',
    ids.join(',') === [made[2].id, made[1].id, made[0].id].join(','),
    `order was ${ids.join(',')}`
  );

  const filtered = await seller.get(`/api/listings?q=${uniq}&category=furniture&min=100&max=300`);
  c.add(
    'category and price filters apply to search results',
    filtered.status === 200 && filtered.data.listings.length === 1 &&
      filtered.data.listings[0].id === made[0].id,
    JSON.stringify(filtered.data.listings && filtered.data.listings.map((l) => l.id))
  );

  const none = await seller.get(`/api/listings?q=${uniq}nonexistenttoken`);
  c.add(
    'non-matching query returns nothing',
    none.status === 200 && none.data.listings.length === 0,
    `got ${none.data.listings && none.data.listings.length}`
  );

  // Withdrawn listings drop out of search.
  await seller.post(`/api/listings/${made[2].id}/withdraw`);
  const afterWithdraw = await seller.get(`/api/listings?q=${uniq}`);
  c.add(
    'withdrawn listings are absent from search',
    afterWithdraw.status === 200 && !afterWithdraw.data.listings.some((l) => l.id === made[2].id),
    'withdrawn listing still in results'
  );

  for (const l of made.slice(0, 2)) await seller.post(`/api/listings/${l.id}/withdraw`);
  return c.results;
}

module.exports = { run };
