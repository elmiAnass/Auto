import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

const CANVA_API = 'https://api.canva.com/rest/v1';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const CANVA_HOSTS = new Set(['canva.link', 'www.canva.com', 'canva.com']);

export class ProviderError extends Error {
  constructor(message, { provider, status = 502 } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
  }
}

function fail(message, provider, status = 502) {
  return new ProviderError(message, { provider, status });
}

function providerInfo(provider) {
  if (provider === 'canva') return {
    auth: 'https://www.canva.com/api/oauth/authorize',
    token: CANVA_API + '/oauth/token',
    scopes: 'design:content:read',
  };
  if (provider === 'google') return {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: GOOGLE_TOKEN,
    scopes: 'https://www.googleapis.com/auth/drive.file',
  };
  throw fail('Unknown account provider.', undefined, 400);
}

function callbackUrl(provider, config) {
  let origin;
  try { origin = new URL(config.publicOrigin); }
  catch { throw fail('The public application URL is not configured.', provider, 503); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local)) ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw fail('The public application URL must be an HTTPS origin or local development origin.', provider, 503);
  }
  return origin.origin + '/oauth/callback/' + provider;
}

function clientInfo(provider, config) {
  const id = provider === 'canva' ? config.canvaClientId : config.googleClientId;
  const secret = provider === 'canva' ? config.canvaClientSecret : config.googleClientSecret;
  const authorization = provider === 'canva' ? config.canvaClientAuthorization : undefined;
  if (!id || (!secret && !authorization)) throw fail((provider === 'canva' ? 'Canva' : 'Google') + ' connection is not configured.', provider, 503);
  return { id, secret, authorization };
}

async function request(url, options, provider, fetchImpl = fetch) {
  try {
    return await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), ...options });
  } catch {
    throw fail((provider === 'canva' ? 'Canva' : 'Google') + ' could not be reached. Please retry later.', provider);
  }
}

async function json(response, provider) {
  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : 502;
    const name = provider === 'canva' ? 'Canva' : 'Google';
    const hint = status === 401 ? 'Reconnect your account.' :
      status === 403 ? 'Check the account permissions and access to this design or document.' :
      status === 429 ? 'The service quota was reached; retry later.' : 'Please retry or check the connection settings.';
    throw fail(name + ' returned HTTP ' + status + '. ' + hint, provider, status);
  }
  let body;
  try { body = await response.json(); }
  catch { throw fail((provider === 'canva' ? 'Canva' : 'Google') + ' returned an unreadable response.', provider); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('The account service returned invalid data.', provider);
  return body;
}

export function validateCanvaUrl(input) {
  if (typeof input !== 'string' || input.length > 4096) throw fail('Paste a valid Canva design link.', 'canva', 400);
  let url;
  try { url = new URL(input.trim()); }
  catch { throw fail('Paste a valid Canva design link.', 'canva', 400); }
  if (url.protocol !== 'https:' || !CANVA_HOSTS.has(url.hostname) || url.username || url.password ||
      (url.port && url.port !== '443')) {
    throw fail('Only HTTPS Canva design and canva.link URLs are accepted.', 'canva', 400);
  }
  if (url.hostname === 'canva.link') {
    if (!/^\/[A-Za-z0-9_-]{1,200}\/?$/.test(url.pathname)) throw fail('Paste a valid Canva short link.', 'canva', 400);
  } else if (!/^\/design\/[A-Za-z0-9_-]{5,100}(?:\/|$)/.test(url.pathname)) {
    throw fail('Paste the link to a Canva design, not an account or login page.', 'canva', 400);
  }
  url.hash = '';
  return url;
}

export async function resolveCanvaDesign(input, { fetchImpl = fetch } = {}) {
  let url = validateCanvaUrl(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.hostname !== 'canva.link') {
      const match = url.pathname.match(/^\/design\/([A-Za-z0-9_-]{5,100})(?:\/|$)/);
      return { designId: match[1], url: url.href };
    }
    const response = await request(url.href, { method: 'GET', redirect: 'manual', headers: { Accept: 'text/html' } }, 'canva', fetchImpl);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get('location');
      if (!location || redirects === 5) throw fail('The Canva short link could not be resolved.', 'canva', 400);
      let next;
      try { next = new URL(location, url); }
      catch { throw fail('The Canva short link returned an invalid destination.', 'canva', 400); }
      url = validateCanvaUrl(next.href);
      continue;
    }
    if (!response.ok) {
      const status = Number.isInteger(response.status) ? response.status : 502;
      throw fail('The Canva link returned HTTP ' + status + '. Check the link and account access.', 'canva', status);
    }
    throw fail('The short link did not redirect to a Canva design. Use the full design URL.', 'canva', 400);
  }
  throw fail('The Canva short link could not be resolved.', 'canva', 400);
}

export function oauthAuthorizationUrl(provider, config, { state, codeChallenge }) {
  const info = providerInfo(provider);
  const { id } = clientInfo(provider, config);
  if (!state || !codeChallenge) throw fail('The account connection request is invalid.', provider, 400);
  const url = new URL(info.auth);
  url.search = new URLSearchParams({
    client_id: id,
    redirect_uri: callbackUrl(provider, config),
    response_type: 'code',
    scope: info.scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  if (provider === 'google') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
  }
  return url.href;
}

function normalizeToken(body, previousRefresh, provider) {
  if (typeof body.access_token !== 'string' || !body.access_token ||
      !Number.isFinite(body.expires_in) || body.expires_in <= 0 ||
      (body.token_type && String(body.token_type).toLowerCase() !== 'bearer')) {
    throw fail('The account service returned an invalid access token.', provider);
  }
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : previousRefresh;
  return { accessToken: body.access_token, refreshToken: refreshToken || null, expiresAt: Date.now() + body.expires_in * 1000 };
}

async function tokenRequest(provider, config, params, fetchImpl) {
  const info = providerInfo(provider);
  const client = clientInfo(provider, config);
  const body = new URLSearchParams(params);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  // Both providers officially support body credentials. Keeping them out of
  // Base64 also allows a scoped network proxy to substitute a secret binding.
  if (provider === 'canva' && client.authorization) headers.Authorization = client.authorization;
  else {
    body.set('client_id', client.id);
    body.set('client_secret', client.secret);
  }
  const response = await request(info.token, { method: 'POST', headers, body: body.toString() }, provider, fetchImpl);
  return json(response, provider);
}

export async function exchangeOAuthCode(provider, config, { code, codeVerifier, fetchImpl = fetch }) {
  if (!code || !codeVerifier) throw fail('The account connection response is invalid.', provider, 400);
  const body = await tokenRequest(provider, config, {
    grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: callbackUrl(provider, config),
  }, fetchImpl);
  return normalizeToken(body, null, provider);
}

export async function refreshOAuthToken(provider, config, { refreshToken, fetchImpl = fetch }) {
  if (!refreshToken) throw fail('Reconnect your account to continue.', provider, 401);
  const body = await tokenRequest(provider, config, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);
  return normalizeToken(body, refreshToken, provider);
}

function designId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{5,100}$/.test(value)) throw fail('The Canva design ID is invalid.', 'canva', 400);
  return value;
}

function bearer(accessToken, provider) {
  if (typeof accessToken !== 'string' || !accessToken || /[\r\n]/.test(accessToken)) throw fail('Reconnect your account to continue.', provider, 401);
  return { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' };
}

function completedExport(body) {
  const job = body.job;
  if (!job || typeof job !== 'object' || typeof job.id !== 'string' || !job.id ||
      !['in_progress', 'success', 'failed'].includes(job.status)) throw fail('Canva returned an invalid export job.', 'canva');
  if (job.status === 'failed') throw fail('Canva could not export this design. Check your design permissions and any premium-content requirements.', 'canva', 422);
  if (job.status !== 'success') return null;
  if (!Array.isArray(job.urls) || !job.urls.length || job.urls.length > 60) throw fail('Use a Canva design with 1 to 60 image pages.', 'canva', 422);
  return job.urls.map(value => {
    let url;
    try { url = new URL(value); } catch { throw fail('Canva returned an invalid download URL.', 'canva'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
      throw fail('Canva returned an unsupported download URL.', 'canva');
    }
    return url.href;
  });
}

export async function exportCanvaPages(value, accessToken, {
  fetchImpl = fetch, onProgress = () => {}, sleep = pause, maxPolls = 90,
} = {}) {
  const id = designId(value);
  if (!Number.isInteger(maxPolls) || maxPolls < 0 || maxPolls > 300) throw fail('Invalid export polling configuration.', 'canva', 400);
  const headers = { ...bearer(accessToken, 'canva'), 'Content-Type': 'application/json' };
  let body = await json(await request(CANVA_API + '/exports', {
    method: 'POST', headers,
    body: JSON.stringify({ design_id: id, format: { type: 'png', lossless: true, as_single_image: false } }),
  }, 'canva', fetchImpl), 'canva');
  let urls = completedExport(body);
  onProgress({ stage: 'exporting', status: body.job.status, polls: 0 });
  if (urls) return urls;
  const exportId = body.job.id;
  for (let polls = 1; polls <= maxPolls; polls++) {
    await sleep(1000);
    body = await json(await request(CANVA_API + '/exports/' + encodeURIComponent(exportId), {
      method: 'GET', headers: bearer(accessToken, 'canva'),
    }, 'canva', fetchImpl), 'canva');
    if (body.job?.id !== exportId) throw fail('Canva returned a different export job.', 'canva');
    urls = completedExport(body);
    onProgress({ stage: 'exporting', status: body.job.status, polls });
    if (urls) return urls;
  }
  throw fail('Canva export is taking too long. Please retry later.', 'canva', 504);
}

export async function createGoogleDocument(docxBytes, accessToken, { title = 'Instagram feed', fetchImpl = fetch } = {}) {
  if (!(docxBytes instanceof Uint8Array) || !docxBytes.length || docxBytes.byteLength > 45 * 1024 * 1024) {
    throw fail('The review document must contain data and be smaller than 45 MB.', 'google', 400);
  }
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw fail('Use a document title of 1 to 200 characters.', 'google', 400);
  const boundary = 'feedstudio_' + randomBytes(18).toString('hex');
  const metadata = JSON.stringify({ name: title.trim(), mimeType: 'application/vnd.google-apps.document' });
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + metadata + '\r\n'),
    Buffer.from('--' + boundary + '\r\nContent-Type: ' + DOCX_TYPE + '\r\n\r\n'),
    Buffer.from(docxBytes), Buffer.from('\r\n--' + boundary + '--\r\n'),
  ]);
  const response = await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id%2CwebViewLink', {
    method: 'POST', headers: { ...bearer(accessToken, 'google'), 'Content-Type': 'multipart/related; boundary=' + boundary }, body,
  }, 'google', fetchImpl);
  const result = await json(response, 'google');
  if (typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{5,200}$/.test(result.id)) throw fail('Google did not return a document ID.', 'google');
  return { id: result.id, url: 'https://docs.google.com/document/d/' + result.id + '/edit' };
}

export async function fillGoogleCaptions(documentId, accessToken, replacements, { fetchImpl = fetch } = {}) {
  if (typeof documentId !== 'string' || !/^[A-Za-z0-9_-]{5,200}$/.test(documentId)) throw fail('The Google document ID is invalid.', 'google', 400);
  if (!Array.isArray(replacements) || replacements.length > 120) throw fail('Use at most 120 text replacements.', 'google', 400);
  const seen = new Set();
  const requests = replacements.map(item => {
    if (!item || typeof item.text !== 'string' || !item.text || item.text.length > 250 ||
        typeof item.replaceText !== 'string' || item.replaceText.length > 1500 || seen.has(item.text)) {
      throw fail('The caption replacement data is invalid or ambiguous.', 'google', 400);
    }
    seen.add(item.text);
    return { replaceAllText: { containsText: { text: item.text, matchCase: true }, replaceText: item.replaceText } };
  });
  if (!requests.length) return [];
  const response = await request('https://docs.googleapis.com/v1/documents/' + encodeURIComponent(documentId) + ':batchUpdate', {
    method: 'POST', headers: { ...bearer(accessToken, 'google'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  }, 'google', fetchImpl);
  const result = await json(response, 'google');
  if (!Array.isArray(result.replies) || result.replies.length !== requests.length) throw fail('Google returned incomplete caption update results.', 'google');
  return result.replies.map(reply => {
    const count = reply?.replaceAllText?.occurrencesChanged ?? 0;
    if (!Number.isInteger(count) || count < 0) throw fail('Google returned invalid caption update results.', 'google');
    return count;
  });
}
