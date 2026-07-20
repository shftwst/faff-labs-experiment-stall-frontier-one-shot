'use strict';

const path = require('path');

const env = process.env;

module.exports = {
  port: parseInt(env.PORT || '3000', 10),
  baseUrl: env.BASE_URL || `http://localhost:${env.PORT || 3000}`,
  databasePath: env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'stall.db'),
  sessionSecret: env.SESSION_SECRET || 'dev-only-session-secret',
  // Harness auth is only enabled when a secret is explicitly configured.
  harnessSecret: env.HARNESS_SECRET || null,
  github: {
    // Device-flow OAuth client. Defaults to the public GitHub CLI client id;
    // swap in a dedicated OAuth app via env without code changes.
    clientId: env.GITHUB_CLIENT_ID || '178c6fc778ccc68e1d6a',
  },
  r2: env.CLOUDFLARE_R2_CLIENT_API
    ? {
        endpoint: env.CLOUDFLARE_R2_CLIENT_API,
        bucket: env.CLOUDFLARE_R2_BUCKET_NAME,
        accessKeyId: env.CLOUDFLARE_R2_CLIENT_ACCESS_KEY_ID,
        secretAccessKey: env.CLOUDFLARE_R2_CLIENT_ACCESS_KEY_SECRET,
        keyPrefix: env.R2_KEY_PREFIX || 'stall/photos',
      }
    : null,
  // Product constants — stated here and in the README/UI per the PRD.
  maxPhotosPerListing: 4,
  maxPhotoBytes: 5 * 1024 * 1024,
  reportHideThreshold: 3,
  seedCredits: 1000,
  categories: [
    'electronics',
    'furniture',
    'clothing',
    'books',
    'toys-games',
    'sports',
    'garden',
    'other',
  ],
};
