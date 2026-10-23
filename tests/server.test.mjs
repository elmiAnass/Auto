import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createApp, readConfig } from '../server/server.mjs';

const HEADER = ['Publication', 'Page Canva', 'Photo', 'Caption', 'Hashtags'];
const clone = value => structuredClone(value);

function png(width, height, color = [180, 20, 20]) {
  function chunk(kind, content) {
    const type = Buffer.from(kind), head = Buffer.alloc(4), end = Buffer.alloc(4);
    head.writeUInt32BE(content.length);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, content])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    end.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, type, content, end]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.set(color, y * (width * 3 + 1) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function unzipStored(input) {
  const bytes = Buffer.from(input), entries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength);
    const begin = offset + 30 + nameLength + extra;
    entries.set(name, bytes.subarray(begin, begin + size));
    offset = begin + size;
  }
  return entries;
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

// Persistence belongs to the fake Google account, independently of the app/session.
function googleAccount() {
  return { sequence: 0, files: new Map(), sheets: new Map(), id(prefix) { return prefix + '_' + String(++this.sequence).padStart(5, '0'); } };
}

async function fixture(t, options = {}) {
  let clock = options.clock ?? 1_800_000_000_000;
  const account = options.account || googleAccount();
  const calls = { oauth: [], exchanges: [], refresh: [], resolve: [], exports: [], downloads: [], folders: [], images: [], reads: [], sheets: [], metadata: [], documents: [], deletes: [], exists: [] };
  const images = options.images || [png(1, 2), png(2, 3, [20, 180, 20]), png(3, 4, [20, 20, 180])];
  const config = {
    publicOrigin: 'http://127.0.0.1:3000', canvaClientId: 'canva-client', canvaClientSecret: 'canva-secret',
    googleClientId: 'google-client', googleClientSecret: 'google-secret', ...(options.config || {}),
  };
  const providers = {
    validateCanvaUrl(value) {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !['www.canva.com', 'canva.link'].includes(url.hostname) || url.username || url.password) throw new Error('Invalid Canva URL.');
      return url;
    },
    oauthAuthorizationUrl(provider, _config, values) {
      calls.oauth.push({ provider, ...values });
      return 'https://consent.example.invalid/' + provider + '?' + new URLSearchParams(values);
    },
    async exchangeOAuthCode(provider, _config, values) {
      assert.ok(values.codeVerifier.length >= 43);
      calls.exchanges.push({ provider, ...values });
      return { accessToken: provider + '-token', refreshToken: provider + '-refresh', expiresAt: clock + (options.expiredTokens ? 1 : 3600000) };
    },
    async refreshOAuthToken(provider) {
      calls.refresh.push(provider);
      return { accessToken: provider + '-refreshed', expiresAt: clock + 3600000 };
    },
    async resolveCanvaDesign(value) { calls.resolve.push(value); return { designId: 'DAG_test', url: value }; },
    async exportCanvaPages(id, access, values = {}) {
      calls.exports.push({ id, access });
      await options.beforeCanvaExport?.();
      values.onProgress?.({ status: 'success' });
      return images.map((_, index) => 'https://export-download.canva.com/page' + index + '.png');
    },
    async createGoogleDocument(bytes, access, values) {
      await options.beforeDocument?.();
      const id = account.id('document');
      const document = { id, bytes: Buffer.from(bytes), access, title: values.title, trashed: false, manualEdits: '' };
      calls.documents.push(document); account.files.set(id, document);
      return { id, url: 'https://docs.google.com/document/d/' + id + '/edit' };
    },
    ...(options.providers || {}),
  };
  const workflowProviders = {
    async createDriveFolder(title, access) {
      const id = account.id('folder'); calls.folders.push({ id, title, access });
      account.files.set(id, { id, kind: 'folder', trashed: false }); return id;
    },
    async uploadDriveImage(image, folderId, access) {
      const id = account.id('image');
      const file = { ...image, id, bytes: Buffer.from(image.bytes), folderId, access, trashed: false };
      calls.images.push(file); account.files.set(id, file); return id;
    },
    async readDriveImage(id, access) {
      calls.reads.push({ id, access }); const file = account.files.get(id);
      if (!file || file.trashed) throw new Error('Saved photo unavailable.');
      return { bytes: new Uint8Array(file.bytes), mime: file.mime };
    },
    async deleteDriveFile(id, access) {
      calls.deletes.push({ id, access }); const file = account.files.get(id);
      if (file) file.trashed = true;
      for (const child of account.files.values()) if (child.folderId === id) child.trashed = true;
    },
    async googleFileExists(id, access) {
      calls.exists.push({ id, access }); return Boolean(account.files.has(id) && !account.files.get(id).trashed);
    },
    async createPlanningSheet(values, access) {
      await options.beforeSheet?.();
      const id = account.id('sheet');
      const sheet = { id, title: values.title, folderId: values.folderId, metadataRows: clone(values.metadataRows),
        rows: [HEADER.slice(), ...values.rows.map(row => [row.publication, row.sourceIndex, 'Photo ' + String(row.sourceIndex).padStart(2, '0'), row.caption, row.hashtags])] };
      calls.sheets.push({ id, ...clone(values), access }); account.sheets.set(id, sheet);
      account.files.set(id, { id, folderId: values.folderId, trashed: false });
      return { id, url: 'https://docs.google.com/spreadsheets/d/' + id + '/edit' };
    },
    async readPlanningSheet(id, access) {
      await options.beforeReadSheet?.();
      const sheet = account.sheets.get(id);
      if (!sheet || account.files.get(id)?.trashed) throw new Error('Planning sheet unavailable.');
      return clone(sheet);
    },
    async updatePlanningMetadata(id, rows, access) {
      await options.beforeMetadata?.();
      calls.metadata.push({ id, rows: clone(rows), access }); account.sheets.get(id).metadataRows = clone(rows);
    },
    ...(options.workflowProviders || {}),
  };
  const fetchImpl = async (url, init = {}) => {
    calls.downloads.push({ url: String(url), init });
    if (options.fetchImpl) return options.fetchImpl(url, init);
    assert.match(String(url), /^https:\/\/export-download\.canva\.com\/page\d+\.png$/);
    const index = Number(String(url).match(/page(\d+)\.png/)[1]);
    return new Response(images[index], { status: 200, headers: { 'Content-Type': 'image/png' } });
  };
  const app = createApp({ config, providers, workflowProviders, fetchImpl, now: () => clock });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port;
  config.publicOrigin = options.publicOrigin || base;
  let stopped = false;
  const state = { app, base, config, providers, workflowProviders, calls, account, images, cookie: '', csrf: '', advance: ms => { clock += ms; },
    close: async () => { if (!stopped) { stopped = true; await app.close(); } } };
  t.after(state.close);
  state.request = (pathname, init = {}, cookie = state.cookie) => fetch(base + pathname, {
    redirect: 'manual', ...init, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) },
  });
  state.session = async (cookie = state.cookie) => {
    const response = await state.request('/api/session', {}, cookie);
    assert.equal(response.status, 200);
    state.cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
    const value = await response.json(); state.csrf = value.csrfToken; return value;
  };
  state.connect = async provider => {
    const start = await state.request('/oauth/start/' + provider); assert.equal(start.status, 302);
    const issued = calls.oauth.at(-1);
    const response = await state.request('/oauth/callback/' + provider + '?' + new URLSearchParams({ state: issued.state, code: 'mock-code' }));
    assert.equal(response.status, 302); return issued;
  };
  state.post = (pathname, body = {}, headers = {}) => state.request(pathname, {
    method: 'POST', headers: { Origin: config.publicOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf, ...headers }, body: JSON.stringify(body),
  });
  state.waitJob = async id => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await state.request('/api/jobs/' + id); assert.equal(response.status, 200);
      const value = await response.json(); if (value.status !== 'running') return value;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Workflow job did not finish.');
  };
  state.startImport = async (orderMode = 'GRID') => {
    const response = await state.post('/api/import', { url: 'https://canva.link/example', orderMode, title: 'Test & Feed' });
    assert.equal(response.status, 202, await response.clone().text()); return (await response.json()).jobId;
  };
  state.readyImport = async (orderMode = 'GRID') => {
    await state.connect('canva'); await state.connect('google');
    const job = await state.waitJob(await state.startImport(orderMode)); assert.equal(job.status, 'ready', job.error); return job;
  };
  state.resume = async sheetUrl => {
    const response = await state.post('/api/resume', { sheetUrl });
    assert.equal(response.status, 202, await response.clone().text()); return state.waitJob((await response.json()).jobId);
  };
  state.export = async job => {
    const response = await state.post('/api/jobs/' + job.id + '/export');
    assert.equal(response.status, 202, await response.clone().text());
    const value = await response.json(); assert.equal(value.jobId, job.id); return state.waitJob(value.jobId);
  };
  state.sheet = job => account.sheets.get(job.sheet.id);
  state.fill = (job, prefix = 'Caption for source ') => {
    for (const row of state.sheet(job).rows.slice(1)) { row[3] = prefix + row[1]; row[4] = '#Source' + row[1]; }
  };
  await state.session(); return state;
}

function assertDocx(document, images, sourceOrder, captionPrefix = 'Caption for source ') {
  const entries = unzipStored(document.bytes), xml = entries.get('word/document.xml')?.toString();
  assert.ok(xml, 'The uploaded document must be a complete DOCX.');
  const sections = xml.split(/POST \d{2}/).slice(1);
  assert.equal(sections.length, sourceOrder.length);
  sourceOrder.forEach((source, index) => {
    assert.deepEqual(entries.get('word/media/image' + (index + 1) + '.png'), images[source - 1]);
    assert.ok(sections[index].includes(captionPrefix + source), 'Caption must accompany its original image.');
    assert.ok(sections[index].includes('#Source' + source), 'Hashtags must accompany their original image.');
  });
}

test('configuration validates origins and preserves local, Render and Codespaces precedence', () => {
  assert.equal(readConfig({}).publicOrigin, 'http://127.0.0.1:3000');
  const codespace = { CODESPACE_NAME: 'test-workspace-abc123' };
  assert.equal(readConfig(codespace).publicOrigin, 'https://test-workspace-abc123-3000.app.github.dev');
  assert.equal(readConfig({ ...codespace, PORT: '4000', FEED_STUDIO_PORT: '4173', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'preview.example.com' }).publicOrigin,
    'https://test-workspace-abc123-4173.preview.example.com');
  assert.equal(readConfig({ ...codespace, RENDER_EXTERNAL_URL: 'https://studio.onrender.com', PORT: '10000' }).publicOrigin, 'https://studio.onrender.com');
  assert.equal(readConfig({ CODESPACE_NAME: '../bad', PUBLIC_ORIGIN: 'https://studio.example.com/', RENDER_EXTERNAL_URL: 'https://studio.onrender.com' }).publicOrigin, 'https://studio.example.com');
  assert.equal(readConfig({ PORT: '10000', FEED_STUDIO_HOST: '0.0.0.0' }).host, '0.0.0.0');
  for (const value of ['http://public.example.com', 'https://user:password@example.com', 'https://example.com/path', 'javascript:alert(1)']) {
    assert.throws(() => readConfig({ PUBLIC_ORIGIN: value }), /PUBLIC_ORIGIN/);
  }
  for (const name of ['../workspace', 'workspace/path', 'workspace@evil.invalid', 'workspace:3000', 'workspace_name', '-workspace', 'workspace-', 'a'.repeat(64)]) {
    assert.throws(() => readConfig({ CODESPACE_NAME: name }), /Codespaces/);
  }
  for (const domain of ['https://app.github.dev', 'app.github.dev/path', 'user@app.github.dev', 'app.github.dev:443', '.app.github.dev', 'app..github.dev', '-app.github.dev', 'app_.github.dev']) {
    assert.throws(() => readConfig({ ...codespace, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: domain }), /Codespaces/);
  }
  assert.ok(!Object.keys(readConfig({ OPENAI_API_KEY: 'unused-test-key', OPENAI_MODEL: 'unused-model' })).some(key => /openai/i.test(key)));
});

test('health, session and served application expose only the two OAuth providers', async t => {
  const state = await fixture(t, { config: { canvaClientId: '', googleClientSecret: '' } });
  assert.deepEqual(await (await state.request('/healthz')).json(), { ok: true });
  const session = await state.session();
  assert.deepEqual(session.configured, { canva: false, google: false });
  assert.deepEqual(session.connected, { canva: false, google: false });
  assert.ok(!JSON.stringify(session).includes('secret'));
  const html = await (await state.request('/')).text();
  assert.match(html, /name="feed-studio-mode" content="server"/);
  assert.doesNotMatch(html, /OPENAI_API_KEY|openaiApiKey|generate-caption/i);
  assert.equal((await state.request('/oauth/start/canva')).status, 503);
});

test('OAuth enforces PKCE, browser-bound one-use state and HTTPS cookie protection', async t => {
  const state = await fixture(t, { publicOrigin: 'https://studio.example.com' });
  const fresh = await state.request('/api/session', {}, ''), cookie = fresh.headers.get('set-cookie');
  for (const attribute of [/HttpOnly/, /SameSite=Lax/, /Path=\//, /Secure/]) assert.match(cookie, attribute);
  assert.ok(!cookie.includes('token'));
  await state.request('/oauth/start/canva'); const issued = state.calls.oauth.at(-1);
  assert.ok(issued.state.length > 30); assert.match(issued.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  const callback = '/oauth/callback/canva?' + new URLSearchParams({ state: issued.state, code: 'mock-code' });
  assert.equal((await state.request(callback, {}, cookie.split(';')[0])).status, 400);
  const accepted = await state.request(callback); assert.equal(accepted.status, 302);
  assert.equal(accepted.headers.get('location'), '/?connected=canva');
  assert.equal((await state.request(callback)).status, 400);
  const session = await state.session(); assert.equal(session.connected.canva, true);
  assert.ok(!JSON.stringify(session).includes('canva-token'));
});

test('OAuth rejections and missing codes are sanitized and consume their state', async t => {
  const state = await fixture(t);
  for (const provider of ['canva', 'google']) {
    await state.request('/oauth/start/' + provider); const issued = state.calls.oauth.at(-1);
    const path = '/oauth/callback/' + provider + '?' + new URLSearchParams({ state: issued.state, error: 'invalid_scope', error_description: 'private-provider-detail', code: 'private-code' });
    const response = await state.request(path), raw = await response.text(); assert.equal(response.status, 400);
    assert.match(JSON.parse(raw).error, provider === 'canva' ? /design:content:read/ : /drive\.file/);
    for (const hidden of [issued.state, 'private-provider-detail', 'private-code']) assert.ok(!raw.includes(hidden));
    assert.equal((await state.request(path)).status, 400);
    assert.equal((await state.session()).connected[provider], false);
  }
  await state.request('/oauth/start/canva'); const issued = state.calls.oauth.at(-1);
  const response = await state.request('/oauth/callback/canva?' + new URLSearchParams({ state: issued.state }));
  assert.equal(response.status, 400); assert.match((await response.json()).error, /sans code d’autorisation/);
  assert.equal(state.calls.exchanges.length, 0);
});

test('OAuth state and browser session expiry prevent later access', async t => {
  const state = await fixture(t); await state.request('/oauth/start/canva');
  const issued = state.calls.oauth.at(-1); state.advance(11 * 60 * 1000);
  assert.equal((await state.request('/oauth/callback/canva?' + new URLSearchParams({ state: issued.state, code: 'expired' }))).status, 400);
  state.advance(3 * 60 * 60 * 1000);
  assert.equal((await state.request('/api/jobs/anything')).status, 401);
});

test('mutations enforce Origin and CSRF before provider work, including proxy spoofing', async t => {
  const state = await fixture(t); await state.connect('canva'); await state.connect('google');
  state.config.publicOrigin = readConfig({ CODESPACE_NAME: 'test-workspace-abc123' }).publicOrigin;
  const expected = state.config.publicOrigin, body = { url: 'https://canva.link/example', orderMode: 'GRID' };
  assert.equal((await state.session()).publicOrigin, expected);
  const malformed = ['https://sensitive-user:sensitive-password@evil.invalid', 'invalid-sensitive-origin', 'https://evil.invalid/private?token=sensitive-token', 'https://evil.invalid, ' + expected];
  const headers = [
    { Origin: 'https://evil.invalid' }, { Origin: 'null' }, { Origin: expected.replace('https:', 'http:') }, { Origin: expected + ':8443' },
    { Origin: 'https://evil.invalid', Host: 'evil.invalid', 'X-Forwarded-Host': 'evil.invalid', 'X-Forwarded-Proto': 'https', Forwarded: 'host=evil.invalid;proto=https' },
    ...malformed.map(Origin => ({ Origin })),
  ];
  for (const extra of headers) {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(state.base + '/api/import', { method: 'POST', headers: { Cookie: state.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf, ...extra } }, resolve);
      request.on('error', reject); request.end(JSON.stringify(body));
    });
    let raw = ''; for await (const chunk of response) raw += chunk;
    assert.equal(response.statusCode, 403); const error = JSON.parse(raw).error;
    assert.ok(error.includes('Expected ' + expected));
    if (malformed.includes(extra.Origin)) { assert.match(error, /received invalid/); assert.ok(!error.includes('sensitive')); }
  }
  assert.equal((await state.post('/api/import', body, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal(state.calls.resolve.length, 0);
  const response = await state.post('/api/import', body); assert.equal(response.status, 202);
  assert.equal((await state.waitJob((await response.json()).jobId)).status, 'ready');
});

test('imports require both OAuth accounts and validate input before creating files', async t => {
  const state = await fixture(t), body = { url: 'https://canva.link/example', orderMode: 'GRID', title: 'Feed' };
  assert.equal((await state.post('/api/import', body)).status, 401);
  await state.connect('google'); assert.equal((await state.post('/api/import', body)).status, 401);
  await state.connect('canva');
  for (const invalid of [{ ...body, url: 'http://127.0.0.1/private' }, { ...body, orderMode: 'OTHER' }, { ...body, title: 'x'.repeat(201) }]) {
    assert.equal((await state.post('/api/import', invalid)).status, 400);
  }
  const oversized = await state.post('/api/import', { ...body, padding: 'x'.repeat(129 * 1024) }); assert.equal(oversized.status, 413);
  const wrongType = await state.request('/api/import', { method: 'POST', headers: { Origin: state.config.publicOrigin, 'X-CSRF-Token': state.csrf, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415); assert.equal(state.calls.folders.length, 0);
});

test('GRID import saves exact originals privately and creates a blank mapped planning sheet without a Doc', async t => {
  const state = await fixture(t), job = await state.readyImport('GRID');
  assert.equal(job.operation, 'import'); assert.equal(job.title, 'Test & Feed'); assert.equal(job.orderMode, 'GRID');
  assert.deepEqual(job.posts.map(post => [post.sourceIndex, post.publication, post.caption, post.hashtags]), [[1, 3, '', ''], [2, 2, '', ''], [3, 1, '', '']]);
  assert.equal(state.calls.folders.length, 1); assert.equal(state.calls.images.length, 3); assert.equal(state.calls.documents.length, 0);
  assert.equal(job.document, undefined); assert.ok(job.sheet.url.includes(job.sheet.id)); assert.ok(job.folder.url.includes(job.folder.id));
  for (const [index, image] of state.calls.images.entries()) { assert.deepEqual(image.bytes, state.images[index]); assert.equal(image.folderId, job.folder.id); }
  assert.deepEqual(state.calls.sheets[0].rows.map(row => [row.publication, row.sourceIndex, row.caption, row.hashtags]), [[1, 3, '', ''], [2, 2, '', ''], [3, 1, '', '']]);
  assert.equal((await state.session()).latestJobId, job.id);
  const serialized = JSON.stringify(job); for (const value of ['canva-token', 'google-token', 'canva-secret', 'google-secret']) assert.ok(!serialized.includes(value));
  assert.ok(state.calls.downloads.every(call => call.url.startsWith('https://export-download.canva.com/')));
  assert.equal((await state.post('/api/jobs/' + job.id + '/generate-caption', { imageId: job.posts[0].id })).status, 404);
});

test('PUBLICATION import retains page order and refreshes expiring provider credentials', async t => {
  const state = await fixture(t, { expiredTokens: true }), job = await state.readyImport('PUBLICATION');
  assert.deepEqual(job.posts.map(post => [post.sourceIndex, post.publication]), [[1, 1], [2, 2], [3, 3]]);
  assert.deepEqual(state.calls.refresh, ['canva', 'google']); assert.equal(state.calls.exports[0].access, 'canva-refreshed');
  assert.equal(state.calls.images[0].access, 'google-refreshed');
});

test('jobs and private image bytes remain isolated to their browser session', async t => {
  const state = await fixture(t), job = await state.readyImport();
  const image = await state.request('/api/jobs/' + job.id + '/images/' + job.posts[0].id);
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('cache-control'), /private|no-store/); assert.deepEqual(Buffer.from(await image.arrayBuffer()), state.images[0]);
  const other = await state.request('/api/session', {}, ''), cookie = other.headers.get('set-cookie').split(';')[0];
  assert.equal((await state.request('/api/jobs/' + job.id, {}, cookie)).status, 404);
  assert.equal((await state.request('/api/jobs/' + job.id + '/images/' + job.posts[0].id, {}, cookie)).status, 404);
});

test('refresh applies Sheet text to the correct source images after rows are reordered', async t => {
  const state = await fixture(t), job = await state.readyImport(); state.fill(job);
  state.sheet(job).rows.splice(1, 3, ...state.sheet(job).rows.slice(1).reverse());
  const response = await state.post('/api/jobs/' + job.id + '/refresh'); assert.equal(response.status, 200);
  const refreshed = await response.json();
  assert.deepEqual(refreshed.posts.map(post => [post.sourceIndex, post.caption, post.hashtags]), [[1, 'Caption for source 1', '#Source1'], [2, 'Caption for source 2', '#Source2'], [3, 'Caption for source 3', '#Source3']]);
  assert.equal(state.calls.documents.length, 0);
  const goodRows = clone(state.sheet(job).rows);
  for (const change of [rows => { rows[1][3] = 'x'.repeat(901); }, rows => { rows[1][0] = rows[2][0]; }, rows => { rows[1][1] = rows[2][1]; }, rows => { rows[0][0] = 'Changed'; }, rows => { rows.pop(); }, rows => { rows[1][4] = '#one #two #three #four #five #six'; }]) {
    state.sheet(job).rows = clone(goodRows); change(state.sheet(job).rows);
    assert.equal((await state.post('/api/jobs/' + job.id + '/refresh')).status, 400);
    const retained = await state.waitJob(job.id); assert.deepEqual(retained.posts, refreshed.posts);
  }
});

test('GRID export rereads latest Sheet text and pairs it with unchanged PNG bytes in publication order', async t => {
  const state = await fixture(t), job = await state.readyImport('GRID'); state.fill(job);
  state.sheet(job).rows.splice(1, 3, ...state.sheet(job).rows.slice(1).reverse());
  const result = await state.export(job); assert.equal(result.status, 'ready', result.error); assert.equal(result.operation, 'export');
  assert.equal(state.calls.documents.length, 1); assertDocx(state.calls.documents[0], state.images, [3, 2, 1]);
  assert.equal(result.document.id, state.calls.documents[0].id); assert.equal(state.calls.metadata.length, 1);
});

test('PUBLICATION export preserves Canva page order with the matching captions', async t => {
  const state = await fixture(t), job = await state.readyImport('PUBLICATION'); state.fill(job);
  const result = await state.export(job); assert.equal(result.status, 'ready', result.error);
  assertDocx(state.calls.documents[0], state.images, [1, 2, 3]);
});

test('a new server and browser resume persisted photos and Sheet captions with Google alone', async t => {
  const account = googleAccount(), first = await fixture(t, { account }), job = await first.readyImport(); first.fill(job);
  const sheetUrl = job.sheet.url; await first.close();
  const resumed = await fixture(t, { account }); await resumed.connect('google');
  const result = await resumed.resume(sheetUrl); assert.equal(result.status, 'ready', result.error); assert.equal(result.operation, 'resume');
  assert.equal(result.orderMode, 'GRID'); assert.deepEqual(result.posts.map(post => post.caption), ['Caption for source 1', 'Caption for source 2', 'Caption for source 3']);
  assert.equal(resumed.calls.resolve.length, 0); assert.equal(resumed.calls.downloads.length, 0); assert.equal(resumed.calls.reads.length, 3);
  const image = await resumed.request('/api/jobs/' + result.id + '/images/' + result.posts[2].id);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), first.images[2]);
  assert.equal((await resumed.post('/api/jobs/' + result.id + '/refresh')).status, 200);
  const exported = await resumed.export(result); assert.equal(exported.status, 'ready', exported.error);
  assertDocx(resumed.calls.documents[0], first.images, [3, 2, 1]);
});

test('resume rejects untrusted URLs and damaged persisted image data before any Doc upload', async t => {
  const account = googleAccount(), first = await fixture(t, { account }), job = await first.readyImport();
  const resumed = await fixture(t, { account }); await resumed.connect('google');
  for (const sheetUrl of ['http://127.0.0.1/private', 'https://evil.invalid/spreadsheets/d/sheet_123/edit', 'https://docs.google.com/document/d/sheet_123/edit', 'https://user:password@docs.google.com/spreadsheets/d/sheet_123/edit']) {
    assert.equal((await resumed.post('/api/resume', { sheetUrl })).status, 400);
  }
  const saved = account.files.get(first.calls.images[0].id), original = saved.bytes;
  for (const bytes of [png(1, 2, [0, 0, 0]), png(4, 4)]) {
    saved.bytes = bytes;
    const result = await resumed.resume(job.sheet.url); assert.equal(result.status, 'error'); assert.ok(result.error);
    assert.equal(resumed.calls.documents.length, 0);
  }
  saved.bytes = original;
  const metadata = first.sheet(job).metadataRows; metadata[0][1] = '999';
  const invalidMetadata = await resumed.resume(job.sheet.url); assert.equal(invalidMetadata.status, 'error');
  assert.equal(resumed.calls.documents.length, 0);
});

test('unchanged exports reuse the existing Doc and changed Sheet text creates a new version without editing old Docs', async t => {
  const state = await fixture(t), job = await state.readyImport(); state.fill(job);
  const first = await state.export(job), doc = state.account.files.get(first.document.id); doc.manualEdits = 'Editor changed this Doc directly.';
  const repeated = await state.export(job); assert.equal(repeated.document.id, first.document.id); assert.equal(repeated.reused, true);
  assert.equal(state.calls.documents.length, 1); assert.equal(doc.manualEdits, 'Editor changed this Doc directly.'); assert.equal(doc.trashed, false);
  state.fill(job, 'Revised source ');
  const revised = await state.export(job); assert.notEqual(revised.document.id, first.document.id); assert.equal(state.calls.documents.length, 2);
  assertDocx(state.calls.documents[1], state.images, [3, 2, 1], 'Revised source '); assert.equal(doc.trashed, false); assert.equal(doc.manualEdits, 'Editor changed this Doc directly.');
  state.account.files.get(revised.document.id).trashed = true;
  const restored = await state.export(job); assert.notEqual(restored.document.id, revised.document.id); assert.equal(state.calls.documents.length, 3);
});

test('resume retains export metadata so a fresh server reuses an unchanged document', async t => {
  const account = googleAccount(), first = await fixture(t, { account }), job = await first.readyImport(); first.fill(job);
  const exported = await first.export(job); await first.close();
  const second = await fixture(t, { account }); await second.connect('google');
  const resumed = await second.resume(job.sheet.url), repeated = await second.export(resumed);
  assert.equal(repeated.document.id, exported.document.id); assert.equal(repeated.reused, true); assert.equal(second.calls.documents.length, 0);
});

test('invalid Sheet rows or read failures leave a ready workflow intact and create no Doc', async t => {
  let rejectRead = false;
  const state = await fixture(t, { beforeReadSheet() { if (rejectRead) throw new Error('Planning sheet unavailable.'); } }), job = await state.readyImport(); state.fill(job);
  const original = clone(state.sheet(job).rows); state.sheet(job).rows[1][1] = 99;
  let result = await state.export(job); assert.equal(result.status, 'ready'); assert.ok(result.error); assert.equal(result.sheet.id, job.sheet.id); assert.equal(result.posts.length, 3);
  state.sheet(job).rows = original; rejectRead = true;
  result = await state.export(job); assert.equal(result.status, 'ready'); assert.ok(result.error); assert.equal(state.calls.documents.length, 0);
  const image = await state.request('/api/jobs/' + job.id + '/images/' + job.posts[0].id); assert.deepEqual(Buffer.from(await image.arrayBuffer()), state.images[0]);
  rejectRead = false;
  result = await state.export(job); assert.equal(result.status, 'ready'); assert.ok(!result.error); assert.equal(state.calls.documents.length, 1);
});

test('failed import trashes only its newly created private folder and preserves existing files', async t => {
  const account = googleAccount(); account.files.set('existing_doc', { id: 'existing_doc', manualEdits: 'Keep me', trashed: false });
  const state = await fixture(t, { account, beforeSheet() { throw new Error('Planning sheet creation failed.'); } });
  await state.connect('canva'); await state.connect('google');
  const job = await state.waitJob(await state.startImport()); assert.equal(job.status, 'error'); assert.ok(job.error);
  assert.equal(state.calls.documents.length, 0); assert.equal(state.calls.folders.length, 1);
  assert.ok(state.calls.deletes.some(value => value.id === state.calls.folders[0].id));
  assert.ok(state.calls.images.every(image => image.trashed)); assert.equal(account.files.get('existing_doc').trashed, false);
});

test('failed export metadata persistence trashes the new Doc and preserves the previous version and planning workflow', async t => {
  let rejectMetadata = false;
  const state = await fixture(t, { beforeMetadata() { if (rejectMetadata) throw new Error('Could not save workflow metadata.'); } }), job = await state.readyImport(); state.fill(job);
  const first = await state.export(job), originalMetadata = clone(state.sheet(job).metadataRows); state.fill(job, 'Revised source '); rejectMetadata = true;
  const result = await state.export(job); assert.equal(result.status, 'ready'); assert.ok(result.error);
  assert.equal(result.document.id, first.document.id); assert.equal(state.calls.documents.length, 2);
  const newDoc = state.calls.documents[1]; assert.equal(newDoc.trashed, true); assert.equal(state.account.files.get(first.document.id).trashed, false);
  assert.deepEqual(state.sheet(job).metadataRows, originalMetadata); assert.ok(state.calls.images.every(image => !image.trashed));
  rejectMetadata = false; const retry = await state.export(job); assert.equal(retry.status, 'ready'); assert.ok(!retry.error);
});

test('image downloads enforce trusted redirect hosts, byte limits and valid PNG data', async t => {
  const scenarios = [
    { fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } }), pattern: /download host/ },
    { fetchImpl: async () => new Response('small body', { headers: { 'Content-Length': String(9 * 1024 * 1024) } }), pattern: /8 MB/ },
    { fetchImpl: async () => new Response('not an image'), pattern: /unreadable|unsupported/ },
  ];
  for (const scenario of scenarios) {
    const state = await fixture(t, scenario); await state.connect('canva'); await state.connect('google');
    const job = await state.waitJob(await state.startImport()); assert.equal(job.status, 'error'); assert.match(job.error, scenario.pattern);
    assert.equal(state.calls.downloads.length, 1); assert.equal(state.calls.documents.length, 0); assert.equal(state.calls.images.length, 0);
  }
  const many = await fixture(t, { images: Array(61).fill(png(1, 1)) }); await many.connect('canva'); await many.connect('google');
  const job = await many.waitJob(await many.startImport()); assert.equal(job.status, 'error'); assert.equal(many.calls.downloads.length, 0);
});

test('one pending import per browser and one export per Sheet prevent duplicate work', { timeout: 10000 }, async t => {
  const importGate = deferred(), importEntered = deferred(); let holdImport = true;
  const documentGate = deferred(), documentEntered = deferred(); let holdDocument = false;
  t.after(() => { importGate.resolve(); documentGate.resolve(); });
  const state = await fixture(t, {
    async beforeCanvaExport() { if (holdImport) { importEntered.resolve(); await importGate.promise; } },
    async beforeDocument() { if (holdDocument) { documentEntered.resolve(); await documentGate.promise; } },
  });
  await state.connect('canva'); await state.connect('google');
  const id = await state.startImport(); await importEntered.promise;
  assert.equal((await state.post('/api/import', { url: 'https://canva.link/example', orderMode: 'GRID', title: 'Duplicate' })).status, 409);
  holdImport = false; importGate.resolve(); const job = await state.waitJob(id); state.fill(job);
  const originalCookie = state.cookie, originalCsrf = state.csrf;
  await state.session(''); await state.connect('google'); const resumed = await state.resume(job.sheet.url);
  const secondCookie = state.cookie, secondCsrf = state.csrf;
  state.cookie = originalCookie; state.csrf = originalCsrf; holdDocument = true;
  const pending = await state.post('/api/jobs/' + job.id + '/export'); assert.equal(pending.status, 202); await documentEntered.promise;
  assert.equal((await state.post('/api/jobs/' + job.id + '/export')).status, 409);
  state.cookie = secondCookie; state.csrf = secondCsrf;
  assert.equal((await state.post('/api/jobs/' + resumed.id + '/export')).status, 409);
  holdDocument = false; documentGate.resolve(); state.cookie = originalCookie; state.csrf = originalCsrf;
  assert.equal((await state.waitJob(job.id)).status, 'ready'); assert.equal(state.calls.documents.length, 1);
  state.cookie = secondCookie; state.csrf = secondCsrf;
  const reused = await state.export(resumed); assert.equal(reused.reused, true); assert.equal(state.calls.documents.length, 1);
});
