import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowProviderError, createDriveFolder, uploadDriveImage, readDriveImage,
  deleteDriveFile, googleFileExists, createPlanningSheet, readPlanningSheet,
  updatePlanningMetadata,
} from '../server/google-workflow.mjs';

const TOKEN = 'google-token-for-test';
const SHEET = 'sheet_test_123';
const FOLDER = 'folder_test_123';
const PHOTO = 'photo_test_123';
const HEADER = ['Publication', 'Page Canva', 'Photo', 'Caption', 'Hashtags'];
const IMAGE = { name: '02.png', mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) };

function reply(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function queue(...responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), ...options });
      assert.ok(responses.length, 'Unexpected upstream request');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(url, options) : response;
    },
  };
}

function sheetInfo(overrides = {}) {
  return {
    spreadsheetId: SHEET, properties: { title: 'Hotel planning' },
    developerMetadata: [{ metadataKey: 'feed_studio_version', metadataValue: '1' }],
    sheets: [{ properties: { sheetId: 0, title: 'Planning' } }, { properties: { sheetId: 1, title: '_FeedStudio' } }],
    ...overrides,
  };
}

function sheetValues(rows = [HEADER, [1, 2, 'Photo 02', 'A quiet courtyard.\nStay a while.', '#Hotel']], metadataRows = [['version', 1]]) {
  return { spreadsheetId: SHEET, valueRanges: [{ values: rows }, { values: metadataRows }] };
}

function sheetInput(overrides = {}) {
  return {
    title: 'Hotel planning', rows: [
      { publication: 1, sourceIndex: 2, fileId: PHOTO, caption: '', hashtags: '' },
      { publication: 2, sourceIndex: 1, fileId: 'photo_test_456', caption: '=Literal caption', hashtags: '#Hotel' },
    ], metadataRows: [['version', 1], ['title', '=Literal metadata']], ...overrides,
  };
}

function assertPrivateRequest(call, host) {
  assert.equal(new URL(call.url).origin, host);
  assert.equal(call.headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(call.redirect, 'error');
  assert.ok(call.signal instanceof AbortSignal);
  assert.ok(!call.url.includes(TOKEN));
}

test('creates a private Drive folder and uploads exact image bytes without permission changes', async () => {
  const mock = queue(reply({ id: FOLDER }), reply({ id: PHOTO }));
  assert.equal(await createDriveFolder('  Hotel photos  ', TOKEN, mock), FOLDER);
  assert.equal(await uploadDriveImage(IMAGE, FOLDER, TOKEN, mock), PHOTO);
  const folder = JSON.parse(mock.calls[0].body);
  assert.deepEqual(folder, { name: 'Hotel photos', mimeType: 'application/vnd.google-apps.folder' });
  assertPrivateRequest(mock.calls[0], 'https://www.googleapis.com');
  assertPrivateRequest(mock.calls[1], 'https://www.googleapis.com');
  assert.match(mock.calls[1].url, /\/upload\/drive\/v3\/files\?/);
  assert.match(mock.calls[1].headers['Content-Type'], /^multipart\/related; boundary=feedstudio_/);
  const upload = Buffer.from(mock.calls[1].body);
  assert.ok(upload.includes(Buffer.from(IMAGE.bytes)));
  assert.ok(upload.includes(Buffer.from(JSON.stringify({ name: IMAGE.name, mimeType: IMAGE.mime, parents: [FOLDER] }))));
  assert.ok(mock.calls.every(call => !call.url.includes('/permissions')));
});

test('invalid IDs, unsupported images, and malformed create results fail before unsafe requests', async () => {
  const noNetwork = { fetchImpl: () => assert.fail('No request expected') };
  for (const id of ['https://evil.invalid/file', '../secrets', 'a?b=c', '', null]) {
    await assert.rejects(readDriveImage(id, TOKEN, noNetwork), /file ID/);
  }
  for (const image of [{ ...IMAGE, mime: 'image/svg+xml' }, { ...IMAGE, bytes: new Uint8Array() }, { ...IMAGE, bytes: new Uint8Array(8 * 1024 * 1024 + 1) }]) {
    await assert.rejects(uploadDriveImage(image, FOLDER, TOKEN, noNetwork), /PNG or JPEG/);
  }
  await assert.rejects(createDriveFolder('Hotel', TOKEN, queue(reply({ id: 'https://evil.invalid' }))), error =>
    error instanceof WorkflowProviderError && error.status === 502 && /valid file ID/.test(error.message));
});

test('reads original private image bytes only from fixed Drive API endpoints', async () => {
  const mock = queue(new Response(IMAGE.bytes, { headers: { 'content-type': 'image/png; charset=binary' } }));
  const image = await readDriveImage(PHOTO, TOKEN, mock);
  assert.equal(image.mime, 'image/png');
  assert.deepEqual(image.bytes, IMAGE.bytes);
  assert.equal(new URL(mock.calls[0].url).pathname, '/drive/v3/files/' + PHOTO);
  assert.equal(new URL(mock.calls[0].url).searchParams.get('alt'), 'media');
  assertPrivateRequest(mock.calls[0], 'https://www.googleapis.com');
});

test('rejects non-image, empty, oversized declared and oversized streaming image responses', async () => {
  await assert.rejects(readDriveImage(PHOTO, TOKEN, queue(new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } }))), /not a PNG or JPEG/);
  await assert.rejects(readDriveImage(PHOTO, TOKEN, queue(new Response(new Uint8Array(), { headers: { 'content-type': 'image/png' } }))), /empty/);
  await assert.rejects(readDriveImage(PHOTO, TOKEN, queue(new Response(IMAGE.bytes, { headers: { 'content-type': 'image/png', 'content-length': String(8 * 1024 * 1024 + 1) } }))), error => error.status === 413);
  let sent = 0, cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { sent++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readDriveImage(PHOTO, TOKEN, queue(new Response(stream, { headers: { 'content-type': 'image/jpeg' } }))), error => error.status === 413);
  assert.ok(cancelled);
  assert.ok(sent <= 10);
});

test('file existence distinguishes missing and trashed files from auth and upstream failures', async () => {
  assert.equal(await googleFileExists(PHOTO, TOKEN, queue(reply({ id: PHOTO, trashed: false }))), true);
  assert.equal(await googleFileExists(PHOTO, TOKEN, queue(reply({ id: PHOTO, trashed: true }))), false);
  assert.equal(await googleFileExists(PHOTO, TOKEN, queue(reply({ error: 'private upstream secret' }, 404))), false);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(googleFileExists(PHOTO, TOKEN, queue(reply({ error: 'private upstream secret' }, status))), error =>
      error instanceof WorkflowProviderError && error.status === status && !error.message.includes('private upstream secret'));
  }
  await assert.rejects(googleFileExists(PHOTO, TOKEN, queue(reply({ id: 'different_photo' }))), /invalid file information/);
});

test('cleanup moves a known file to trash using PATCH and verifies the result', async () => {
  const mock = queue(reply({ id: PHOTO, trashed: true }));
  assert.equal(await deleteDriveFile(PHOTO, TOKEN, mock), undefined);
  assert.equal(mock.calls[0].method, 'PATCH');
  assert.deepEqual(JSON.parse(mock.calls[0].body), { trashed: true });
  await deleteDriveFile(PHOTO, TOKEN, queue(reply({}, 404)));
  await assert.rejects(deleteDriveFile(PHOTO, TOKEN, queue(reply({ id: PHOTO, trashed: false }))), /confirm/);
});

test('creates Planning and hidden metadata tabs with literal text, stable private photo links and warning protection', async () => {
  const mock = queue(reply(sheetInfo()), reply({ replies: [] }));
  assert.deepEqual(await createPlanningSheet(sheetInput(), TOKEN, mock), {
    id: SHEET, url: 'https://docs.google.com/spreadsheets/d/' + SHEET + '/edit',
  });
  assertPrivateRequest(mock.calls[0], 'https://sheets.googleapis.com');
  const body = JSON.parse(mock.calls[0].body);
  assert.equal(body.properties.title, 'Hotel planning');
  assert.equal(body.developerMetadata, undefined);
  const [planning, metadata] = body.sheets;
  assert.equal(planning.properties.sheetId, 0);
  assert.equal(planning.properties.gridProperties.frozenRowCount, 1);
  assert.deepEqual(planning.data[0].rowData[0].values.map(value => value.userEnteredValue.stringValue), HEADER);
  const first = planning.data[0].rowData[1].values;
  assert.equal(first[0].userEnteredValue.numberValue, 1);
  assert.equal(first[1].userEnteredValue.numberValue, 2);
  assert.equal(first[2].userEnteredValue.stringValue, 'Photo 02');
  assert.equal(first[2].userEnteredFormat.textFormat.link.uri, 'https://drive.google.com/file/d/' + PHOTO + '/view');
  assert.deepEqual(planning.data[0].rowData[2].values[3].userEnteredValue, { stringValue: '=Literal caption' });
  assert.equal(planning.protectedRanges[0].warningOnly, true);
  assert.equal(planning.protectedRanges[0].range.endColumnIndex, 3);
  assert.equal(metadata.properties.title, '_FeedStudio');
  assert.equal(metadata.properties.sheetId, 1);
  assert.equal(metadata.properties.hidden, true);
  assert.deepEqual(metadata.data[0].rowData[1].values[1].userEnteredValue, { stringValue: '=Literal metadata' });
  const formatting = JSON.parse(mock.calls[1].body).requests;
  assert.deepEqual(formatting[0].createDeveloperMetadata.developerMetadata, { metadataKey: 'feed_studio_version', metadataValue: '1', visibility: 'DOCUMENT', location: { spreadsheet: true } });
  assert.equal(formatting[1].repeatCell.cell.userEnteredFormat.wrapStrategy, 'WRAP');
  assert.equal(formatting[1].repeatCell.cell.userEnteredFormat.numberFormat.type, 'TEXT');
});

test('moves the created planning sheet into its folder and trashes incomplete sheets if finalization fails', async () => {
  const mock = queue(reply(sheetInfo()), reply({}), reply({ parents: ['root_parent_123'] }), reply({ id: SHEET }));
  await createPlanningSheet(sheetInput({ folderId: FOLDER }), TOKEN, mock);
  assert.equal(mock.calls[3].method, 'PATCH');
  const move = new URL(mock.calls[3].url);
  assert.equal(move.searchParams.get('addParents'), FOLDER);
  assert.equal(move.searchParams.get('removeParents'), 'root_parent_123');

  const failed = queue(reply(sheetInfo()), reply({ error: 'upstream secret' }, 403), reply({ id: SHEET, trashed: true }));
  await assert.rejects(createPlanningSheet(sheetInput(), TOKEN, failed), error => error.status === 403 && !error.message.includes('upstream secret'));
  assert.equal(failed.calls[2].method, 'PATCH');
  assert.deepEqual(JSON.parse(failed.calls[2].body), { trashed: true });
  const wrongTabs = queue(reply(sheetInfo({ sheets: [{ properties: { sheetId: 10, title: 'Planning' } }] })), reply({ id: SHEET, trashed: true }));
  await assert.rejects(createPlanningSheet(sheetInput(), TOKEN, wrongTabs), /expected planning sheet tabs/);
  assert.deepEqual(JSON.parse(wrongTabs.calls[1].body), { trashed: true });
});

test('validates planning row identity and metadata bounds before creation', async () => {
  const noNetwork = { fetchImpl: () => assert.fail('No request expected') };
  const badRows = [[], new Array(1), [sheetInput().rows[0], sheetInput().rows[0]], [{ publication: 1, sourceIndex: 0, fileId: PHOTO }], Array(61).fill(sheetInput().rows[0])];
  for (const rows of badRows) await assert.rejects(createPlanningSheet(sheetInput({ rows }), TOKEN, noNetwork), WorkflowProviderError);
  for (const metadataRows of [[], new Array(1), Array(71).fill(['key', 'value']), [Array(25).fill('x')], [['key', null]], [['key', NaN]]]) {
    await assert.rejects(createPlanningSheet(sheetInput({ metadataRows }), TOKEN, noNetwork), /metadata/);
  }
});

test('reopens a marked sheet and preserves numeric mappings, caption line breaks, blanks and metadata', async () => {
  const values = sheetValues([HEADER, [], ...Array(995).fill([]), [1, 2, 'Photo 02', 'A quiet courtyard.\nStay a while.', '#Hotel']]);
  const mock = queue(reply(sheetInfo()), reply(values));
  assert.deepEqual(await readPlanningSheet(SHEET, TOKEN, mock), {
    title: 'Hotel planning', rows: values.valueRanges[0].values, metadataRows: values.valueRanges[1].values,
  });
  mock.calls.forEach(call => assertPrivateRequest(call, 'https://sheets.googleapis.com'));
  const url = new URL(mock.calls[1].url);
  assert.deepEqual(url.searchParams.getAll('ranges'), ["'Planning'", "'_FeedStudio'"]);
  assert.equal(url.searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
});

test('rejects unrelated sheets, changed headers and excess rows or columns without partial reads', async () => {
  for (const info of [sheetInfo({ developerMetadata: [] }), sheetInfo({ developerMetadata: {} }), sheetInfo({ sheets: [] }),
    sheetInfo({ developerMetadata: [{ metadataKey: 'feed_studio_version', metadataValue: '2' }] })]) {
    const mock = queue(reply(info));
    await assert.rejects(readPlanningSheet(SHEET, TOKEN, mock), error => error.status === 422);
    assert.equal(mock.calls.length, 1);
  }
  const malformed = [
    sheetValues([['Publication', 'Changed', 'Photo', 'Caption', 'Hashtags']]),
    sheetValues([HEADER, ...Array(61).fill([1])]),
    sheetValues([HEADER, ...Array(1000).fill([])]),
    sheetValues([HEADER], Array(71).fill(['key'])),
    sheetValues([HEADER, [1, 1, 'Photo', '', '', 'unexpected']]),
    sheetValues([HEADER], [['key', true]]),
  ];
  for (const values of malformed) {
    await assert.rejects(readPlanningSheet(SHEET, TOKEN, queue(reply(sheetInfo()), reply(values))), error => error.status === 422);
  }
});

test('metadata updates write literal values and clear stale trailing metadata without touching captions', async () => {
  const mock = queue(reply({ replies: [{}] }));
  await updatePlanningMetadata(SHEET, [['doc', '=literal'], ['revision', 2]], TOKEN, mock);
  const requests = JSON.parse(mock.calls[0].body).requests;
  assert.equal(requests.length, 1);
  const update = requests[0].updateCells;
  assert.deepEqual(update.range, { sheetId: 1, startRowIndex: 0, endRowIndex: 70, startColumnIndex: 0, endColumnIndex: 24 });
  assert.equal(update.fields, 'userEnteredValue');
  assert.deepEqual(update.rows[0].values[1].userEnteredValue, { stringValue: '=literal' });
  assert.deepEqual(update.rows[1].values[1].userEnteredValue, { numberValue: 2 });
});

test('sanitizes connection/provider errors, explains disabled Sheets API, and bounds JSON responses', async () => {
  await assert.rejects(createDriveFolder('Hotel', TOKEN, queue(new Error('secret_token_and_network_details'))), error =>
    error instanceof WorkflowProviderError && !error.message.includes('secret_token'));
  await assert.rejects(readPlanningSheet(SHEET, TOKEN, queue(reply({ error: { message: 'upstream secret', details: [{ reason: 'SERVICE_DISABLED', metadata: { service: 'sheets.googleapis.com' } }] } }, 403))), error =>
    error.status === 403 && error.message.includes('https://console.cloud.google.com/apis/library/sheets.googleapis.com') && !error.message.includes('upstream secret'));
  await assert.rejects(readPlanningSheet(SHEET, TOKEN, queue(new Response('{malformed', { headers: { 'content-type': 'application/json' } }))), /unreadable/);
  await assert.rejects(readPlanningSheet(SHEET, TOKEN, queue(reply({ huge: 'x'.repeat(512 * 1024) }))), error => error.status === 413);
  await assert.rejects(readDriveImage(PHOTO, 'bad\r\ntoken', { fetchImpl: () => assert.fail('No request expected') }), error => error.status === 401);
});
