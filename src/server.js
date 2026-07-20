'use strict';

const express = require('express');
const config = require('./config');
const { db } = require('./db');
const auth = require('./auth');
const listings = require('./listings');
const pages = require('./pages');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(auth.sessionMiddleware);

app.get('/healthz', (req, res) => res.json({ ok: true, version: require('../package.json').version }));

// Capability flags: which slices of the product this build ships. The harness
// reads these to know which probes apply.
app.get('/api/features', (req, res) =>
  res.json({ listings: true, search: false, messaging: false, offers: false, reviews: false })
);

app.use(auth.router);
app.use(listings.router);
app.use(pages.router);

app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    return res.status(400).json({ error: `upload rejected: ${err.code}` });
  }
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`stall listening on :${config.port} (db: ${config.databasePath})`);
  });
}

module.exports = { app };
