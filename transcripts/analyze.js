const fs = require('fs');
const path = process.argv[2];
const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const totals = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
let turns = 0, assistantMsgs = 0, firstTs = null, lastTs = null, models = new Set(), versions = new Set();

// Phase boundaries (UTC), labelled from observed activity.
const phases = [
  { name: 'brief + environment survey', until: '2026-07-20T13:52:30Z' },
  { name: 'v0.1.0 build (auth, listings, photos, harness v1, infra)', until: '2026-07-20T14:00:40Z' },
  { name: 'v0.1.0 deploy, tag, release log', until: '2026-07-20T14:04:30Z' },
  { name: 'v0.2.0 build+ship (search, messaging)', until: '2026-07-20T14:08:30Z' },
  { name: 'v0.3.0 build+ship (ledger, offers, escrow, property runner)', until: '2026-07-20T14:17:30Z' },
  { name: 'v0.4.0 build+ship (reviews)', until: '2026-07-20T14:25:30Z' },
  { name: 'final verification (tag spot-check, prod harness)', until: '2026-07-20T14:33:00Z' },
  { name: 'bookkeeping (economics/transcripts; partially self-excluded)', until: '2099-01-01T00:00:00Z' },
];
const phaseAgg = phases.map((p) => ({ name: p.name, ...Object.fromEntries(Object.keys(totals).map((k) => [k, 0])), turns: 0, first: null, last: null }));
const phaseFor = (ts) => phases.findIndex((p) => ts < p.until);

const toolAgg = {}; // name -> {calls, resultChars}
const pendingTool = {}; // tool_use id -> name

for (const e of lines) {
  const ts = e.timestamp || (e.snapshot && e.snapshot.timestamp);
  if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
  if (e.type === 'assistant' && e.message) {
    assistantMsgs++;
    if (e.message.model) models.add(e.message.model);
    const u = e.message.usage;
    if (u && ts) {
      const pi = phaseFor(ts); const pa = phaseAgg[pi];
      for (const k of Object.keys(totals)) { totals[k] += u[k] || 0; pa[k] += u[k] || 0; }
      pa.turns++; if (!pa.first) pa.first = ts; pa.last = ts;
    }
    for (const c of e.message.content || []) {
      if (c.type === 'tool_use') {
        pendingTool[c.id] = c.name;
        toolAgg[c.name] = toolAgg[c.name] || { calls: 0, resultChars: 0 };
        toolAgg[c.name].calls++;
      }
    }
  }
  if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
    for (const c of e.message.content) {
      if (c.type === 'tool_result') {
        const name = pendingTool[c.tool_use_id] || 'unknown';
        const size = JSON.stringify(c.content || '').length;
        toolAgg[name] = toolAgg[name] || { calls: 0, resultChars: 0 };
        toolAgg[name].resultChars += size;
      }
    }
  }
  if (e.type === 'user' && e.message && typeof e.message.content === 'string') turns++;
  if (e.version) versions.add(e.version);
}

console.log(JSON.stringify({ totals, assistantMsgs, userTurns: turns, firstTs, lastTs, models: [...models], versions: [...versions],
  phases: phaseAgg.map((p) => ({ ...p })), tools: Object.fromEntries(Object.entries(toolAgg).sort((a, b) => b[1].resultChars - a[1].resultChars)) }, null, 2));
