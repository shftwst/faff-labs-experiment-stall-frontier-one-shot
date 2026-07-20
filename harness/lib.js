'use strict';

// Shared harness client. Talks to a running stall instance over plain HTTP —
// the same public API members use — authenticating as real, distinct members
// via the secret-gated harness login.

class Client {
  constructor(baseUrl, harnessSecret) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.harnessSecret = harnessSecret;
  }

  async login(name) {
    const r = await fetch(`${this.baseUrl}/api/harness/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.harnessSecret}`,
      },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(`harness login failed for ${name}: ${r.status} ${await r.text()}`);
    const d = await r.json();
    return new Member(this, d.token, d.member);
  }

  async raw(method, path, { token, body, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined && !(body instanceof FormData)) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    } else {
      payload = body;
    }
    const r = await fetch(`${this.baseUrl}${path}`, { method, headers: h, body: payload });
    let data = null;
    const text = await r.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = { _raw: text };
    }
    return { status: r.status, data };
  }
}

class Member {
  constructor(client, token, info) {
    this.client = client;
    this.token = token;
    this.info = info;
  }
  get id() {
    return this.info.id;
  }
  req(method, path, body) {
    return this.client.raw(method, path, { token: this.token, body });
  }
  get(path) {
    return this.req('GET', path);
  }
  post(path, body) {
    return this.req('POST', path, body ?? {});
  }
}

// Check collector: every probe pushes named pass/fail checks here.
class Checks {
  constructor(section) {
    this.section = section;
    this.results = [];
  }
  add(name, pass, detail = '') {
    this.results.push({ section: this.section, name, pass: !!pass, detail: String(detail) });
    const mark = pass ? '✓' : '✗';
    console.log(`  ${mark} ${name}${pass ? '' : `  — ${detail}`}`);
    return !!pass;
  }
  expect(name, actual, expected, detail = '') {
    return this.add(name, actual === expected, `${detail} (expected ${expected}, got ${actual})`);
  }
}

module.exports = { Client, Checks };
