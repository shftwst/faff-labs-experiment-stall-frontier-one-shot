'use strict';

// Ledger property runner.
//
// Applies a seeded-random sequence of offers, acceptances, declines,
// cancellations, completions, and withdrawals against a running instance's
// public API, as real authenticated members. A local shadow model predicts
// the expected outcome of every operation (including expected refusals); after
// EVERY operation the runner fetches the public ledger checkpoint and asserts:
//   - zero-sum: SUM(balances) + SUM(held escrow) == total seeded
//   - non-negativity: no member balance below zero
//   - escrow lifecycle: every response matches the model's expected transition
// Periodic audits compare every runner member's server-side balance to the
// model exactly. Dedicated rounds fire genuinely concurrent acceptances that
// together overdraw a buyer, asserting only what the balance covers succeeds.

const { Checks } = require('./lib');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function run(client, runId, { seed = 1, ops = 120 } = {}) {
  const c = new Checks('ledger');
  console.log(`\n== Ledger property runner (seed ${seed}, ${ops} ops) ==`);
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const randint = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

  // --- shadow model
  const M = {
    members: new Map(), // id -> {handle, balance}
    listings: new Map(), // id -> {owner, price, status}
    offers: new Map(), // id -> {listing, buyer, amount, status, bc, sc}
    escrowHeld: 0,
    seededByUs: 0,
  };

  const violations = { zeroSum: 0, negative: 0, model: 0, response: 0, audit: 0 };
  let checkpoints = 0;
  const note = (kind, detail) => {
    violations[kind]++;
    console.log(`    !! ${kind} violation: ${detail}`);
  };

  async function checkpoint(tag) {
    const r = await client.raw('GET', '/api/ledger/checkpoint');
    checkpoints++;
    if (r.status !== 200) return note('zeroSum', `checkpoint fetch failed ${r.status}`);
    if (!r.data.zero_sum) {
      note('zeroSum', `${tag}: balances ${r.data.sum_balances} + escrow ${r.data.escrow_held} != seeded ${r.data.total_seeded}`);
    }
    if (r.data.negative_balances > 0) {
      note('negative', `${tag}: ${r.data.negative_balances} negative balances`);
    }
    return r.data;
  }

  async function audit() {
    for (const [id, m] of M.members) {
      const r = await m.handle.get('/api/me');
      if (r.status !== 200 || r.data.member.balance !== m.balance) {
        note('audit', `member ${id}: server ${r.data.member && r.data.member.balance} != model ${m.balance}`);
      }
    }
  }

  // --- founding members
  const base = await checkpoint('baseline');
  const POOL = 5;
  for (let i = 0; i < POOL; i++) {
    const handle = await client.login(`${runId}-m${i}`);
    M.members.set(handle.id, { handle, balance: 1000 });
    M.seededByUs += 1000;
  }
  const after = await checkpoint('after member creation');
  c.add(
    'seeding: each new member adds exactly the seed amount to total_seeded',
    after && base && after.total_seeded - base.total_seeded === M.seededByUs,
    `expected +${M.seededByUs}, got +${after && base ? after.total_seeded - base.total_seeded : '?'}`
  );

  const memberIds = [...M.members.keys()];
  const H = (id) => M.members.get(id).handle;

  // --- op generators; each returns {desc, exec} or null if no candidate state
  function candidates(fn) {
    return [...M.offers.entries()].filter(([, o]) => fn(o)).map(([id, o]) => ({ id: Number(id), ...o }));
  }
  const activeListings = () =>
    [...M.listings.entries()].filter(([, l]) => l.status === 'active').map(([id, l]) => ({ id: Number(id), ...l }));

  const opKinds = [
    {
      name: 'create-listing', weight: 14,
      gen() {
        const owner = pick(memberIds);
        const price = randint(10, 400);
        return async () => {
          const r = await H(owner).post('/api/listings', {
            title: `Ledger item ${runId}-${randint(1000, 9999)}`,
            description: 'Property-runner listing.',
            category: 'other',
            price_credits: price,
          });
          if (r.status !== 201) return note('response', `create-listing got ${r.status}`);
          M.listings.set(r.data.listing.id, { owner, price, status: 'active' });
        };
      },
    },
    {
      name: 'make-offer', weight: 24,
      gen() {
        const ls = activeListings();
        if (!ls.length) return null;
        const l = pick(ls);
        const buyers = memberIds.filter((m) => m !== l.owner);
        const buyer = pick(buyers);
        const amount = randint(1, l.price);
        return async () => {
          const r = await H(buyer).post(`/api/listings/${l.id}/offers`, { amount });
          if (r.status !== 201) return note('response', `make-offer got ${r.status}: ${JSON.stringify(r.data)}`);
          for (const [oid, o] of M.offers) {
            if (o.listing === l.id && o.buyer === buyer && o.status === 'pending') o.status = 'superseded';
          }
          M.offers.set(r.data.offer.id, { listing: l.id, buyer, amount, status: 'pending', bc: false, sc: false });
        };
      },
    },
    {
      name: 'accept-offer', weight: 20,
      gen() {
        const pend = candidates((o) => o.status === 'pending' && M.listings.get(o.listing).status === 'active');
        if (!pend.length) return null;
        const o = pick(pend);
        const l = M.listings.get(o.listing);
        const covered = M.members.get(o.buyer).balance >= o.amount;
        return async () => {
          const r = await H(l.owner).post(`/api/offers/${o.id}/accept`);
          if (covered) {
            if (r.status !== 200) return note('response', `accept expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
            M.members.get(o.buyer).balance -= o.amount;
            M.escrowHeld += o.amount;
            M.offers.get(o.id).status = 'accepted';
            l.status = 'reserved';
            for (const [, other] of M.offers) {
              if (other.listing === o.listing && other.status === 'pending') other.status = 'superseded';
            }
          } else {
            if (r.status !== 409) return note('response', `overdraw accept expected 409, got ${r.status}`);
          }
        };
      },
    },
    {
      name: 'decline-offer', weight: 8,
      gen() {
        const pend = candidates((o) => o.status === 'pending');
        if (!pend.length) return null;
        const o = pick(pend);
        const l = M.listings.get(o.listing);
        return async () => {
          const r = await H(l.owner).post(`/api/offers/${o.id}/decline`);
          if (r.status !== 200) return note('response', `decline got ${r.status}`);
          M.offers.get(o.id).status = 'declined';
        };
      },
    },
    {
      name: 'cancel', weight: 12,
      gen() {
        const cancellable = candidates((o) => o.status === 'pending' || o.status === 'accepted');
        if (!cancellable.length) return null;
        const o = pick(cancellable);
        const l = M.listings.get(o.listing);
        const actor = o.status === 'pending' ? o.buyer : pick([o.buyer, l.owner]);
        return async () => {
          const r = await H(actor).post(`/api/offers/${o.id}/cancel`);
          if (r.status !== 200) return note('response', `cancel got ${r.status}: ${JSON.stringify(r.data)}`);
          if (o.status === 'accepted') {
            M.members.get(o.buyer).balance += o.amount;
            M.escrowHeld -= o.amount;
            l.status = 'active';
          }
          M.offers.get(o.id).status = 'cancelled';
        };
      },
    },
    {
      name: 'confirm-completion', weight: 16,
      gen() {
        const acc = candidates((o) => o.status === 'accepted');
        if (!acc.length) return null;
        const o = pick(acc);
        const l = M.listings.get(o.listing);
        const asBuyer = o.bc && !o.sc ? false : o.sc && !o.bc ? true : rnd() < 0.5;
        const actor = asBuyer ? o.buyer : l.owner;
        return async () => {
          const r = await H(actor).post(`/api/offers/${o.id}/complete`);
          if (r.status !== 200) return note('response', `complete got ${r.status}: ${JSON.stringify(r.data)}`);
          const model = M.offers.get(o.id);
          if (asBuyer) model.bc = true; else model.sc = true;
          const both = model.bc && model.sc;
          if (r.data.completed !== both) {
            return note('model', `completion state diverged: server says ${r.data.completed}, model ${both}`);
          }
          if (both) {
            M.members.get(l.owner).balance += o.amount;
            M.escrowHeld -= o.amount;
            model.status = 'completed';
            l.status = 'completed';
          }
        };
      },
    },
    {
      name: 'withdraw-listing', weight: 6,
      gen() {
        const ls = activeListings();
        if (!ls.length) return null;
        const l = pick(ls);
        return async () => {
          const r = await H(l.owner).post(`/api/listings/${l.id}/withdraw`);
          if (r.status !== 200) return note('response', `withdraw got ${r.status}`);
          M.listings.get(l.id).status = 'withdrawn';
        };
      },
    },
  ];
  const weighted = opKinds.flatMap((k) => Array(k.weight).fill(k));

  // --- main randomized sequence
  let executed = 0;
  let dsRounds = 0;
  const dsResults = [];
  while (executed < ops) {
    const kind = pick(weighted);
    const exec = kind.gen();
    if (!exec) continue;
    await exec();
    executed++;
    const cp = await checkpoint(`op ${executed} (${kind.name})`);
    // Model-vs-server aggregate escrow: exact when nothing else is active.
    if (cp && cp.escrow_held !== (base.escrow_held || 0) + M.escrowHeld) {
      note('model', `escrow held ${cp.escrow_held} != baseline ${base.escrow_held} + model ${M.escrowHeld}`);
    }
    if (executed % 10 === 0) await audit();
    if (executed % 20 === 0) console.log(`  … ${executed}/${ops} ops, ${checkpoints} checkpoints clean so far`);

    // --- concurrent double-spend round every ~30 ops
    if (executed % 30 === 0) {
      dsRounds++;
      const r = dsRounds;
      const buyer = await client.login(`${runId}-ds${r}-buyer`);
      M.seededByUs += 1000;
      const owners = [];
      const offerIds = [];
      const amount = 600; // two of these (1200) overdraw the fresh 1000 balance
      for (let i = 0; i < 3; i++) {
        const owner = await client.login(`${runId}-ds${r}-owner${i}`);
        M.seededByUs += 1000;
        owners.push(owner);
        const lr = await owner.post('/api/listings', {
          title: `DS round ${r} item ${i} ${runId}`,
          description: 'Concurrent double-spend target.',
          category: 'other',
          price_credits: 800,
        });
        const or = await buyer.post(`/api/listings/${lr.data.listing.id}/offers`, { amount });
        offerIds.push({ offer: or.data.offer.id, listing: lr.data.listing.id, owner });
      }
      // Fire all three acceptances at once: in-flight concurrently.
      const results = await Promise.all(
        offerIds.map(({ offer, owner }) => owner.post(`/api/offers/${offer}/accept`))
      );
      const okCount = results.filter((r2) => r2.status === 200).length;
      const rejected = results.filter((r2) => r2.status === 409).length;
      const me = await buyer.get('/api/me');
      const balance = me.data.member.balance;
      dsResults.push({
        round: r,
        okCount,
        rejected,
        balance,
        pass: okCount === 1 && rejected === 2 && balance === 1000 - amount,
      });
      const cp2 = await checkpoint(`double-spend round ${r}`);
      // Fold the surviving reservation into the model, then unwind it.
      M.escrowHeld += amount;
      const winner = offerIds[results.findIndex((r2) => r2.status === 200)];
      if (winner) {
        await buyer.post(`/api/offers/${winner.offer}/cancel`);
        M.escrowHeld -= amount;
        await checkpoint(`double-spend round ${r} unwound`);
      }
      // Track these members so final audits stay exact, and tidy the listings.
      M.members.set(buyer.id, { handle: buyer, balance: 1000 });
      for (const o of owners) M.members.set(o.id, { handle: o, balance: 1000 });
      for (const { listing, owner } of offerIds) {
        await owner.post(`/api/listings/${listing}/withdraw`);
      }
    }
  }

  await audit();
  const final = await checkpoint('final');

  // --- summary checks (per-property, over the whole sequence)
  c.add(
    `zero-sum invariant held at all ${checkpoints} checkpoints`,
    violations.zeroSum === 0,
    `${violations.zeroSum} violations`
  );
  c.add(
    'no negative balance at any checkpoint',
    violations.negative === 0,
    `${violations.negative} violations`
  );
  c.add(
    `escrow lifecycle: all ${executed} randomized operations matched the model's expected transitions`,
    violations.response === 0 && violations.model === 0,
    `${violations.response} response + ${violations.model} model violations`
  );
  c.add(
    'per-member balances matched the shadow model at every audit',
    violations.audit === 0,
    `${violations.audit} mismatches`
  );
  for (const d of dsResults) {
    c.add(
      `concurrent double-spend round ${d.round}: only covered acceptances succeeded (${d.okCount} ok, ${d.rejected} refused, balance ${d.balance})`,
      d.pass,
      JSON.stringify(d)
    );
  }
  c.add(
    'final checkpoint zero-sum',
    !!final && final.zero_sum === true,
    JSON.stringify(final)
  );

  // Cleanup: withdraw any still-active runner listings to keep prod tidy.
  for (const [id, l] of M.listings) {
    if (l.status === 'active') await H(l.owner).post(`/api/listings/${id}/withdraw`);
  }

  return c.results;
}

module.exports = { run };
