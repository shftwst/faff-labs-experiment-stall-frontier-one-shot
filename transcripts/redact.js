const fs = require('fs');
const [src, dst] = process.argv.slice(2);
let text = fs.readFileSync(src, 'utf8');

// Named secrets: every value from .env.claude-box plus locally-generated ones.
const envFile = fs.readFileSync('.env.claude-box', 'utf8');
const named = [];
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
  if (!m || m[1].startsWith('#')) continue;
  let v = m[2].trim().replace(/^['"]|['"]$/g, '');
  if (v && v.length >= 8 && !v.startsWith('(')) named.push([m[1], v]);
}
const hs = fs.existsSync(process.env.HSFILE) ? fs.readFileSync(process.env.HSFILE, 'utf8').trim() : null;
if (hs) named.push(['HARNESS_SECRET', hs]);
let count = 0;
for (const [name, v] of named) {
  const before = text.length;
  text = text.split(v).join(`[REDACTED:${name}]`);
  // Values can appear JSON-escaped (quotes) — also try the JSON-encoded form.
  const jsonV = JSON.stringify(v).slice(1, -1);
  if (jsonV !== v) text = text.split(jsonV).join(`[REDACTED:${name}]`);
  if (text.length !== before) count++;
}
// Common token shapes as a safety net.
const shapes = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'GITHUB_TOKEN'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'GITHUB_PAT'],
  [/nfp_[A-Za-z0-9]{20,}/g, 'NETLIFY_TOKEN'],
  [/nvapi-[A-Za-z0-9_-]{20,}/g, 'NVIDIA_KEY'],
  [/AIza[0-9A-Za-z_-]{35}/g, 'GOOGLE_KEY'],
  [/cfat_[A-Za-z0-9]{20,}/g, 'CLOUDFLARE_TOKEN'],
  [/FlyV1\s+fm2_[A-Za-z0-9+/=,._-]+/g, 'FLY_TOKEN'],
  [/fm2_[A-Za-z0-9+/=,._-]{40,}/g, 'FLY_TOKEN'],
  [/sk-[A-Za-z0-9_-]{20,}/g, 'API_KEY'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'SLACK_TOKEN'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'JWT'],
];
for (const [re, label] of shapes) text = text.replace(re, `[REDACTED:${label}]`);
fs.writeFileSync(dst, text);
console.log(`redacted ${named.length} named values (${count} present), wrote ${dst} (${text.length} bytes)`);
