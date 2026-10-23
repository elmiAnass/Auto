import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as defaultProviders from './providers.mjs';
import * as defaultWorkflowProviders from './google-workflow.mjs';
import { parsePlanningUrl, encodeMetadata, decodeMetadata, checkedPlanningRows, orderedPosts, exportDigest, WorkflowDataError } from './workflow-data.mjs';

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

function codespacesOrigin(env, port) {
  if (!env.CODESPACE_NAME) return '';
  const name = env.CODESPACE_NAME;
  const domain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  if (typeof name !== 'string' || !label.test(name) || !label.test(name + '-' + port) ||
      typeof domain !== 'string' || domain.length > 253 || !domain.split('.').every(part => label.test(part))) {
    throw new Error('Invalid Codespaces forwarding configuration.');
  }
  return 'https://' + name + '-' + port + '.' + domain;
}

export function readConfig(env = process.env) {
  const port = Number(env.FEED_STUDIO_PORT || env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid FEED_STUDIO_PORT.');
  const publicOrigin = env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL || codespacesOrigin(env, port) || 'http://127.0.0.1:' + port;
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
    host: env.FEED_STUDIO_HOST || (env.CODESPACE_NAME || env.RENDER_EXTERNAL_URL ? '0.0.0.0' : '127.0.0.1'),
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

function originLabel(value) {
  if (value === 'null') return 'null';
  try {
    const parsed = new URL(value);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.origin === value) return parsed.origin;
  } catch { /* Do not echo malformed headers. */ }
  return 'invalid';
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

function publicJob(job) {
  const documentCurrent = Boolean(job.document && job.workflow && job.posts.length === job.workflow.images.length &&
    exportDigest(job.workflow, job.posts) === job.workflow.export.hash);
  return {
    id: job.id, status: job.status, operation: job.operation, stage: job.stage,
    title: job.title, orderMode: job.orderMode,
    ...(job.error ? { error: job.error } : {}),
    ...(job.sheet ? { sheet: job.sheet } : {}),
    ...(job.folder ? { folder: job.folder } : {}),
    ...(job.document ? { document: job.document, documentCurrent } : {}),
    ...(job.reused !== undefined ? { reused: job.reused } : {}),
    posts: job.posts.map(post => ({
      id: post.id, name: post.name, mime: post.mime, width: post.width, height: post.height,
      sourceIndex: post.sourceIndex, publication: post.publication,
      caption: post.caption || '', hashtags: post.hashtags || ''
    }))
  };
}

function safeMessage(error) {
  if (error instanceof HttpError || error instanceof WorkflowDataError ||
      error instanceof defaultProviders.ProviderError || error instanceof defaultWorkflowProviders.WorkflowProviderError) {
    return error.message;
  }
  // Internal failures must never echo provider response bodies or credentials.
  return 'Le traitement a échoué. Réessayez depuis le planning enregistré dans Google Sheets.';
}

export function createApp({ config = readConfig(), providers = defaultProviders,
  workflowProviders = defaultWorkflowProviders, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const sessions = new Map(), exportingSheets = new Set();
  const shutdown = new AbortController();
  let closed = false, activeImports = 0;
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
      if (sessions.size >= 100) throw new HttpError(503, 'Le serveur est occupé. Réessayez dans un instant.');
      const id = token();
      session = { id, csrfToken: token(), lastSeen: now(), oauth: {}, tokens: {}, jobs: new Map(), latestJobId: null };
      sessions.set(id, session);
      res.setHeader('Set-Cookie', COOKIE + '=' + id + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(ttl / 1000) +
        (config.publicOrigin.startsWith('https:') ? '; Secure' : ''));
    }
    if (session) session.lastSeen = now();
    if (!session) throw new HttpError(401, 'Ouvrez l’application et reconnectez votre compte Google.');
    return session;
  }

  function json(res, code, value) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  async function readJson(req) {
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Envoyez des données JSON.');
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > MAX_BODY) throw new HttpError(413, 'La demande est trop volumineuse.');
      chunks.push(chunk);
    }
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
      return result;
    } catch { throw new HttpError(400, 'La demande doit être un objet JSON.'); }
  }

  function mutation(req, session) {
    if (req.headers.origin && req.headers.origin !== config.publicOrigin) {
      throw new HttpError(403, 'Unexpected request origin. Expected ' + config.publicOrigin +
        '; received ' + originLabel(req.headers.origin) + '. Ouvrez l’adresse configurée ou corrigez PUBLIC_ORIGIN, puis redémarrez le serveur.');
    }
    if (!equalSecret(req.headers['x-csrf-token'], session.csrfToken)) throw new HttpError(403, 'Actualisez la page avant de réessayer.');
  }

  async function accessToken(session, provider) {
    let saved = session.tokens[provider];
    if (!saved) throw new HttpError(401, 'Connectez ' + (provider === 'canva' ? 'Canva' : 'Google') + ' pour continuer.');
    if (saved.expiresAt && saved.expiresAt < now() + 60_000) {
      if (!saved.refreshToken) { delete session.tokens[provider]; throw new HttpError(401, 'Reconnectez ' + provider + '.'); }
      try {
        const refreshed = await providers.refreshOAuthToken(provider, config, { refreshToken: saved.refreshToken, fetchImpl: linkedFetch });
        saved = { ...refreshed, refreshToken: refreshed.refreshToken || saved.refreshToken };
        session.tokens[provider] = saved;
      } catch {
        delete session.tokens[provider];
        throw new HttpError(401, 'La connexion à ' + provider + ' a expiré. Reconnectez ce compte.');
      }
    }
    return saved.accessToken;
  }

  function ownedJob(session, id) {
    const job = session.jobs.get(id);
    if (!job) throw new HttpError(404, 'Ce suivi a expiré. Reprenez le planning avec son lien Google Sheets.');
    return job;
  }

  function checkedTitle(value) {
    if (value === undefined || value === '') return 'Instagram feed';
    if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, 'Le nom du projet doit contenir au maximum 100 caractères.');
    return value.trim() || 'Instagram feed';
  }

  function newJob(session, operation, extra = {}) {
    if ([...session.jobs.values()].some(job => job.status === 'running')) throw new HttpError(409, 'Un traitement est déjà en cours. Suivez son avancement avant de continuer.');
    if (activeImports >= 3) throw new HttpError(503, 'Le serveur traite déjà plusieurs plannings. Réessayez dans un instant.');
    while (session.jobs.size >= 2) session.jobs.delete(session.jobs.keys().next().value);
    const job = { id: token(), status: 'running', operation, stage: 'Préparation…', title: 'Instagram feed', orderMode: 'GRID', posts: [], ...extra };
    session.jobs.set(job.id, job);
    session.latestJobId = job.id;
    activeImports++;
    return job;
  }

  function retainImage(job, post) {
    const ownBytes = job.posts.reduce((sum, value) => sum + value.bytes.byteLength, 0);
    if (ownBytes + post.bytes.byteLength > MAX_TOTAL) throw new HttpError(413, 'Le feed dépasse 40 Mo. Utilisez un lot plus petit.');
    let allBytes = 0;
    for (const session of sessions.values()) for (const item of session.jobs.values()) {
      allBytes += item.posts.reduce((sum, value) => sum + value.bytes.byteLength, 0);
    }
    if (allBytes + post.bytes.byteLength > 128 * 1024 * 1024) throw new HttpError(503, 'Le cache des images est plein. Réessayez plus tard ou reprenez un planning enregistré.');
    job.posts.push(post);
  }

  function photoMetadata(post) {
    return Object.fromEntries(['id', 'fileId', 'mime', 'width', 'height', 'sourceIndex', 'publication', 'name', 'sha256'].map(key => [key, post[key]]));
  }

  function attachWorkflow(job, workflow, sheetId, posts) {
    job.workflow = workflow;
    job.title = workflow.title;
    job.orderMode = workflow.orderMode;
    job.sheet = { id: sheetId, url: 'https://docs.google.com/spreadsheets/d/' + sheetId + '/edit' };
    job.folder = { id: workflow.folderId, url: 'https://drive.google.com/drive/folders/' + workflow.folderId };
    if (workflow.export.documentId) job.document = { id: workflow.export.documentId, url: 'https://docs.google.com/document/d/' + workflow.export.documentId + '/edit' };
    else delete job.document;
    if (posts) job.posts = posts;
  }

  async function trashNewFile(id, session) {
    if (!id) return true;
    try {
      await workflowProviders.deleteDriveFile(id, await accessToken(session, 'google'), { fetchImpl: linkedFetch });
      return true;
    } catch { return false; }
  }

  async function performImport(session, job) {
    let folderId = '', createdSheetId = '';
    try {
      job.stage = 'Ouverture du design Canva…';
      const resolved = await providers.resolveCanvaDesign(job.canvaUrl, { fetchImpl: linkedFetch });
      job.stage = 'Export des pages Canva en PNG…';
      const urls = await providers.exportCanvaPages(resolved.designId, await accessToken(session, 'canva'), {
        fetchImpl: linkedFetch, onProgress: () => { job.stage = 'Export des pages Canva en PNG…'; }
      });
      if (!Array.isArray(urls) || !urls.length || urls.length > 60) throw new HttpError(400, 'Le design doit contenir entre 1 et 60 pages.');
      for (let index = 0; index < urls.length; index++) {
        if (closed) throw new HttpError(503, 'Le serveur a été arrêté.');
        job.stage = 'Récupération de la photo ' + (index + 1) + ' / ' + urls.length + '…';
        let image;
        try { image = await downloadImage(urls[index], linkedFetch, AbortSignal.timeout(30_000)); }
        catch (error) { throw new HttpError(422, error.message); }
        retainImage(job, {
          ...image, id: randomBytes(12).toString('hex'), sourceIndex: index + 1,
          publication: job.orderMode === 'GRID' ? urls.length - index : index + 1,
          name: String(index + 1).padStart(2, '0') + (image.mime === 'image/png' ? '.png' : '.jpg'),
          sha256: createHash('sha256').update(image.bytes).digest('hex'), caption: '', hashtags: ''
        });
      }
      job.stage = 'Création du dossier privé dans Google Drive…';
      folderId = await workflowProviders.createDriveFolder(job.title, await accessToken(session, 'google'), { fetchImpl: linkedFetch });
      for (const post of job.posts) {
        job.stage = 'Enregistrement de la photo ' + post.sourceIndex + ' / ' + job.posts.length + ' dans Drive…';
        post.fileId = await workflowProviders.uploadDriveImage(post, folderId, await accessToken(session, 'google'), { fetchImpl: linkedFetch });
      }
      const workflow = {
        title: job.title, orderMode: job.orderMode, canvaUrl: job.canvaUrl, folderId,
        images: job.posts.map(photoMetadata), export: { hash: '', documentId: '' }
      };
      const metadataRows = encodeMetadata(workflow);
      job.stage = 'Préparation du planning Google Sheets…';
      const sheet = await workflowProviders.createPlanningSheet({
        title: job.title, rows: orderedPosts(job.posts, job.orderMode), metadataRows, folderId
      }, await accessToken(session, 'google'), { fetchImpl: linkedFetch });
      createdSheetId = sheet.id;
      if (!createdSheetId || !/^[A-Za-z0-9_-]{5,200}$/.test(createdSheetId)) throw new HttpError(502, 'Google n’a pas retourné un planning valide.');
      attachWorkflow(job, workflow, createdSheetId);
      job.stage = 'Planning prêt. Rédigez vos captions et hashtags dans Google Sheets.';
      job.status = 'ready';
    } catch (error) {
      const sheetClean = createdSheetId ? await trashNewFile(createdSheetId, session) : true;
      const folderClean = folderId ? await trashNewFile(folderId, session) : true;
      job.status = 'error'; job.error = safeMessage(error);
      if (!sheetClean || !folderClean) job.error += ' Un dossier partiel peut rester dans Drive ; vérifiez-le avant de recommencer.';
      job.stage = 'Création du planning interrompue'; job.posts = [];
    } finally { activeImports--; }
  }

  async function readWorkflow(session, sheetId) {
    const result = await workflowProviders.readPlanningSheet(sheetId, await accessToken(session, 'google'), { fetchImpl: linkedFetch });
    const workflow = decodeMetadata(result.metadataRows);
    const posts = checkedPlanningRows(result.rows, workflow);
    return { workflow, posts };
  }

  async function performResume(session, job, sheetId) {
    try {
      job.stage = 'Lecture du planning Google Sheets…';
      const { workflow, posts } = await readWorkflow(session, sheetId);
      attachWorkflow(job, workflow, sheetId);
      job.posts = [];
      for (const post of posts) {
        job.stage = 'Ouverture de la photo ' + post.sourceIndex + ' / ' + posts.length + '…';
        const saved = await workflowProviders.readDriveImage(post.fileId, await accessToken(session, 'google'), { fetchImpl: linkedFetch });
        let image;
        try { image = imageDimensions(Buffer.from(saved.bytes)); }
        catch { throw new HttpError(422, 'Une photo enregistrée n’est plus une image valide.'); }
        if (saved.mime !== post.mime || image.mime !== post.mime || image.width !== post.width || image.height !== post.height ||
            createHash('sha256').update(saved.bytes).digest('hex') !== post.sha256) {
          throw new HttpError(422, 'Une photo a été modifiée dans Drive. Reprenez les fichiers originaux ou créez un nouveau planning.');
        }
        retainImage(job, { ...post, bytes: saved.bytes });
      }
      job.status = 'ready'; job.stage = 'Planning retrouvé. Vos photos et vos textes sont prêts.';
    } catch (error) {
      job.status = 'error'; job.error = safeMessage(error); job.stage = 'Reprise du planning interrompue'; job.posts = [];
    } finally { activeImports--; }
  }

  async function refreshWorkflow(session, job) {
    const { workflow, posts } = await readWorkflow(session, job.sheet.id);
    const current = new Map(job.posts.map(post => [post.id, post]));
    if (posts.length !== current.size || workflow.folderId !== job.workflow.folderId || workflow.orderMode !== job.workflow.orderMode ||
        posts.some(post => {
          const saved = current.get(post.id);
          return !saved || ['fileId', 'sha256', 'sourceIndex', 'publication', 'mime', 'width', 'height'].some(key => saved[key] !== post[key]);
        })) throw new HttpError(409, 'Les références des photos ont changé. Reprenez le planning depuis son lien Google Sheets.');
    const merged = posts.map(post => ({ ...post, bytes: current.get(post.id).bytes }));
    attachWorkflow(job, workflow, job.sheet.id, merged);
    return { workflow, posts: merged };
  }

  async function performExport(session, job) {
    let newDocumentId = '';
    try {
      job.stage = 'Lecture des dernières captions dans Google Sheets…';
      const { workflow, posts } = await refreshWorkflow(session, job);
      const hash = exportDigest(workflow, posts);
      if (workflow.export.hash === hash && workflow.export.documentId &&
          await workflowProviders.googleFileExists(workflow.export.documentId, await accessToken(session, 'google'), { fetchImpl: linkedFetch })) {
        job.reused = true;
        job.document = { id: workflow.export.documentId, url: 'https://docs.google.com/document/d/' + workflow.export.documentId + '/edit' };
        job.stage = 'Le Google Doc est déjà à jour. Les modifications faites dans Docs sont conservées.';
        job.status = 'ready'; return;
      }
      job.stage = 'Mise en page du document…';
      const docx = await buildDocument(orderedPosts(posts, workflow.orderMode), { title: workflow.title });
      job.stage = 'Création du Google Doc privé…';
      const created = await providers.createGoogleDocument(new Uint8Array(await docx.arrayBuffer()), await accessToken(session, 'google'), {
        title: workflow.title, folderId: workflow.folderId, fetchImpl: linkedFetch
      });
      if (!created || typeof created.id !== 'string' || !/^[A-Za-z0-9_-]{5,200}$/.test(created.id)) throw new HttpError(502, 'Google n’a pas retourné un document valide.');
      newDocumentId = created.id;
      const updated = { ...workflow, export: { hash, documentId: newDocumentId } };
      job.stage = 'Enregistrement du document dans le planning…';
      await workflowProviders.updatePlanningMetadata(job.sheet.id, encodeMetadata(updated), await accessToken(session, 'google'), { fetchImpl: linkedFetch });
      job.workflow = updated;
      job.document = { id: created.id, url: 'https://docs.google.com/document/d/' + created.id + '/edit' };
      job.reused = false; job.status = 'ready'; job.stage = 'Google Doc prêt. Les versions précédentes sont conservées.';
    } catch (error) {
      let cleaned = true;
      if (newDocumentId) cleaned = await trashNewFile(newDocumentId, session);
      job.error = safeMessage(error);
      if (!cleaned) job.error += ' Un nouveau document peut rester dans Drive ; vérifiez le dossier du projet.';
      job.status = 'ready'; job.stage = 'Le document n’a pas pu être créé. Le planning et les photos sont conservés.';
    } finally { exportingSheets.delete(job.sheet.id); }
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url, 'http://internal.invalid');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html); return;
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && url.pathname === '/healthz') { json(res, 200, { ok: true }); return; }
    if (req.method === 'GET' && url.pathname === '/api/session') {
      const session = sessionFor(req, res, true);
      json(res, 200, {
        serverMode: true, publicOrigin: config.publicOrigin, csrfToken: session.csrfToken,
        configured: { canva: isConfigured('canva'), google: isConfigured('google') },
        connected: { canva: Boolean(session.tokens.canva), google: Boolean(session.tokens.google) },
        ...(session.latestJobId ? { latestJobId: session.latestJobId } : {})
      }); return;
    }
    let match = url.pathname.match(/^\/oauth\/(start|callback)\/(canva|google)$/);
    if (req.method === 'GET' && match) {
      const [, action, provider] = match;
      const session = sessionFor(req, res, action === 'start');
      if (!isConfigured(provider)) throw new HttpError(503, 'Configurez les identifiants ' + provider + ' dans le fichier .env avant de connecter ce compte.');
      if (action === 'start') {
        const state = token(), codeVerifier = token() + token();
        session.oauth[provider] = { state, codeVerifier, expiresAt: now() + OAUTH_TTL };
        const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
        const destination = providers.oauthAuthorizationUrl(provider, config, { state, codeChallenge });
        res.writeHead(302, { Location: destination, 'Cache-Control': 'no-store' }); res.end(); return;
      }
      const pending = session.oauth[provider];
      if (!pending || pending.expiresAt < now() || !equalSecret(url.searchParams.get('state'), pending.state)) {
        throw new HttpError(400, 'La connexion a expiré. Revenez à l’application et relancez la connexion.');
      }
      delete session.oauth[provider];
      if (url.searchParams.has('error')) {
        if (url.searchParams.get('error') === 'invalid_scope') throw new HttpError(400, provider === 'canva'
          ? 'Activez design:content:read dans la même intégration Canva, enregistrez, puis relancez la connexion.'
          : 'Vérifiez la permission drive.file de cette application Google, puis relancez la connexion.');
        throw new HttpError(400, 'Le compte n’a pas accordé l’accès. Relancez la connexion depuis l’application.');
      }
      const code = url.searchParams.get('code');
      if (!code) throw new HttpError(400, 'Le service est revenu sans code d’autorisation. Relancez la connexion depuis l’application.');
      try {
        session.tokens[provider] = await providers.exchangeOAuthCode(provider, config, { code, codeVerifier: pending.codeVerifier, fetchImpl: linkedFetch });
      } catch { throw new HttpError(502, 'La connexion à ' + provider + ' a échoué. Vérifiez ses identifiants et son URL de retour.'); }
      res.writeHead(302, { Location: '/?connected=' + provider, 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (req.method === 'POST' && (url.pathname === '/api/import' || url.pathname === '/api/resume')) {
      const session = sessionFor(req, res); mutation(req, session);
      const body = await readJson(req);
      if (!isConfigured('google') || !session.tokens.google) throw new HttpError(401, 'Connectez Google pour créer ou reprendre votre planning.');
      if (url.pathname === '/api/import') {
        if (!isConfigured('canva') || !session.tokens.canva) throw new HttpError(401, 'Connectez Canva pour importer ses photos.');
        if (typeof body.url !== 'string') throw new HttpError(400, 'Collez le lien de votre design Canva.');
        try { providers.validateCanvaUrl(body.url); } catch { throw new HttpError(400, 'Le lien doit ouvrir un design Canva.'); }
        if (!['GRID', 'PUBLICATION'].includes(body.orderMode)) throw new HttpError(400, 'Choisissez l’ordre des photos.');
        const job = newJob(session, 'import', { title: checkedTitle(body.title), orderMode: body.orderMode, canvaUrl: body.url });
        json(res, 202, { jobId: job.id }); void performImport(session, job); return;
      }
      const { id } = parsePlanningUrl(body.sheetUrl);
      const job = newJob(session, 'resume');
      json(res, 202, { jobId: job.id }); void performResume(session, job, id); return;
    }
    match = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)(?:\/(images|refresh|export)(?:\/([A-Za-z0-9_-]+))?)?$/);
    if (match) {
      const session = sessionFor(req, res);
      const [, id, action, imageId] = match;
      const job = ownedJob(session, id);
      if (req.method === 'GET' && !action) { json(res, 200, publicJob(job)); return; }
      if (req.method === 'GET' && action === 'images' && imageId) {
        if (job.status === 'error' || !job.sheet) throw new HttpError(409, 'Attendez la préparation du planning.');
        const image = job.posts.find(post => post.id === imageId);
        if (!image) throw new HttpError(404, 'Photo introuvable.');
        res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.bytes.byteLength, 'Cache-Control': 'no-store' });
        res.end(image.bytes); return;
      }
      if (req.method === 'POST' && ['refresh', 'export'].includes(action) && !imageId) {
        mutation(req, session);
        await readJson(req);
        if (job.status !== 'ready' || !job.sheet) throw new HttpError(409, 'Attendez la fin du traitement en cours.');
        if (!session.tokens.google) throw new HttpError(401, 'Reconnectez Google pour ouvrir votre planning.');
        if (exportingSheets.has(job.sheet.id)) throw new HttpError(409, 'Un document est déjà en cours de création pour ce planning.');
        if (action === 'refresh') {
          exportingSheets.add(job.sheet.id);
          try {
            await refreshWorkflow(session, job); delete job.error;
            job.stage = 'Textes actualisés depuis Google Sheets.';
            json(res, 200, publicJob(job));
          } finally { exportingSheets.delete(job.sheet.id); }
          return;
        }
        exportingSheets.add(job.sheet.id);
        job.status = 'running'; job.operation = 'export'; job.stage = 'Préparation du Google Doc…';
        delete job.error; delete job.reused;
        json(res, 202, { jobId: job.id }); void performExport(session, job); return;
      }
    }
    throw new HttpError(404, 'Ressource introuvable.');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) { res.end(); return; }
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
      json(res, status, { error: safeMessage(error) });
    });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 1000;
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
  const config = readConfig();
  const app = createApp({ config });
  app.server.once('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'Le port est déjà utilisé. Arrêtez l’autre serveur avant de lancer npm start.' : 'Le serveur n’a pas pu démarrer. Vérifiez le port et la configuration.');
    void app.close(); process.exitCode = 1;
  });
  app.server.listen(config.port, config.host, () => {
    console.log('Feed Studio : ' + config.publicOrigin);
    console.log('Gardez ce terminal ouvert. Arrêt : Ctrl+C.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
}
