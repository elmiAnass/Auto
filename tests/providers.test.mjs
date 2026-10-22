import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProviderError, validateCanvaUrl, resolveCanvaDesign, oauthAuthorizationUrl,
  exchangeOAuthCode, refreshOAuthToken, exportCanvaPages, createGoogleDocument, fillGoogleCaptions,
} from '../server/providers.mjs';

const config = {
  canvaClientId: 'canva-client', canvaClientSecret: 'canva-secret-for-tests-only',
  googleClientId: 'google-client', googleClientSecret: 'google-secret-for-tests-only',
  publicOrigin: 'https://feed.example',
};
const fullDesign = 'https://www.canva.com/design/DESIGN_TEST_01/sharetoken/view?utm_source=test';
const pngUrls = ['https://export-download.canva.com/page1.png?token=test', 'https://export-download.canva.com/page2.png?token=test'];
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function queue(...responses) {
  const requests = [];
  return {
    requests,
    async fetchImpl(url, options) {
      requests.push({ url, options });
      const next = responses.shift();
      assert.notEqual(next, undefined, 'Unexpected provider request');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('Canva URL validation accepts the user-facing formats and removes fragments', () => {
  assert.equal(validateCanvaUrl(fullDesign).hostname, 'www.canva.com');
  assert.equal(validateCanvaUrl('https://canva.link/example123').hostname, 'canva.link');
  assert.equal(validateCanvaUrl(fullDesign + '#secret-section').hash, '');
  assert.equal(validateCanvaUrl('https://canva.com/design/ABCDE/edit').hostname, 'canva.com');
});

test('Canva URLs cannot request arbitrary hosts, credentials, ports or account pages', () => {
  for (const input of [
    'http://www.canva.com/design/ABCDE/view', 'https://127.0.0.1/design/ABCDE/view',
    'https://www.canva.com.evil.example/design/ABCDE/view',
    'https://person:secret@www.canva.com/design/ABCDE/view',
    'https://www.canva.com:8443/design/ABCDE/view', 'https://www.canva.com/login',
    'https://canva.link/a/b', 'file:///tmp/design/ABCDE', 'not a url',
  ]) assert.throws(() => validateCanvaUrl(input), ProviderError, input);
});

test('full Canva URLs resolve IDs without requesting the private design page', async () => {
  const result = await resolveCanvaDesign(fullDesign, { fetchImpl: () => { throw new Error('Should not fetch'); } });
  assert.deepEqual(result, { designId: 'DESIGN_TEST_01', url: fullDesign });
});

test('short Canva links follow constrained redirects and do not forward an access token', async () => {
  const mock = queue(new Response(null, { status: 302, headers: { location: fullDesign } }));
  const result = await resolveCanvaDesign('https://canva.link/example123', mock);
  assert.equal(result.designId, 'DESIGN_TEST_01');
  assert.equal(mock.requests[0].options.redirect, 'manual');
  assert.equal(mock.requests[0].options.headers.Authorization, undefined);
});

test('short link redirects cannot escape Canva or become a login page', async () => {
  for (const location of ['https://evil.example/design/ABCDE/view', 'https://www.canva.com/login', 'http://www.canva.com/design/ABCDE/view']) {
    const mock = queue(new Response(null, { status: 302, headers: { location } }));
    await assert.rejects(resolveCanvaDesign('https://canva.link/example123', mock), ProviderError);
    assert.equal(mock.requests.length, 1);
  }
});

test('short link loops, denied access and HTML-only destinations fail without parsing private HTML', async () => {
  const loop = queue(...Array.from({ length: 6 }, () => new Response(null, { status: 302, headers: { location: '/loop123' } })));
  await assert.rejects(resolveCanvaDesign('https://canva.link/example123', loop), /could not be resolved/);
  assert.equal(loop.requests.length, 6);
  await assert.rejects(resolveCanvaDesign('https://canva.link/example123', queue(reply({ body: 'private' }, 403))), /HTTP 403/);
  await assert.rejects(resolveCanvaDesign('https://canva.link/example123', queue(new Response('<html>no redirect</html>'))), /full design URL/);
});

test('OAuth URLs require PKCE and read-only Canva / app-file-only Google scopes', () => {
  const canva = new URL(oauthAuthorizationUrl('canva', config, { state: 'random-state', codeChallenge: 'challenge' }));
  assert.equal(canva.origin + canva.pathname, 'https://www.canva.com/api/oauth/authorize');
  assert.equal(canva.searchParams.get('scope'), 'design:content:read');
  assert.equal(canva.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(canva.searchParams.get('redirect_uri'), 'https://feed.example/oauth/callback/canva');
  assert.ok(!canva.href.includes(config.canvaClientSecret));
  const google = new URL(oauthAuthorizationUrl('google', config, { state: 'random-state', codeChallenge: 'challenge' }));
  assert.equal(google.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(google.searchParams.get('access_type'), 'offline');
  assert.equal(google.searchParams.get('prompt'), 'consent');
  assert.equal(google.searchParams.get('redirect_uri'), 'https://feed.example/oauth/callback/google');
  assert.throws(() => oauthAuthorizationUrl('canva', config, { state: '', codeChallenge: 'challenge' }), /invalid/);
});

test('OAuth configuration rejects missing credentials and unsafe callback origins', () => {
  for (const origin of ['http://feed.example', 'https://user:password@feed.example', 'https://feed.example/subpath', 'https://feed.example/?x=1']) {
    assert.throws(() => oauthAuthorizationUrl('canva', { ...config, publicOrigin: origin }, { state: 'state', codeChallenge: 'pkce' }), /application URL/);
  }
  assert.throws(() => oauthAuthorizationUrl('unknown', config, { state: 'state', codeChallenge: 'pkce' }), /Unknown/);
  assert.throws(() => oauthAuthorizationUrl('canva', { ...config, canvaClientSecret: undefined }, { state: 'state', codeChallenge: 'pkce' }), /not configured/);
  assert.match(oauthAuthorizationUrl('google', { ...config, publicOrigin: 'http://127.0.0.1:3000' }, { state: 'state', codeChallenge: 'pkce' }), /127.0.0.1/);
});

for (const provider of ['canva', 'google']) {
  test(provider + ' code exchange carries PKCE and server-side form credentials, normalizes expiry', async () => {
    const mock = queue(reply({ access_token: 'access-only-in-server', refresh_token: 'refresh-only-in-server', token_type: 'Bearer', expires_in: 3600 }));
    const before = Date.now();
    const token = await exchangeOAuthCode(provider, config, { code: 'authorization-code', codeVerifier: 'verifier', ...mock });
    assert.equal(token.accessToken, 'access-only-in-server');
    assert.equal(token.refreshToken, 'refresh-only-in-server');
    assert.ok(token.expiresAt >= before + 3600 * 1000 && token.expiresAt < Date.now() + 3601 * 1000);
    const request = mock.requests[0];
    assert.equal(request.options.redirect, 'error');
    assert.ok(request.options.signal instanceof AbortSignal);
    const form = new URLSearchParams(request.options.body);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code_verifier'), 'verifier');
    assert.equal(form.get('client_id'), config[provider + 'ClientId']);
    assert.equal(form.get('client_secret'), config[provider + 'ClientSecret']);
    assert.equal(form.get('redirect_uri'), 'https://feed.example/oauth/callback/' + provider);
    assert.ok(!request.url.includes(config[provider + 'ClientSecret']));
  });
}

test('Canva supports a raw Basic authorization binding without encoding a proxy placeholder', async () => {
  const mock = queue(reply({ access_token: 'access', refresh_token: 'refresh', expires_in: 14400 }));
  await exchangeOAuthCode('canva', { ...config, canvaClientSecret: undefined, canvaClientAuthorization: 'proxy-full-authorization-binding' }, {
    code: 'code', codeVerifier: 'verifier', ...mock,
  });
  assert.equal(mock.requests[0].options.headers.Authorization, 'proxy-full-authorization-binding');
  const form = new URLSearchParams(mock.requests[0].options.body);
  assert.equal(form.has('client_secret'), false);
});

test('refresh rotates Canva tokens and preserves Google refresh token if omitted', async () => {
  const canva = queue(reply({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 100 }));
  assert.equal((await refreshOAuthToken('canva', config, { refreshToken: 'old-refresh', ...canva })).refreshToken, 'rotated-refresh');
  assert.equal(new URLSearchParams(canva.requests[0].options.body).get('grant_type'), 'refresh_token');
  const google = queue(reply({ access_token: 'new-access', expires_in: 100 }));
  assert.equal((await refreshOAuthToken('google', config, { refreshToken: 'old-refresh', ...google })).refreshToken, 'old-refresh');
  await assert.rejects(refreshOAuthToken('canva', config, { refreshToken: '' }), /Reconnect/);
});

test('token and network failures omit all response bodies, codes, verifiers and secrets', async () => {
  const sensitive = 'do-not-show-secret-value';
  const mock = queue(reply({ error: sensitive, error_description: sensitive }, 400));
  await assert.rejects(exchangeOAuthCode('canva', config, { code: sensitive, codeVerifier: sensitive, ...mock }), error => {
    assert.equal(error.status, 400);
    assert.ok(!error.message.includes(sensitive));
    assert.ok(!error.message.includes(config.canvaClientSecret));
    return true;
  });
  const network = queue(new Error('transport included ' + sensitive));
  await assert.rejects(exchangeOAuthCode('canva', config, { code: sensitive, codeVerifier: sensitive, ...network }), error => {
    assert.match(error.message, /could not be reached/);
    assert.ok(!error.message.includes(sensitive));
    return true;
  });
  await assert.rejects(exchangeOAuthCode('canva', config, { code: 'code', codeVerifier: 'verifier', ...queue(reply({ access_token: 'access', expires_in: -1 })) }), /invalid access token/);
});

test('Canva export starts one lossless PNG-per-page job, polls it, and preserves page URL order', async () => {
  const mock = queue(
    reply({ job: { id: 'job-id', status: 'in_progress' } }),
    reply({ job: { id: 'job-id', status: 'in_progress' } }),
    reply({ job: { id: 'job-id', status: 'success', urls: pngUrls } }),
  );
  const progress = [], sleeps = [];
  const result = await exportCanvaPages('DESIGN_TEST_01', 'canva-access', {
    ...mock, onProgress: value => progress.push(value), sleep: async ms => sleeps.push(ms),
  });
  assert.deepEqual(result, pngUrls);
  assert.deepEqual(JSON.parse(mock.requests[0].options.body), { design_id: 'DESIGN_TEST_01', format: { type: 'png', lossless: true, as_single_image: false } });
  assert.equal(mock.requests[0].options.headers.Authorization, 'Bearer canva-access');
  assert.equal(mock.requests[1].url, 'https://api.canva.com/rest/v1/exports/job-id');
  assert.deepEqual(sleeps, [1000, 1000]);
  assert.deepEqual(progress.map(item => item.status), ['in_progress', 'in_progress', 'success']);
});

test('synchronous export success needs no polling and signed URLs receive no access token here', async () => {
  const mock = queue(reply({ job: { id: 'job-id', status: 'success', urls: pngUrls } }));
  assert.deepEqual(await exportCanvaPages('DESIGN_TEST_01', 'canva-access', { ...mock, sleep: async () => assert.fail('No sleep expected') }), pngUrls);
  assert.equal(mock.requests.length, 1);
});

test('export licence/access failures are diagnosed without leaking response details', async () => {
  const mock = queue(reply({ job: { id: 'job-id', status: 'failed', error: { code: 'license_required', message: 'sensitive-upstream-message' } } }));
  await assert.rejects(exportCanvaPages('DESIGN_TEST_01', 'canva-access', mock), error => {
    assert.equal(error.status, 422);
    assert.match(error.message, /premium-content/);
    assert.ok(!error.message.includes('sensitive-upstream-message'));
    return true;
  });
  await assert.rejects(exportCanvaPages('DESIGN_TEST_01', 'canva-access', queue(reply({ error: 'private' }, 403))), /HTTP 403/);
});

test('export polling timeout, inconsistent job IDs, malformed jobs and unsafe downloads fail', async () => {
  const inProgress = () => reply({ job: { id: 'job-id', status: 'in_progress' } });
  await assert.rejects(exportCanvaPages('DESIGN_TEST_01', 'canva-access', { ...queue(inProgress()), maxPolls: 0 }), /taking too long/);
  await assert.rejects(exportCanvaPages('DESIGN_TEST_01', 'canva-access', {
    ...queue(inProgress(), reply({ job: { id: 'other-job', status: 'success', urls: pngUrls } })), sleep: async () => {},
  }), /different export job/);
  for (const job of [null, { id: 'id', status: 'unknown' }, { id: 'id', status: 'success', urls: [] },
    { id: 'id', status: 'success', urls: ['http://export-download.canva.com/image.png'] },
    { id: 'id', status: 'success', urls: ['https://user:secret@export-download.canva.com/image.png'] }]) {
    await assert.rejects(exportCanvaPages('DESIGN_TEST_01', 'canva-access', queue(reply({ job }))), ProviderError);
  }
});

test('Google upload uses native document conversion and embeds original DOCX bytes privately', async () => {
  const bytes = new Uint8Array([80, 75, 3, 4, 0, 255, 33]);
  const mock = queue(reply({ id: 'google_doc_test', webViewLink: 'https://evil.example/ignored' }));
  const result = await createGoogleDocument(bytes, 'google-access', { title: 'A & B <review>', ...mock });
  assert.deepEqual(result, { id: 'google_doc_test', url: 'https://docs.google.com/document/d/google_doc_test/edit' });
  const request = mock.requests[0];
  assert.match(request.url, /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/);
  assert.equal(request.options.headers.Authorization, 'Bearer google-access');
  const body = Buffer.from(request.options.body);
  assert.ok(body.includes(Buffer.from(JSON.stringify({ name: 'A & B <review>', mimeType: 'application/vnd.google-apps.document' }))));
  assert.ok(body.includes(Buffer.from('Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document')));
  assert.ok(body.includes(Buffer.from(bytes)));
  assert.ok(!body.includes(Buffer.from('google-access')));
  assert.ok(!body.includes(Buffer.from('anyone')));
});

test('Google upload validates bytes, title and returned document identity', async () => {
  await assert.rejects(createGoogleDocument(new Uint8Array(), 'token'), /must contain data/);
  await assert.rejects(createGoogleDocument(new Uint8Array([1]), 'token', { title: '' }), /title/);
  await assert.rejects(createGoogleDocument(new Uint8Array([1]), 'token', { ...queue(reply({ id: '../invalid' })) }), /document ID/);
});

test('Google caption updates replace exact distinct placeholders and return matching counts', async () => {
  const replacements = [
    { text: 'Caption for post 01 — to write.', replaceText: 'A quiet afternoon.' },
    { text: 'Hashtags for post 01 — to add.', replaceText: '#TravelDesign' },
  ];
  const mock = queue(reply({ replies: [{ replaceAllText: { occurrencesChanged: 1 } }, { replaceAllText: { occurrencesChanged: 0 } }] }));
  assert.deepEqual(await fillGoogleCaptions('google_doc_test', 'google-access', replacements, mock), [1, 0]);
  const body = JSON.parse(mock.requests[0].options.body);
  assert.deepEqual(body, { requests: replacements.map(item => ({ replaceAllText: { containsText: { text: item.text, matchCase: true }, replaceText: item.replaceText } })) });
  assert.equal(mock.requests[0].url, 'https://docs.googleapis.com/v1/documents/google_doc_test:batchUpdate');
});

test('Google caption updates reject ambiguous inputs and malformed replies before reporting success', async () => {
  const duplicate = [{ text: 'same', replaceText: 'one' }, { text: 'same', replaceText: 'two' }];
  await assert.rejects(fillGoogleCaptions('google_doc_test', 'token', duplicate), /ambiguous/);
  const replacement = [{ text: 'one', replaceText: 'caption' }];
  await assert.rejects(fillGoogleCaptions('google_doc_test', 'token', replacement, queue(reply({ replies: [] }))), /incomplete/);
  await assert.rejects(fillGoogleCaptions('google_doc_test', 'token', replacement, queue(reply({ replies: [{ replaceAllText: { occurrencesChanged: -1 } }] }))), /invalid caption/);
  assert.deepEqual(await fillGoogleCaptions('google_doc_test', 'token', [], { fetchImpl: () => assert.fail('No request expected') }), []);
});
