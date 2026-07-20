'use strict';

const config = require('./config');

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function timeAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const CSS = `
:root{--bg:#f6f4ef;--card:#fff;--ink:#26221c;--muted:#7a7265;--accent:#b4552d;--accent2:#3d6b50;--line:#e4ded2;--radius:10px}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--ink);line-height:1.5}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--ink);color:#f6f4ef;padding:0 20px}
.nav{max-width:1000px;margin:0 auto;display:flex;align-items:center;gap:18px;height:56px}
.nav .brand{font-weight:800;font-size:20px;color:#f6f4ef;letter-spacing:.5px}
.nav .brand span{color:#e8a87c}.nav a{color:#d8d2c6}.nav .spacer{flex:1}
.nav .btn{background:var(--accent);color:#fff;padding:7px 14px;border-radius:8px;font-weight:600}
main{max-width:1000px;margin:24px auto;padding:0 20px}
h1{font-size:26px;margin:0 0 14px}h2{font-size:19px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:18px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column}
.tile .ph{aspect-ratio:4/3;background:#eae5da;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:34px;overflow:hidden}
.tile .ph img{width:100%;height:100%;object-fit:cover}
.tile .body{padding:10px 12px 12px}.tile .t{font-weight:600;margin:0 0 2px}.tile .m{color:var(--muted);font-size:13px}
.price{color:var(--accent2);font-weight:700}
.badge{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:2px 8px;border-radius:99px;background:#eee4d6;color:#7a6a4f}
.badge.reserved{background:#f3e2cf;color:#a06414}.badge.completed{background:#dcebe1;color:#2f6647}.badge.withdrawn{background:#eee;color:#888}
form label{display:block;font-weight:600;font-size:14px;margin:12px 0 4px}
input[type=text],input[type=number],textarea,select{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font:inherit;background:#fff}
textarea{min-height:120px}
button,.btn{background:var(--accent);color:#fff;border:0;padding:9px 16px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer}
button.secondary,.btn.secondary{background:#fff;color:var(--ink);border:1px solid var(--line)}
button.danger{background:#a33}
.muted{color:var(--muted)}.small{font-size:13px}
.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin-bottom:18px}
.filters .f{flex:1;min-width:120px}.filters .fq{flex:3;min-width:220px}
.photos{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}
.photos img{width:180px;height:135px;object-fit:cover;border-radius:8px;border:1px solid var(--line)}
.flash{background:#eef6ee;border:1px solid #cde3cd;padding:10px 14px;border-radius:8px;margin-bottom:14px}
.flash.err{background:#fbeeee;border-color:#e3cccc}
.avatar{width:36px;height:36px;border-radius:50%;vertical-align:middle}
.row{display:flex;gap:14px;align-items:center}
.msg{padding:8px 12px;border-radius:10px;margin:6px 0;max-width:75%}
.msg.mine{background:#e5efe8;margin-left:auto}.msg.theirs{background:#f0ebe0}
.msg .who{font-size:12px;color:var(--muted)}
.stars{color:#c9910c;letter-spacing:2px}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);font-size:14px}
code{background:#eee7da;padding:1px 5px;border-radius:4px}
.usercode{font-size:30px;font-weight:800;letter-spacing:6px;background:#eee7da;padding:10px 18px;border-radius:10px;display:inline-block}
footer{max-width:1000px;margin:30px auto;padding:0 20px 30px;color:var(--muted);font-size:13px}
`;

function layout({ title, member, body, flash }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · stall</title><style>${CSS}</style></head>
<body>
<header><nav class="nav">
  <a class="brand" href="/">st<span>all</span></a>
  <a href="/">browse</a>
  ${member ? `<a href="/sell">sell</a><a href="/me">my stall</a>` : ''}
  <span class="spacer"></span>
  ${
    member
      ? `<span class="row"><a href="/profile/${member.id}">${esc(member.display_name)}</a>
         <form method="post" action="/logout" style="margin:0"><button class="secondary" style="padding:5px 10px">sign out</button></form></span>`
      : `<a class="btn" href="/login">Sign in with GitHub</a>`
  }
</nav></header>
<main>${flash ? `<div class="flash ${flash.kind === 'err' ? 'err' : ''}">${esc(flash.text)}</div>` : ''}
${body}</main>
<footer>stall — a community marketplace. Trades settle in platform credits (integer, escrowed); every member starts with ${config.seedCredits} credits. Listings allow up to ${config.maxPhotosPerListing} photos (${Math.round(config.maxPhotoBytes / 1024 / 1024)}MB each). Listings reported by ${config.reportHideThreshold} distinct members are hidden.</footer>
</body></html>`;
}

module.exports = { esc, timeAgo, layout };
