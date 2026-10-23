import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildDocument } = require('../web/docx.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'feedstudio_session';
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_TOTAL = 40 * 1024 * 1024;
const MAX_BODY = 128 * 1024;
const SESSION_TTL = 2 * 60 * 60 * 1000;
const OAUTH_TTL = 10 * 60 * 1000;
const token = () => randomBytes(32).toString('base64url');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function readConfig(env = process.env) {
  const port = Number(env.FEED_STUDIO_PORT || env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid FEED_STUDIO_PORT.');
  const publicOrigin = env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL || 'http://127.0.0.1:' + port;
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new Error('PUBLIC_ORIGIN must be a valid origin.'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local)) ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('PUBLIC_ORIGIN must use HTTPS, except for local development.');
  }
  return {
    publicOrigin: origin.origin,
    port,
    host: env.FEED_STUDIO_HOST || '127.0.0.1',
    canvaClientId: env.CANVA_CLIENT_ID || '',
    canvaClientSecret: env.CANVA_CLIENT_SECRET || '',
    canvaClientAuthorization: env.CANVA_CLIENT_AUTHORIZATION || '',
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || ''
  };
}

function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function publicJob(job) {
  return {
    id: job.id, status: job.status, stage: job.stage, orderMode: job.orderMode, title: job.title,
    ...(job.error ? { error: job.error } : {}),
    ...(job.document ? { document: job.document } : {}),
    posts: job.posts.map(post => ({
      id: post.id, name: post.name, mime: post.mime, width: post.width,
      height: post.height, sourceIndex: post.sourceIndex,
      captionSynced: Boolean(post.synced.caption), hashtagsSynced: Boolean(post.synced.hashtags),
      syncedCaption: post.synced.caption || '', syncedHashtags: post.synced.hashtags || ''
    }))
  };
}

function imageDimensions(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Canva returned an unreadable PNG image.');
    let offset = 8, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) throw new Error('Canva returned a truncated PNG image.');
      const kind = bytes.toString('ascii', offset + 4, offset + 8);
      offset += length + 12;
      if (kind === 'IEND') { ended = true; break; }
    }
    if (!ended) throw new Error('Canva returned an incomplete PNG image.');
    return { mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 216)) continue;
      if (offset + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 7) {
        return { mime: 'image/jpeg', width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += size;
    }
  }
  throw new Error('Canva returned an unsupported or unreadable image. Use PNG/JPEG export.');
}

function checkedDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Canva returned an invalid image download URL.'); }
  // Export URLs are issued by authenticated Canva API responses. Restrict every hop
  // to Canva-owned DNS names; arbitrary URLs and IP literals are never fetched.
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !url.hostname.endsWith('.canva.com')) throw new Error('Canva returned an unsupported image download host.');
  return url;
}

async function downloadImage(value, fetchImpl, signal) {
  let url = checkedDownloadUrl(value);
  for (let hop = 0; hop < 4; hop++) {
    let response;
    try { response = await fetchImpl(url.href, { redirect: 'manual', signal }); }
    catch { throw new Error('Could not download a Canva page. Check connectivity and retry.'); }
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Canva image download returned an invalid redirect.');
      url = checkedDownloadUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new Error('Canva image download returned HTTP ' + response.status + '.');
    const sizeHeader = Number(response.headers.get('content-length'));
    if (Number.isFinite(sizeHeader) && sizeHeader > MAX_IMAGE) throw new Error('A Canva page exceeds 8 MB. Reduce export dimensions.');
    let bytes;
    if (response.body && typeof response.body.getReader === 'function') {
      const chunks = [], reader = response.body.getReader();
      let size = 0;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          size += chunk.byteLength;
          if (size > MAX_IMAGE) { await reader.cancel(); throw new Error('A Canva page exceeds 8 MB. Reduce export dimensions.'); }
          chunks.push(Buffer.from(chunk));
        }
      } finally { reader.releaseLock(); }
      bytes = Buffer.concat(chunks);
    } else bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE) throw new Error('A Canva page is empty or exceeds 8 MB.');
    const image = imageDimensions(bytes);
    if (!image.width || !image.height || image.width * image.height > 25_000_000) {
      throw new Error('A Canva page has invalid dimensions or exceeds 25 megapixels.');
    }
    return { ...image, bytes: new Uint8Array(bytes) };
  }
  throw new Error('Too many Canva image download redirects.');
}

function checkedText(post) {
  if (!post || typeof post.id !== 'string') throw new HttpError(400, 'Each post must have an image ID.');
  if (post.caption != null && typeof post.caption !== 'string') throw new HttpError(400, 'Caption must be text.');
  if (post.hashtags != null && typeof post.hashtags !== 'string') throw new HttpError(400, 'Hashtags must be text.');
  const caption = (post.caption || '').replace(/\r\n?/g, '\n').trim();
  if (caption.length > 900 || caption.split('\n').length > 6) throw new HttpError(400, 'Keep each caption within 900 characters and 6 lines.');
  const tags = (post.hashtags || '').trim().split(/\s+/).filter(Boolean);
  if (tags.length > 5 || tags.some(tag => !/^#[A-Za-z0-9_]{1,60}$/.test(tag))) {
    throw new HttpError(400, 'Use at most 5 valid hashtags per post.');
  }
  return { id: post.id, caption, hashtags: [...new Set(tags)].join(' ') };
}

export function createApp({ config = readConfig(), providers, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!providers) throw new Error('Provider adapters are required.');
  const sessions = new Map();
  const shutdown = new AbortController();
  let closed = false;
  let activeImports = 0;
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace('name="feed-studio-mode" content="offline"', 'name="feed-studio-mode" content="server"');
  const ttl = config.sessionTtlMs || SESSION_TTL;
  const isConfigured = provider => provider === 'canva'
    ? Boolean(config.canvaClientId && (config.canvaClientSecret || config.canvaClientAuthorization))
    : Boolean(config.googleClientId && config.googleClientSecret);
  const linkedFetch = (url, options = {}) => fetchImpl(url, {
    ...options, signal: options.signal ? AbortSignal.any([options.signal, shutdown.signal]) : shutdown.signal
  });

  function prune() {
    for (const [id, session] of sessions) if (now() - session.lastSeen > ttl) sessions.delete(id);
  }
  const cleanup = setInterval(prune, 60_000);
  cleanup.unref();

  function sessionFor(req, res, create = false) {
    prune();
    const cookies = String(req.headers.cookie || '').split(';').map(part => part.trim());
    const raw = cookies.find(part => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    let session = raw && sessions.get(raw);
    if (!session && create) {
      if (sessions.size >= 100) throw new HttpError(503, 'The server is busy. Try again shortly.');
      const id = token();
      session = { id, csrfToken: token(), lastSeen: now(), oauth: {}, tokens: {}, jobs: new Map(), latestJobId: null };
      sessions.set(id, session);
      res.setHeader('Set-Cookie', COOKIE + '=' + id + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(ttl / 1000) +
        (config.publicOrigin.startsWith('https:') ? '; Secure' : ''));
    }
    if (session) session.lastSeen = now();
    if (!session) throw new HttpError(401, 'Open this application and connect your accounts first.');
    return session;
  }

  function json(res, code, value) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  async function readJson(req) {
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON content.');
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > MAX_BODY) throw new HttpError(413, 'Request is too large.');
      chunks.push(chunk);
    }
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
      return result;
    } catch { throw new HttpError(400, 'Request body must be a JSON object.'); }
  }

  function mutation(req, session) {
    if (req.headers.origin && req.headers.origin !== config.publicOrigin) throw new HttpError(403, 'Unexpected request origin.');
    if (!equalSecret(req.headers['x-csrf-token'], session.csrfToken)) throw new HttpError(403, 'Refresh the application and retry this action.');
  }

  async function accessToken(session, provider) {
    let saved = session.tokens[provider];
    if (!saved) throw new HttpError(401, 'Connect ' + (provider === 'canva' ? 'Canva' : 'Google') + ' first.');
    if (saved.expiresAt && saved.expiresAt < now() + 60_000) {
      if (!saved.refreshToken) { delete session.tokens[provider]; throw new HttpError(401, 'Reconnect ' + provider + ' to continue.'); }
      try {
        const refreshed = await providers.refreshOAuthToken(provider, config, { refreshToken: saved.refreshToken, fetchImpl: linkedFetch });
        saved = { ...refreshed, refreshToken: refreshed.refreshToken || saved.refreshToken };
        session.tokens[provider] = saved;
      } catch {
        delete session.tokens[provider];
        throw new HttpError(401, 'Could not refresh ' + provider + ' access. Reconnect the account.');
      }
    }
    return saved.accessToken;
  }

  function ownedJob(session, id) {
    const job = session.jobs.get(id);
    if (!job) throw new HttpError(404, 'This import is unavailable in the current session.');
    return job;
  }

  async function performImport(session, job) {
    try {
      job.stage = 'Resolving Canva link';
      const resolved = await providers.resolveCanvaDesign(job.url, { fetchImpl: linkedFetch });
      if (closed) throw new Error('Server stopped.');
      const canvaToken = await accessToken(session, 'canva');
      job.stage = 'Exporting Canva pages';
      const urls = await providers.exportCanvaPages(resolved.designId, canvaToken, {
        fetchImpl: linkedFetch, onProgress: progress => {
          job.stage = typeof progress === 'string' ? progress.slice(0, 150)
            : 'Exporting Canva pages' + (progress?.status ? ' (' + String(progress.status).slice(0, 30) + ')' : '');
        }
      });
      if (!Array.isArray(urls) || !urls.length || urls.length > 60) throw new Error('The design must contain between 1 and 60 exported pages.');
      let total = 0;
      for (let index = 0; index < urls.length; index++) {
        if (closed || !sessions.has(session.id)) throw new Error('The import session expired. Reconnect and retry.');
        job.stage = 'Downloading Canva page ' + (index + 1) + ' / ' + urls.length;
        const image = await downloadImage(urls[index], linkedFetch, AbortSignal.timeout(30_000));
        total += image.bytes.length;
        if (total > MAX_TOTAL) throw new Error('The exported feed exceeds 40 MB. Use a smaller Canva design or export size.');
        const retainedBytes = [...sessions.values()].reduce((sum, value) =>
          sum + [...value.jobs.values()].reduce((jobSum, item) =>
            jobSum + item.posts.reduce((imageSum, post) => imageSum + post.bytes.length, 0), 0), 0);
        if (retainedBytes + image.bytes.length > 128 * 1024 * 1024) throw new Error('The server image cache is full. Please retry later.');
        job.posts.push({
          ...image, id: randomBytes(12).toString('hex'), sourceIndex: index + 1,
          name: String(index + 1).padStart(2, '0') + (image.mime === 'image/png' ? '.png' : '.jpg'),
          caption: '', hashtags: '', synced: {}
        });
      }
      const ordered = job.orderMode === 'GRID' ? job.posts.slice().reverse() : job.posts.slice();
      const placeholders = ordered.map((post, index) => {
        const ordinal = String(index + 1).padStart(2, '0');
        const value = { caption: 'Caption for post ' + ordinal + ' — to write.', hashtags: 'Hashtags for post ' + ordinal + ' — to add.' };
        post.placeholders = value;
        return value;
      });
      job.stage = 'Creating Google Doc';
      const docx = await buildDocument(ordered, { title: job.title, placeholders });
      if (closed) throw new Error('Server stopped.');
      const googleToken = await accessToken(session, 'google');
      const created = await providers.createGoogleDocument(new Uint8Array(await docx.arrayBuffer()), googleToken, { title: job.title, fetchImpl: linkedFetch });
      if (!created || typeof created.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(created.id)) throw new Error('Google returned an invalid document ID.');
      job.document = { id: created.id, url: 'https://docs.google.com/document/d/' + created.id + '/edit' };
      job.status = 'ready';
      job.stage = 'Google Doc ready';
    } catch (error) {
      job.status = 'error';
      // Adapters expose sanitized provider errors. Do not include response bodies or tokens.
      job.error = String(error.message || 'Import failed.').slice(0, 350);
      job.stage = 'Import stopped';
      job.posts = [];
    } finally {
      activeImports--;
    }
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url, 'http://internal.invalid');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && url.pathname === '/healthz') { json(res, 200, { ok: true }); return; }
    if (req.method === 'GET' && url.pathname === '/api/session') {
      const session = sessionFor(req, res, true);
      json(res, 200, {
        serverMode: true, csrfToken: session.csrfToken,
        configured: { canva: isConfigured('canva'), google: isConfigured('google') },
        connected: { canva: Boolean(session.tokens.canva), google: Boolean(session.tokens.google) },
        ...(session.latestJobId ? { latestJobId: session.latestJobId } : {})
      });
      return;
    }
    let match = url.pathname.match(/^\/oauth\/(start|callback)\/(canva|google)$/);
    if (req.method === 'GET' && match) {
      const [, action, provider] = match;
      const session = sessionFor(req, res, action === 'start');
      if (!isConfigured(provider)) throw new HttpError(503, 'The administrator must configure the ' + provider + ' OAuth application before connection.');
      if (action === 'start') {
        const state = token(), codeVerifier = token() + token();
        session.oauth[provider] = { state, codeVerifier, expiresAt: now() + OAUTH_TTL };
        const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
        const destination = providers.oauthAuthorizationUrl(provider, config, { state, codeChallenge });
        res.writeHead(302, { Location: destination, 'Cache-Control': 'no-store' }); res.end(); return;
      }
      const pending = session.oauth[provider];
      if (!pending || pending.expiresAt < now() || !equalSecret(url.searchParams.get('state'), pending.state)) {
        throw new HttpError(400, 'OAuth state expired or does not match. Start the connection again.');
      }
      delete session.oauth[provider];
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) throw new HttpError(400, 'Connection was not authorized. You can retry from the application.');
      try {
        session.tokens[provider] = await providers.exchangeOAuthCode(provider, config, { code, codeVerifier: pending.codeVerifier, fetchImpl: linkedFetch });
      } catch { throw new HttpError(502, 'Could not complete ' + provider + ' connection. Check application configuration and retry.'); }
      res.writeHead(302, { Location: '/?connected=' + provider, 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/import') {
      const session = sessionFor(req, res);
      mutation(req, session);
      const body = await readJson(req);
      if (typeof body.url !== 'string') throw new HttpError(400, 'Paste a Canva design URL.');
      try { providers.validateCanvaUrl(body.url); } catch { throw new HttpError(400, 'Use a valid HTTPS Canva design or canva.link URL.'); }
      if (!['GRID', 'PUBLICATION'].includes(body.orderMode)) throw new HttpError(400, 'orderMode must be GRID or PUBLICATION.');
      if (body.title != null && (typeof body.title !== 'string' || body.title.length > 100)) throw new HttpError(400, 'Use a document title of at most 100 characters.');
      if (!isConfigured('canva') || !isConfigured('google')) throw new HttpError(503, 'Canva and Google OAuth applications must be configured by the administrator.');
      if (!session.tokens.canva || !session.tokens.google) throw new HttpError(401, 'Connect Canva and Google before importing the design.');
      const running = [...session.jobs.values()].find(job => job.status === 'running');
      if (running) throw new HttpError(409, 'An import is already running. Wait for it to finish.');
      if (activeImports >= 3) throw new HttpError(503, 'The server is processing other imports. Try again shortly.');
      while (session.jobs.size >= 2) session.jobs.delete(session.jobs.keys().next().value);
      const job = {
        id: token(), url: body.url, title: (body.title || 'Instagram feed').trim() || 'Instagram feed',
        orderMode: body.orderMode, status: 'running', stage: 'Starting import', posts: [], createdAt: now(), syncing: false
      };
      session.jobs.set(job.id, job);
      session.latestJobId = job.id;
      activeImports++;
      json(res, 202, { jobId: job.id });
      void performImport(session, job);
      return;
    }
    match = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)(?:\/(images|captions)(?:\/([A-Za-z0-9_-]+))?)?$/);
    if (match) {
      const session = sessionFor(req, res);
      const [, id, action, imageId] = match;
      const job = ownedJob(session, id);
      if (req.method === 'GET' && !action) { json(res, 200, publicJob(job)); return; }
      if (req.method === 'GET' && action === 'images' && imageId) {
        if (job.status !== 'ready') throw new HttpError(409, 'Wait for the import to finish.');
        const image = job.posts.find(post => post.id === imageId);
        if (!image) throw new HttpError(404, 'Image not found.');
        res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.bytes.length, 'Cache-Control': 'no-store' });
        res.end(image.bytes); return;
      }
      if (req.method === 'POST' && action === 'captions' && !imageId) {
        mutation(req, session);
        if (job.status !== 'ready' || !job.document) throw new HttpError(409, 'Create the Google Doc before adding captions.');
        if (job.syncing) throw new HttpError(409, 'Captions are already being transferred.');
        const body = await readJson(req);
        if (!Array.isArray(body.posts) || !body.posts.length || body.posts.length > 60) throw new HttpError(400, 'Send between 1 and 60 posts.');
        const updates = body.posts.map(checkedText), seen = new Set(), replacements = [], targets = [];
        for (const update of updates) {
          if (seen.has(update.id)) throw new HttpError(400, 'Duplicate image ID.');
          seen.add(update.id);
          const post = job.posts.find(value => value.id === update.id);
          if (!post) throw new HttpError(400, 'Image does not belong to this import.');
          for (const field of ['caption', 'hashtags']) {
            const value = update[field];
            if (!value) continue;
            if (post.synced[field] && post.synced[field] !== value) throw new HttpError(409, 'This text was already sent. Edit it directly in Google Docs to preserve document changes.');
            if (!post.synced[field]) { replacements.push({ text: post.placeholders[field], replaceText: value }); targets.push({ post, field, value }); }
          }
        }
        const syncState = () => job.posts.map(post => ({
          id: post.id, syncedCaption: post.synced.caption || '', syncedHashtags: post.synced.hashtags || ''
        }));
        if (!replacements.length) { json(res, 200, { updated: 0, document: job.document, posts: syncState() }); return; }
        job.syncing = true;
        try {
          const googleToken = await accessToken(session, 'google');
          const counts = await providers.fillGoogleCaptions(job.document.id, googleToken, replacements, { fetchImpl: linkedFetch });
          let updated = 0, missing = false;
          targets.forEach((target, index) => {
            if (counts[index] === 1) { target.post.synced[target.field] = target.value; updated++; }
            else missing = true;
          });
          if (missing) throw new HttpError(409, 'Some caption placeholders were missing or duplicated in Google Docs. Check the document before continuing; confirmed replacements were retained.');
          json(res, 200, { updated, document: job.document, posts: syncState() });
        } finally { job.syncing = false; }
        return;
      }
    }
    throw new HttpError(404, 'Route not found.');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.headersSent) { res.end(); return; }
      json(res, Number.isInteger(error.status) ? error.status : 502,
        { error: error instanceof HttpError ? error.message : 'The service could not complete this action. Please retry.' });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 1000;
  return {
    server,
    async close() {
      closed = true; shutdown.abort(); clearInterval(cleanup); sessions.clear();
      server.closeIdleConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const providers = await import('./providers.mjs');
  const config = readConfig();
  const app = createApp({ config, providers });
  app.server.listen(config.port, config.host, () => {
    console.log('Feed Studio server started on port ' + app.server.address().port + '.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
}
