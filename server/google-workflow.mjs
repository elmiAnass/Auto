import { randomBytes } from 'node:crypto';

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const HEADER = ['Publication', 'Page Canva', 'Photo', 'Caption', 'Hashtags'];
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_JSON = 512 * 1024;
const MAX_METADATA_COLUMNS = 24;

export class WorkflowProviderError extends Error {
  constructor(message, { status = 502 } = {}) {
    super(message);
    this.name = 'WorkflowProviderError';
    this.status = status;
    this.provider = 'google';
  }
}

function fail(message, status = 502) { return new WorkflowProviderError(message, { status }); }

function fileId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{5,200}$/.test(value)) {
    throw fail('The Google file ID is invalid.', 400);
  }
  return value;
}

function titleText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw fail('Use a title of 1 to 200 characters.', 400);
  }
  return value.trim();
}

function authorization(token) {
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) {
    throw fail('Reconnect Google to continue.', 401);
  }
  return { Authorization: 'Bearer ' + token };
}

async function request(url, token, { fetchImpl = fetch, ...options } = {}) {
  const headers = { ...authorization(token), Accept: 'application/json', ...options.headers };
  try {
    return await fetchImpl(url, {
      ...options, headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw fail('Google could not be reached. Please retry later.');
  }
}

async function limitedBytes(response, maximum) {
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw fail('Google returned more data than this workflow supports.', 413);
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maximum) throw fail('Google returned more data than this workflow supports.', 413);
    return bytes;
  }
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => {});
        throw fail('Google returned more data than this workflow supports.', 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WorkflowProviderError) throw error;
    throw fail('Google returned an incomplete response. Please retry.');
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks, length));
}

async function responseError(response, sheets = false) {
  const status = Number.isInteger(response?.status) && response.status >= 400 && response.status <= 599 ? response.status : 502;
  if (sheets && status === 403) {
    let body;
    try { body = JSON.parse(new TextDecoder().decode(await limitedBytes(response, 64 * 1024))); }
    catch { /* Provider response details are never exposed. */ }
    if (body?.error && /SERVICE_DISABLED|accessNotConfigured|API_DISABLED|Sheets API has not been used/i.test(JSON.stringify(body.error))) {
      throw fail('Google Sheets API is disabled. Enable it in your Google Cloud project: https://console.cloud.google.com/apis/library/sheets.googleapis.com', 403);
    }
  }
  const hint = status === 401 ? 'Reconnect Google to continue.' :
    status === 403 ? 'Check the connected Google account and its permission to access this file.' :
    status === 404 ? 'This Google file was not found or is unavailable to the connected account.' :
    status === 429 ? 'Google quota was reached. Please retry later.' : 'Please retry later.';
  throw fail('Google returned HTTP ' + status + '. ' + hint, status);
}

async function json(response, sheets = false) {
  if (!response?.ok) return responseError(response, sheets);
  let result;
  try { result = JSON.parse(new TextDecoder().decode(await limitedBytes(response, MAX_JSON))); }
  catch (error) {
    if (error instanceof WorkflowProviderError) throw error;
    throw fail('Google returned an unreadable response.');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail('Google returned invalid workflow data.');
  return result;
}

function verifiedId(value) {
  try { return fileId(value); }
  catch { throw fail('Google did not return a valid file ID.'); }
}

function jsonOptions(value, fetchImpl, method = 'POST') {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_JSON) throw fail('Workflow data exceeds the 512 KB limit.', 400);
  return { fetchImpl, method, headers: { 'Content-Type': 'application/json' }, body };
}

export async function createDriveFolder(title, token, { fetchImpl = fetch } = {}) {
  const result = await json(await request(DRIVE + '?fields=id', token, jsonOptions({
    name: titleText(title), mimeType: 'application/vnd.google-apps.folder',
  }, fetchImpl)));
  return verifiedId(result.id);
}

export async function uploadDriveImage(image, folderId, token, { fetchImpl = fetch } = {}) {
  fileId(folderId);
  if (!image || !(image.bytes instanceof Uint8Array) || !image.bytes.length || image.bytes.length > MAX_IMAGE ||
      !['image/png', 'image/jpeg'].includes(image.mime)) {
    throw fail('Use a PNG or JPEG image smaller than 8 MB.', 400);
  }
  const name = image.name == null ? 'Photo.' + (image.mime === 'image/png' ? 'png' : 'jpg') : titleText(image.name);
  const boundary = 'feedstudio_' + randomBytes(18).toString('hex');
  const metadata = JSON.stringify({ name, mimeType: image.mime, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + metadata + '\r\n'),
    Buffer.from('--' + boundary + '\r\nContent-Type: ' + image.mime + '\r\n\r\n'),
    Buffer.from(image.bytes), Buffer.from('\r\n--' + boundary + '--\r\n'),
  ]);
  const result = await json(await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', token, {
    fetchImpl, method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body,
  }));
  return verifiedId(result.id);
}

export async function readDriveImage(id, token, { fetchImpl = fetch } = {}) {
  const response = await request(DRIVE + '/' + fileId(id) + '?alt=media', token, { fetchImpl, method: 'GET' });
  if (!response?.ok) return responseError(response);
  const mime = (response.headers?.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/png', 'image/jpeg'].includes(mime)) throw fail('The saved photo is not a PNG or JPEG image.', 422);
  const bytes = await limitedBytes(response, MAX_IMAGE);
  if (!bytes.length) throw fail('The saved photo is empty.', 422);
  return { bytes, mime };
}

export async function deleteDriveFile(id, token, { fetchImpl = fetch } = {}) {
  const response = await request(DRIVE + '/' + fileId(id) + '?fields=id%2Ctrashed', token,
    jsonOptions({ trashed: true }, fetchImpl, 'PATCH'));
  if (response.status === 404) return;
  const result = await json(response);
  if (result.id !== id || result.trashed !== true) throw fail('Google did not confirm that the workflow file was moved to trash.');
}

export async function googleFileExists(id, token, { fetchImpl = fetch } = {}) {
  fileId(id);
  const response = await request(DRIVE + '/' + id + '?fields=id%2Ctrashed', token, { fetchImpl, method: 'GET' });
  if (response.status === 404) return false;
  const result = await json(response);
  if (result.id !== id || (result.trashed != null && typeof result.trashed !== 'boolean')) {
    throw fail('Google returned invalid file information.');
  }
  return result.trashed !== true;
}

function metadataValues(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 70) throw fail('Workflow metadata must contain between 1 and 70 rows.', 400);
  return Array.from(rows, row => {
    if (!Array.isArray(row) || row.length > MAX_METADATA_COLUMNS) throw fail('Workflow metadata contains an invalid row.', 400);
    return row.map(value => {
      if ((typeof value !== 'string' && typeof value !== 'number') ||
          (typeof value === 'number' && !Number.isFinite(value)) ||
          (typeof value === 'string' && value.length > 20_000)) throw fail('Workflow metadata contains an invalid value.', 400);
      return value;
    });
  });
}

function cell(value, extra = {}) {
  return { userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: value }, ...extra };
}

function planningRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 60) throw fail('Use between 1 and 60 planning rows.', 400);
  const publications = new Set(), pages = new Set();
  return Array.from(rows, row => {
    if (!row || !Number.isInteger(row.publication) || row.publication < 1 || row.publication > rows.length ||
        !Number.isInteger(row.sourceIndex) || row.sourceIndex < 1 || row.sourceIndex > rows.length ||
        publications.has(row.publication) || pages.has(row.sourceIndex) ||
        (row.caption != null && typeof row.caption !== 'string') || (row.hashtags != null && typeof row.hashtags !== 'string')) {
      throw fail('Planning rows must contain unique publication and Canva page numbers.', 400);
    }
    publications.add(row.publication); pages.add(row.sourceIndex);
    const photoId = fileId(row.fileId);
    return { values: [
      cell(row.publication), cell(row.sourceIndex),
      cell('Photo ' + String(row.sourceIndex).padStart(2, '0'), {
        userEnteredFormat: { textFormat: { link: { uri: 'https://drive.google.com/file/d/' + photoId + '/view' } } },
      }),
      cell(row.caption || ''), cell(row.hashtags || ''),
    ] };
  });
}

async function moveIntoFolder(id, folderId, token, fetchImpl) {
  const info = await json(await request(DRIVE + '/' + id + '?fields=parents', token, { fetchImpl, method: 'GET' }));
  if (info.parents != null && (!Array.isArray(info.parents) || info.parents.some(parent => typeof parent !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(parent)))) {
    throw fail('Google returned invalid folder information.');
  }
  const query = new URLSearchParams({ addParents: folderId, fields: 'id' });
  if (info.parents?.length) query.set('removeParents', info.parents.join(','));
  const moved = await json(await request(DRIVE + '/' + id + '?' + query, token, jsonOptions({}, fetchImpl, 'PATCH')));
  if (moved.id !== id) throw fail('Google did not confirm the planning sheet folder.');
}

export async function createPlanningSheet({ title, rows, metadataRows, folderId }, token, { fetchImpl = fetch } = {}) {
  const name = titleText(title), planning = planningRows(rows), metadata = metadataValues(metadataRows);
  if (folderId != null) fileId(folderId);
  const header = { values: HEADER.map(value => cell(value, {
    userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.94, blue: 0.96 } },
  })) };
  const body = {
    properties: { title: name },
    sheets: [
      {
        properties: { sheetId: 0, title: 'Planning', gridProperties: { rowCount: 1000, columnCount: 5, frozenRowCount: 1 } },
        data: [{ startRow: 0, startColumn: 0, rowData: [header, ...planning] }],
        protectedRanges: [{ description: 'Keep publication, Canva page, and photo mapping intact.', warningOnly: true,
          range: { sheetId: 0, startColumnIndex: 0, endColumnIndex: 3 } }],
        basicFilter: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: planning.length + 1, startColumnIndex: 0, endColumnIndex: 5 } },
      },
      {
        properties: { sheetId: 1, title: '_FeedStudio', hidden: true, gridProperties: { rowCount: 70, columnCount: MAX_METADATA_COLUMNS } },
        data: [{ startRow: 0, startColumn: 0, rowData: metadata.map(row => ({ values: row.map(value => cell(value)) })) }],
      },
    ],
  };
  // Literal stringValue cells prevent caption text beginning with '=' becoming formulas.
  const result = await json(await request(SHEETS + '?fields=spreadsheetId%2Csheets(properties(sheetId%2Ctitle))', token, jsonOptions(body, fetchImpl)), true);
  const id = verifiedId(result.spreadsheetId);
  try {
    if (!Array.isArray(result.sheets) || result.sheets.length !== 2 ||
        !result.sheets.some(sheet => sheet?.properties?.sheetId === 0 && sheet.properties.title === 'Planning') ||
        !result.sheets.some(sheet => sheet?.properties?.sheetId === 1 && sheet.properties.title === '_FeedStudio')) {
      throw fail('Google did not create the expected planning sheet tabs.');
    }
    await json(await request(SHEETS + '/' + id + ':batchUpdate', token, jsonOptions({ requests: [
      { createDeveloperMetadata: { developerMetadata: { metadataKey: 'feed_studio_version', metadataValue: '1', visibility: 'DOCUMENT', location: { spreadsheet: true } } } },
      { repeatCell: { range: { sheetId: 0, startRowIndex: 1, startColumnIndex: 3, endColumnIndex: 5 },
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP', numberFormat: { type: 'TEXT' } } }, fields: 'userEnteredFormat(wrapStrategy,verticalAlignment,numberFormat)' } },
      { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 }, properties: { pixelSize: 480 }, fields: 'pixelSize' } },
      { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 }, properties: { pixelSize: 300 }, fields: 'pixelSize' } },
    ] }, fetchImpl)), true);
    if (folderId) await moveIntoFolder(id, folderId, token, fetchImpl);
  } catch (error) {
    await deleteDriveFile(id, token, { fetchImpl }).catch(() => {});
    throw error;
  }
  return { id, url: 'https://docs.google.com/spreadsheets/d/' + id + '/edit' };
}

function readRows(value, { maximumRows, maximumColumns, maximumNonblankRows, description }) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maximumRows) throw fail(description + ' contains too many rows.', 422);
  const rows = value.map(row => {
    if (!Array.isArray(row) || row.length > maximumColumns || row.some(item => typeof item !== 'string' && typeof item !== 'number')) {
      throw fail(description + ' contains invalid cell values.', 422);
    }
    return row.slice();
  });
  if (maximumNonblankRows != null && rows.filter(row => row.some(value => typeof value === 'number' || value.trim())).length > maximumNonblankRows) {
    throw fail(description + ' contains too many nonblank rows.', 422);
  }
  return rows;
}

export async function readPlanningSheet(id, token, { fetchImpl = fetch } = {}) {
  fileId(id);
  const fields = 'spreadsheetId,properties(title),sheets(properties(sheetId,title)),developerMetadata(metadataKey,metadataValue)';
  const info = await json(await request(SHEETS + '/' + id + '?fields=' + encodeURIComponent(fields), token, { fetchImpl, method: 'GET' }), true);
  const markers = Array.isArray(info.developerMetadata) ? info.developerMetadata.filter(item => item?.metadataKey === 'feed_studio_version') : [];
  const sheets = Array.isArray(info.sheets) ? info.sheets : [];
  const tabs = sheets.map(sheet => sheet?.properties?.title);
  const planningTab = sheets.find(sheet => sheet?.properties?.title === 'Planning');
  const metadataTab = sheets.find(sheet => sheet?.properties?.title === '_FeedStudio');
  if (info.spreadsheetId !== id || markers.length !== 1 || markers[0].metadataValue !== '1' ||
      tabs.filter(name => name === 'Planning').length !== 1 || tabs.filter(name => name === '_FeedStudio').length !== 1 ||
      planningTab?.properties?.sheetId !== 0 || metadataTab?.properties?.sheetId !== 1 ||
      typeof info.properties?.title !== 'string') {
    throw fail('Use a planning sheet created by Feed Studio with its Planning and _FeedStudio tabs intact.', 422);
  }
  // Read the two full tab ranges under a byte limit. This also detects unexpected
  // data far below the planned rows, rather than silently ignoring it.
  const query = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
  query.append('ranges', "'Planning'"); query.append('ranges', "'_FeedStudio'");
  const result = await json(await request(SHEETS + '/' + id + '/values:batchGet?' + query, token, { fetchImpl, method: 'GET' }), true);
  if (result.spreadsheetId !== id || !Array.isArray(result.valueRanges) || result.valueRanges.length !== 2 ||
      result.valueRanges.some(range => !range || typeof range !== 'object' || Array.isArray(range))) {
    throw fail('Google returned incomplete planning sheet data.');
  }
  const rows = readRows(result.valueRanges[0].values, { maximumRows: 1000, maximumNonblankRows: 61, maximumColumns: 5, description: 'The planning tab' });
  const metadataRows = readRows(result.valueRanges[1].values, { maximumRows: 70, maximumColumns: MAX_METADATA_COLUMNS, description: 'The workflow metadata' });
  if (!rows.length || rows[0].length !== HEADER.length || HEADER.some((value, index) => rows[0][index] !== value) || !metadataRows.length) {
    throw fail('Keep the planning sheet header and workflow metadata intact.', 422);
  }
  return { rows, metadataRows, title: info.properties.title };
}

export async function updatePlanningMetadata(id, metadataRows, token, { fetchImpl = fetch } = {}) {
  fileId(id);
  const values = metadataValues(metadataRows);
  // UpdateCells clears values in the unused tail of this fixed metadata range.
  // It writes literal strings while retaining the hidden tab and its formatting.
  await json(await request(SHEETS + '/' + id + ':batchUpdate', token, jsonOptions({ requests: [
    { updateCells: { range: { sheetId: 1, startRowIndex: 0, endRowIndex: 70, startColumnIndex: 0, endColumnIndex: MAX_METADATA_COLUMNS },
      rows: values.map(row => ({ values: row.map(value => cell(value)) })), fields: 'userEnteredValue' } },
  ] }, fetchImpl)), true);
}
