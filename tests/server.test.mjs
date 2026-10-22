import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { once } from 'node:events';
import { createApp, readConfig } from '../server/server.mjs';
import * as realProviders from '../server/providers.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width, height, color) {
  function chunk(kind, content) {
    const type = Buffer.from(kind), head = Buffer.alloc(4), end = Buffer.alloc(4);
    head.writeUInt32BE(content.length);
    end.writeUInt32BE(crc32(Buffer.concat([type, content])));
    return Buffer.concat([head, type, content, end]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.set(color, y * (width * 3 + 1) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function unzipStored(input) {
  const bytes = Buffer.from(input), entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength);
    const begin = offset + 30 + nameLength + extra;
    entries.set(name, bytes.subarray(begin, begin + size));
    offset = begin + size;
  }
  return entries;
}

async function fixture(t, options = {}) {
  let clock = options.clock ?? 1_800_000_000_000;
  const calls = { oauth: [], refresh: [], resolve: [], export: [], uploads: [], fills: [], images: [] };
  const images = [png(1, 2, [180, 20, 20]), png(2, 3, [20, 180, 20]), png(3, 4, [20, 20, 180])];
  const config = {
    publicOrigin: 'http://127.0.0.1:3000', canvaClientId: 'canva-client',
    canvaClientSecret: 'canva-secret', googleClientId: 'google-client', googleClientSecret: 'google-secret',
    ...(options.config || {})
  };
  const providers = {
    validateCanvaUrl(value) {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !['www.canva.com', 'canva.link'].includes(url.hostname)) throw new Error('invalid');
      return url;
    },
    oauthAuthorizationUrl(provider, _config, values) {
      calls.oauth.push({ provider, ...values });
      return 'https://consent.example.invalid/' + provider + '?' + new URLSearchParams(values);
    },
    async exchangeOAuthCode(provider, _config, values) {
      assert.ok(values.codeVerifier.length >= 43);
      return { accessToken: provider + '-token', refreshToken: provider + '-refresh', expiresAt: clock + (options.expiredTokens ? 1 : 3600000) };
    },
    async refreshOAuthToken(provider) {
      calls.refresh.push(provider);
      return { accessToken: provider + '-refreshed', expiresAt: clock + 3600000 };
    },
    async resolveCanvaDesign(value) { calls.resolve.push(value); return { designId: 'DAG_test', url: value }; },
    async exportCanvaPages(id, access, values) {
      calls.export.push({ id, access });
      values.onProgress?.({ status: 'success' });
      return images.map((_, i) => 'https://export-download.canva.com/page' + i + '.png');
    },
    async createGoogleDocument(bytes, access, values) {
      calls.uploads.push({ bytes, access, title: values.title });
      return { id: 'doc_native_123', url: 'https://docs.google.com/document/d/doc_native_123/edit' };
    },
    async fillGoogleCaptions(id, access, replacements) {
      calls.fills.push({ id, access, replacements });
      return replacements.map(() => 1);
    },
    ...(options.providers || {})
  };
  const fetchImpl = options.fetchImpl || (async url => {
    calls.images.push(url);
    const index = Number(url.match(/page(\d+)\.png/)?.[1]);
    return new Response(images[index], { status: 200, headers: { 'Content-Type': 'image/png' } });
  });
  const app = createApp({ config, providers, fetchImpl, now: () => clock });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port;
  config.publicOrigin = base;
  t.after(() => app.close());
  const state = { app, base, config, providers, calls, images, cookie: '', csrf: '', advance: ms => { clock += ms; } };
  state.request = async (pathname, init = {}, ownCookie = state.cookie) => {
    const headers = { ...(ownCookie ? { Cookie: ownCookie } : {}), ...(init.headers || {}) };
    return fetch(base + pathname, { redirect: 'manual', ...init, headers });
  };
  state.session = async () => {
    const response = await state.request('/api/session');
    state.cookie = response.headers.get('set-cookie')?.split(';')[0] || state.cookie;
    const data = await response.json();
    state.csrf = data.csrfToken;
    return data;
  };
  state.connect = async provider => {
    const start = await state.request('/oauth/start/' + provider);
    assert.equal(start.status, 302);
    const issued = calls.oauth.at(-1);
    const result = await state.request('/oauth/callback/' + provider + '?' + new URLSearchParams({ state: issued.state, code: 'mock-code' }));
    assert.equal(result.status, 302);
    return issued;
  };
  state.post = async (pathname, body, extra = {}) => state.request(pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf, ...extra },
    body: JSON.stringify(body)
  });
  state.startImport = async (orderMode = 'GRID') => {
    const response = await state.post('/api/import', { url: 'https://canva.link/example', orderMode, title: 'Test & Feed' });
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
    return (await response.json()).jobId;
  };
  state.waitJob = async id => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await state.request('/api/jobs/' + id);
      const value = await response.json();
      if (value.status !== 'running') return value;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Job did not finish.');
  };
  await state.session();
  return state;
}

test('health and served page work before OAuth configuration', async t => {
  const state = await fixture(t, { config: { canvaClientId: '', googleClientSecret: '' } });
  assert.deepEqual(await (await state.request('/healthz')).json(), { ok: true });
  const session = await state.session();
  assert.deepEqual(session.configured, { canva: false, google: false });
  assert.deepEqual(session.connected, { canva: false, google: false });
  assert.ok(!JSON.stringify(session).includes('canva-secret'));
  const html = await (await state.request('/')).text();
  assert.match(html, /name="feed-studio-mode" content="server"/);
  const denied = await state.request('/oauth/start/canva');
  assert.equal(denied.status, 503);
});

test('OAuth uses PKCE, session-bound one-use state and secure cookie attributes', async t => {
  const state = await fixture(t);
  const response = await state.request('/api/session', {}, '');
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.ok(!cookie.includes('canva-token'));
  const start = await state.request('/oauth/start/canva');
  const issued = state.calls.oauth.at(-1);
  assert.ok(issued.state.length > 30);
  assert.match(issued.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  const crossSession = await state.request('/oauth/callback/canva?' + new URLSearchParams({ state: issued.state, code: 'bad' }), {}, cookie.split(';')[0]);
  assert.equal(crossSession.status, 400);
  const accepted = await state.request('/oauth/callback/canva?' + new URLSearchParams({ state: issued.state, code: 'good' }));
  assert.equal(accepted.status, 302);
  assert.equal(accepted.headers.get('location'), '/?connected=canva');
  const replay = await state.request('/oauth/callback/canva?' + new URLSearchParams({ state: issued.state, code: 'good' }));
  assert.equal(replay.status, 400);
  const session = await state.session();
  assert.equal(session.connected.canva, true);
  assert.ok(!JSON.stringify(session).includes('canva-token'));
});

test('expired OAuth state and expired browser sessions cannot authorize', async t => {
  const state = await fixture(t);
  await state.request('/oauth/start/canva');
  const issued = state.calls.oauth.at(-1);
  state.advance(11 * 60 * 1000);
  const expired = await state.request('/oauth/callback/canva?' + new URLSearchParams({ state: issued.state, code: 'bad' }));
  assert.equal(expired.status, 400);
  state.advance(3 * 60 * 60 * 1000);
  const protectedRequest = await state.request('/api/jobs/something');
  assert.equal(protectedRequest.status, 401);
});

test('mutations require matching CSRF token and origin, and reject untrusted links', async t => {
  const state = await fixture(t);
  const body = { url: 'https://canva.link/example', orderMode: 'GRID' };
  let response = await state.post('/api/import', body, { 'X-CSRF-Token': 'bad' });
  assert.equal(response.status, 403);
  response = await state.post('/api/import', body, { Origin: 'https://evil.invalid' });
  assert.equal(response.status, 403);
  response = await state.post('/api/import', { ...body, url: 'http://127.0.0.1/private' });
  assert.equal(response.status, 400);
  response = await state.post('/api/import', body);
  assert.equal(response.status, 401);
  assert.equal(state.calls.resolve.length, 0);
});

test('full GRID import produces a real DOCX in reverse publication order and a native Google Doc', async t => {
  const state = await fixture(t);
  await state.connect('canva'); await state.connect('google');
  const id = await state.startImport('GRID');
  const job = await state.waitJob(id);
  assert.equal(job.status, 'ready', job.error);
  assert.equal(job.orderMode, 'GRID');
  assert.equal(job.title, 'Test & Feed');
  assert.equal(job.posts.length, 3);
  assert.deepEqual(job.posts.map(post => post.sourceIndex), [1, 2, 3]);
  assert.equal(job.document.url, 'https://docs.google.com/document/d/doc_native_123/edit');
  assert.equal(state.calls.uploads.length, 1);
  const upload = state.calls.uploads[0];
  assert.equal(upload.access, 'google-token');
  const entries = unzipStored(upload.bytes);
  assert.deepEqual(entries.get('word/media/image1.png'), state.images[2]);
  assert.deepEqual(entries.get('word/media/image3.png'), state.images[0]);
  const xml = entries.get('word/document.xml').toString();
  assert.match(xml, /Caption for post 01 — to write/);
  assert.match(xml, /Hashtags for post 03 — to add/);
  assert.equal((xml.match(/<w:pageBreakBefore\/>/g) || []).length, 2);
  assert.ok(!JSON.stringify(job).includes('canva-token'));
  const image = await state.request('/api/jobs/' + id + '/images/' + job.posts[0].id);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), state.images[0]);
  assert.equal(image.headers.get('content-type'), 'image/png');
});

test('PUBLICATION import keeps source-page order and refreshes expiring credentials', async t => {
  const state = await fixture(t, { expiredTokens: true });
  await state.connect('canva'); await state.connect('google');
  const job = await state.waitJob(await state.startImport('PUBLICATION'));
  assert.equal(job.status, 'ready', job.error);
  const entries = unzipStored(state.calls.uploads[0].bytes);
  assert.deepEqual(entries.get('word/media/image1.png'), state.images[0]);
  assert.deepEqual(entries.get('word/media/image3.png'), state.images[2]);
  assert.deepEqual(state.calls.refresh, ['canva', 'google']);
  assert.equal(state.calls.export[0].access, 'canva-refreshed');
  assert.equal(state.calls.uploads[0].access, 'google-refreshed');
});

test('jobs and original image bytes are isolated to the authorizing browser session', async t => {
  const state = await fixture(t);
  await state.connect('canva'); await state.connect('google');
  const id = await state.startImport(), job = await state.waitJob(id);
  const otherSession = await state.request('/api/session', {}, '');
  const otherCookie = otherSession.headers.get('set-cookie').split(';')[0];
  const denied = await state.request('/api/jobs/' + id, {}, otherCookie);
  assert.equal(denied.status, 404);
  const imageDenied = await state.request('/api/jobs/' + id + '/images/' + job.posts[0].id, {}, otherCookie);
  assert.equal(imageDenied.status, 404);
});

test('captions update exact per-post placeholders once and preserve existing Docs edits', async t => {
  const state = await fixture(t);
  await state.connect('canva'); await state.connect('google');
  const id = await state.startImport(), job = await state.waitJob(id);
  const body = { posts: [{ id: job.posts[0].id, caption: 'Our courtyard in warm afternoon light.', hashtags: '#Hotel #Design' }] };
  let response = await state.post('/api/jobs/' + id + '/captions', body);
  assert.equal(response.status, 200);
  let value = await response.json();
  assert.equal(value.updated, 2);
  assert.equal(value.posts[0].syncedCaption, body.posts[0].caption);
  assert.deepEqual(state.calls.fills[0].replacements, [
    { text: 'Caption for post 03 — to write.', replaceText: body.posts[0].caption },
    { text: 'Hashtags for post 03 — to add.', replaceText: '#Hotel #Design' }
  ]);
  response = await state.post('/api/jobs/' + id + '/captions', body);
  assert.equal((await response.json()).updated, 0);
  assert.equal(state.calls.fills.length, 1);
  response = await state.post('/api/jobs/' + id + '/captions', {
    posts: [{ ...body.posts[0], caption: 'A different caption should not overwrite Docs.' }]
  });
  assert.equal(response.status, 409);
  assert.equal(state.calls.fills.length, 1);
  value = await (await state.request('/api/jobs/' + id)).json();
  assert.equal(value.posts[0].syncedCaption, body.posts[0].caption);
});

test('missing Google placeholders are reported and only confirmed replacements are tracked', async t => {
  const state = await fixture(t, { providers: { async fillGoogleCaptions() { return [1, 0]; } } });
  await state.connect('canva'); await state.connect('google');
  const id = await state.startImport(), job = await state.waitJob(id);
  const response = await state.post('/api/jobs/' + id + '/captions', {
    posts: [{ id: job.posts[0].id, caption: 'One confirmed caption.', hashtags: '#Hotel' }]
  });
  assert.equal(response.status, 409);
  const refreshed = await (await state.request('/api/jobs/' + id)).json();
  assert.equal(refreshed.posts[0].syncedCaption, 'One confirmed caption.');
  assert.equal(refreshed.posts[0].syncedHashtags, '');
});

test('corrupt page downloads fail before creating any Google document', async t => {
  const state = await fixture(t, { fetchImpl: async () => new Response('not a PNG', { status: 200 }) });
  await state.connect('canva'); await state.connect('google');
  const job = await state.waitJob(await state.startImport());
  assert.equal(job.status, 'error');
  assert.match(job.error, /unreadable image/);
  assert.equal(job.posts.length, 0);
  assert.equal(state.calls.uploads.length, 0);
});

test('redirects to arbitrary download hosts are not fetched', async t => {
  let requests = 0;
  const state = await fixture(t, { fetchImpl: async () => {
    requests++;
    return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } });
  } });
  await state.connect('canva'); await state.connect('google');
  const job = await state.waitJob(await state.startImport());
  assert.equal(job.status, 'error');
  assert.match(job.error, /unsupported image download host/);
  assert.equal(requests, 1);
  assert.equal(state.calls.uploads.length, 0);
});

test('oversized image response is rejected before reading its body or creating a document', async t => {
  const state = await fixture(t, { fetchImpl: async () => new Response('small body', {
    status: 200, headers: { 'Content-Length': String(9 * 1024 * 1024) }
  }) });
  await state.connect('canva'); await state.connect('google');
  const job = await state.waitJob(await state.startImport());
  assert.equal(job.status, 'error');
  assert.match(job.error, /exceeds 8 MB/);
  assert.equal(state.calls.uploads.length, 0);
});

test('configuration accepts local development and HTTPS only, with no credential output', () => {
  assert.equal(readConfig({}).publicOrigin, 'http://127.0.0.1:3000');
  assert.equal(readConfig({ PUBLIC_ORIGIN: 'https://studio.example.com', CANVA_CLIENT_ID: 'client' }).canvaClientId, 'client');
  for (const value of ['http://public.example.com', 'https://user:password@example.com', 'https://example.com/path', 'javascript:alert(1)']) {
    assert.throws(() => readConfig({ PUBLIC_ORIGIN: value }), /PUBLIC_ORIGIN/);
  }
});

test('real adapters and HTTP backend cooperate across OAuth, Canva export, native Drive import and caption updates', async t => {
  const upstream = [];
  let state, uploadedDocx;
  const reply = value => new Response(JSON.stringify(value), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
  const fetchImpl = async (value, options = {}) => {
    const url = new URL(value);
    upstream.push({ url: url.href, options });
    if (url.href === 'https://api.canva.com/rest/v1/oauth/token' || url.href === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('code'), 'real-adapter-test-code');
      assert.ok(form.get('code_verifier').length >= 43);
      assert.match(form.get('redirect_uri'), /\/oauth\/callback\/(?:canva|google)$/);
      const provider = url.hostname === 'api.canva.com' ? 'canva' : 'google';
      assert.equal(form.get('client_secret'), provider + '-secret');
      return reply({ access_token: provider + '-real-adapter-token', token_type: 'Bearer',
        refresh_token: provider + '-real-adapter-refresh', expires_in: 3600 });
    }
    if (url.href === 'https://canva.link/example') {
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: {
        Location: 'https://www.canva.com/design/DAG_real_adapter/view'
      } });
    }
    if (url.href === 'https://api.canva.com/rest/v1/exports') {
      assert.equal(options.headers.Authorization, 'Bearer canva-real-adapter-token');
      assert.deepEqual(JSON.parse(options.body), { design_id: 'DAG_real_adapter',
        format: { type: 'png', lossless: true, as_single_image: false } });
      return reply({ job: { id: 'export_real', status: 'success',
        urls: state.images.map((_, index) => 'https://export-download.canva.com/page' + index + '.png') } });
    }
    if (url.hostname === 'export-download.canva.com') {
      const index = Number(url.pathname.match(/page(\d+)\.png/)[1]);
      return new Response(state.images[index], { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/upload/drive/v3/files') {
      assert.equal(url.searchParams.get('uploadType'), 'multipart');
      assert.equal(options.headers.Authorization, 'Bearer google-real-adapter-token');
      assert.match(options.headers['Content-Type'], /^multipart\/related; boundary=/);
      const payload = Buffer.from(options.body);
      assert.ok(payload.includes(Buffer.from('"mimeType":"application/vnd.google-apps.document"')));
      assert.ok(payload.includes(Buffer.from('"name":"Test & Feed"')));
      const begin = payload.indexOf(Buffer.from([80, 75, 3, 4]));
      const boundary = options.headers['Content-Type'].split('boundary=')[1];
      const end = payload.lastIndexOf(Buffer.from('\r\n--' + boundary));
      assert.ok(begin >= 0 && end > begin);
      uploadedDocx = payload.subarray(begin, end);
      return reply({ id: 'native_real_adapter_doc' });
    }
    if (url.href === 'https://docs.googleapis.com/v1/documents/native_real_adapter_doc:batchUpdate') {
      assert.equal(options.headers.Authorization, 'Bearer google-real-adapter-token');
      const body = JSON.parse(options.body);
      assert.deepEqual(body.requests.map(item => item.replaceAllText.containsText), [
        { text: 'Caption for post 03 — to write.', matchCase: true },
        { text: 'Hashtags for post 03 — to add.', matchCase: true }
      ]);
      assert.deepEqual(body.requests.map(item => item.replaceAllText.replaceText),
        ['A table set for a quiet evening.', '#Restaurant #Dining']);
      return reply({ replies: body.requests.map(() => ({ replaceAllText: { occurrencesChanged: 1 } })) });
    }
    throw new Error('Unexpected upstream request.');
  };
  state = await fixture(t, { providers: realProviders, fetchImpl, clock: Date.now() });
  for (const provider of ['canva', 'google']) {
    const start = await state.request('/oauth/start/' + provider);
    assert.equal(start.status, 302);
    const destination = new URL(start.headers.get('location'));
    assert.equal(destination.hostname, provider === 'canva' ? 'www.canva.com' : 'accounts.google.com');
    assert.equal(destination.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(destination.searchParams.get('redirect_uri'), state.base + '/oauth/callback/' + provider);
    const callback = await state.request('/oauth/callback/' + provider + '?' +
      new URLSearchParams({ state: destination.searchParams.get('state'), code: 'real-adapter-test-code' }));
    assert.equal(callback.status, 302);
  }
  const id = await state.startImport('GRID');
  const job = await state.waitJob(id);
  assert.equal(job.status, 'ready', job.error);
  assert.ok(!job.stage.includes('[object Object]'));
  assert.equal(job.document.url, 'https://docs.google.com/document/d/native_real_adapter_doc/edit');
  const entries = unzipStored(uploadedDocx);
  assert.deepEqual(entries.get('word/media/image1.png'), state.images[2]);
  assert.deepEqual(entries.get('word/media/image3.png'), state.images[0]);
  const sync = await state.post('/api/jobs/' + id + '/captions', {
    posts: [{ id: job.posts[0].id, caption: 'A table set for a quiet evening.', hashtags: '#Restaurant #Dining' }]
  });
  assert.equal(sync.status, 200);
  const result = await sync.json();
  assert.equal(result.updated, 2);
  assert.equal(result.posts[0].syncedCaption, 'A table set for a quiet evening.');
  assert.ok(!upstream.some(request => request.url.includes('/permissions')));
  assert.ok(!JSON.stringify(result).includes('real-adapter-token'));
  assert.equal(upstream.filter(request => request.url.includes('/upload/drive/')).length, 1);
});
