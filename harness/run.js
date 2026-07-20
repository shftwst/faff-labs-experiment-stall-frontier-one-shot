'use strict';

// Harness runner.
//
//   node harness/run.js --local                 boot a throwaway local instance and probe it
//   node harness/run.js --url https://… --secret …   probe a deployed instance
//   options: --seed N (ledger runner seed), --ops N (ledger ops), --only authz|ledger
//
// Prints per-check results and exits non-zero if any check fails.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('./lib');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  const local = !!arg('local', false);
  let url = arg('url', process.env.STALL_URL);
  let secret = arg('secret', process.env.HARNESS_SECRET);
  const seed = parseInt(arg('seed', `${(Date.now() % 100000) | 0}`), 10);
  const only = arg('only', null);
  let child = null;

  if (local) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-harness-'));
    const port = 3777;
    secret = 'local-harness-secret';
    url = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_PATH: path.join(dir, 'stall.db'),
        HARNESS_SECRET: secret,
        SESSION_SECRET: 'local-test',
        BASE_URL: url,
        // Local harness runs never touch R2: photos go to local disk.
        CLOUDFLARE_R2_CLIENT_API: '',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (!(await waitFor(`${url}/healthz`, 15000))) {
      console.error('local server failed to start');
      child.kill();
      process.exit(2);
    }
  }

  if (!url || !secret) {
    console.error('need --url and --secret (or --local)');
    process.exit(2);
  }

  const client = new Client(url, secret);
  const runId = `r${Date.now().toString(36)}`;
  console.log(`stall harness → ${url}  (run ${runId}, seed ${seed})`);

  const results = [];
  try {
    if (!only || only === 'authz') {
      results.push(...(await require('./authz-probe').run(client, runId)));
    }
    const feat = await client.raw('GET', '/api/features');
    if ((!only || only === 'search') && feat.status === 200 && feat.data.search) {
      results.push(...(await require('./search-probe').run(client, runId)));
    }
    if ((!only || only === 'ledger') && feat.status === 200 && feat.data.offers) {
      results.push(...(await require('./ledger-runner').run(client, runId, {
        seed,
        ops: parseInt(arg('ops', '120'), 10),
        // A throwaway --local instance is ours alone; a deployed instance may
        // have concurrent members or harness runs, so strict aggregate
        // equality checks are opt-in there via --exclusive.
        exclusive: local || !!arg('exclusive', false),
      })));
    }
    if ((!only || only === 'reviews') && feat.status === 200 && feat.data.reviews) {
      results.push(...(await require('./reviews-probe').run(client, runId)));
    }
  } catch (e) {
    console.error('\nharness aborted:', e.message);
    results.push({ section: 'harness', name: 'run completed', pass: false, detail: e.message });
  } finally {
    if (child) child.kill();
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n== Harness summary: ${passed}/${results.length} checks passed ==`);
  for (const r of results.filter((r) => !r.pass)) {
    console.log(`  FAIL [${r.section}] ${r.name} — ${r.detail}`);
  }
  process.exit(failed ? 1 : 0);
}

main();
