import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/server.mjs';
import * as providers from '../server/providers.mjs';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZ0AAAAASUVORK5CYII=', 'base64');
const reply = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

test('real Google adapters carry a Canva image through private Drive, persistent Sheets, restart and native Docs', async t => {
  const files = new Map(), sheets = new Map(), calls = [];
  let serial = 0;
  const next = prefix => prefix + '_' + (++serial);
  const multipart = options => {
    const bytes = Buffer.from(options.body);
    const boundary = options.headers['Content-Type'].split('boundary=')[1];
    const first = bytes.indexOf('\r\n\r\n') + 4;
    const divider = bytes.indexOf('\r\n--' + boundary, first);
    const metadata = JSON.parse(bytes.subarray(first, divider).toString());
    const mediaStart = bytes.indexOf('\r\n\r\n', divider) + 4;
    const mediaEnd = bytes.indexOf('\r\n--' + boundary + '--', mediaStart);
    return { metadata, bytes: bytes.subarray(mediaStart, mediaEnd) };
  };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    calls.push({ url: url.href, method });
    if (url.hostname === 'export-download.canva.com') {
      assert.equal(options.headers?.Authorization, undefined);
      return new Response(image, { headers: { 'Content-Type': 'image/png' } });
    }
    assert.ok(['www.googleapis.com', 'sheets.googleapis.com'].includes(url.hostname), 'Only fixed Google API destinations are used.');
    assert.equal(options.headers.Authorization, 'Bearer google-integration-token');
    assert.equal(options.redirect, 'error');
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const metadata = JSON.parse(options.body), id = next('folder');
      files.set(id, { id, ...metadata, trashed: false });
      return reply({ id });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const value = multipart(options), isImage = value.metadata.mimeType === 'image/png';
      const id = next(isImage ? 'photo' : 'document');
      assert.ok(files.has(value.metadata.parents[0]), 'Every new file belongs to the private project folder.');
      files.set(id, { id, ...value.metadata, bytes: Buffer.from(value.bytes), trashed: false });
      if (isImage) assert.deepEqual(value.bytes, image);
      else { assert.equal(value.metadata.mimeType, 'application/vnd.google-apps.document'); assert.equal(value.bytes.readUInt32LE(0), 0x04034b50); }
      return reply({ id });
    }
    if (url.pathname === '/v4/spreadsheets' && method === 'POST') {
      const value = JSON.parse(options.body), id = next('sheet');
      sheets.set(id, { ...value, spreadsheetId: id, developerMetadata: [] });
      files.set(id, { id, parents: ['root'], trashed: false });
      return reply({ spreadsheetId: id, sheets: value.sheets.map(sheet => ({ properties: sheet.properties })) });
    }
    const sheetMatch = /^\/v4\/spreadsheets\/([A-Za-z0-9_-]+)(.*)$/.exec(url.pathname);
    if (sheetMatch) {
      const sheet = sheets.get(sheetMatch[1]); assert.ok(sheet);
      if (sheetMatch[2] === ':batchUpdate') {
        for (const request of JSON.parse(options.body).requests) {
          if (request.createDeveloperMetadata) sheet.developerMetadata.push(request.createDeveloperMetadata.developerMetadata);
          if (request.updateCells) sheet.sheets[1].data[0].rowData = request.updateCells.rows;
        }
        return reply({ replies: [] });
      }
      if (sheetMatch[2] === '/values:batchGet') {
        const values = tab => tab.data[0].rowData.map(row => row.values.map(cell => cell.userEnteredValue?.numberValue ?? cell.userEnteredValue?.stringValue ?? ''));
        return reply({ spreadsheetId: sheet.spreadsheetId, valueRanges: sheet.sheets.map(tab => ({ values: values(tab) })) });
      }
      assert.equal(sheetMatch[2], '');
      return reply({ spreadsheetId: sheet.spreadsheetId, properties: sheet.properties,
        sheets: sheet.sheets.map(tab => ({ properties: tab.properties })), developerMetadata: sheet.developerMetadata });
    }
    const fileMatch = /^\/drive\/v3\/files\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (fileMatch) {
      const file = files.get(fileMatch[1]); assert.ok(file);
      if (method === 'PATCH') {
        if (options.body) Object.assign(file, JSON.parse(options.body));
        if (url.searchParams.has('addParents')) file.parents = [url.searchParams.get('addParents')];
        return reply({ id: file.id, trashed: file.trashed });
      }
      if (url.searchParams.get('alt') === 'media') return new Response(file.bytes, { headers: { 'Content-Type': file.mimeType } });
      return reply({ id: file.id, parents: file.parents, trashed: file.trashed });
    }
    assert.fail('Unexpected Google adapter request: ' + url.pathname);
  };
  async function browser() {
    const config = { publicOrigin: 'http://127.0.0.1:3000', canvaClientId: 'integration-client', canvaClientSecret: 'test-secret', googleClientId: 'integration-google', googleClientSecret: 'test-google-secret' };
    const app = createApp({ config, fetchImpl, providers: { ...providers,
      async exchangeOAuthCode(provider) { return { accessToken: provider + '-integration-token', expiresAt: Date.now() + 3600000 }; },
      async exportCanvaPages() { return ['https://export-download.canva.com/test.png']; }
    } });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const base = 'http://127.0.0.1:' + app.server.address().port; config.publicOrigin = base;
    let stopped = false;
    const close = async () => { if (!stopped) { stopped = true; await app.close(); } }; t.after(close);
    let cookie = '', csrf;
    const request = async (path, body) => {
      const response = await fetch(base + path, { redirect: 'manual', headers: { Cookie: cookie,
        ...(body ? { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}) },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
      cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie; return response;
    };
    csrf = (await (await request('/api/session')).json()).csrfToken;
    const connect = async provider => {
      const start = await request('/oauth/start/' + provider);
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      assert.equal((await request('/oauth/callback/' + provider + '?' + new URLSearchParams({ state, code: 'test-code' }))).status, 302);
    };
    const work = async (path, body) => {
      const response = await request(path, body); assert.equal(response.status, 202, await response.clone().text());
      const { jobId } = await response.json();
      for (let count = 0; count < 100; count++) {
        const job = await (await request('/api/jobs/' + jobId)).json();
        if (job.status !== 'running') { assert.equal(job.status, 'ready', job.error); assert.ok(!job.error, job.error); return job; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('Workflow did not complete.');
    };
    return { close, connect, work };
  }
  const first = await browser(); await first.connect('canva'); await first.connect('google');
  const job = await first.work('/api/import', { url: 'https://www.canva.com/design/ABCDE_TEST/view', title: 'Private integration feed', orderMode: 'GRID' });
  const sheet = sheets.get(job.sheet.id);
  assert.equal(sheet.developerMetadata[0].metadataKey, 'feed_studio_version');
  const cells = sheet.sheets[0].data[0].rowData[1].values;
  cells[3].userEnteredValue = { stringValue: 'A quiet afternoon, captured in one frame.' };
  cells[4].userEnteredValue = { stringValue: '#QuietMoments' };
  await first.close();
  const second = await browser(); await second.connect('google');
  const resumed = await second.work('/api/resume', { sheetUrl: job.sheet.url });
  assert.equal(resumed.posts[0].caption, 'A quiet afternoon, captured in one frame.');
  const exported = await second.work('/api/jobs/' + resumed.id + '/export', {});
  assert.ok(files.get(exported.document.id).bytes.includes(Buffer.from('A quiet afternoon, captured in one frame.')));
  assert.ok(files.get(exported.document.id).bytes.includes(image));
  assert.equal((await second.work('/api/jobs/' + resumed.id + '/export', {})).reused, true);
  assert.equal([...files.values()].filter(file => file.mimeType === 'application/vnd.google-apps.document').length, 1);
  assert.ok(calls.some(call => call.url.includes('sheets.googleapis.com')));
});
