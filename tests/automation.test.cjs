const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

class Sheet {
  constructor(name) { this.name = name; this.rows = []; }
  getName() { return this.name; }
  getLastRow() {
    let last = this.rows.length;
    while (last && !(this.rows[last - 1] || []).some(value => value !== '' && value != null)) last--;
    return last;
  }
  getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
  setFrozenRows() {}
  setColumnWidth() {}
  getRange(row, column, height = 1, width = 1) {
    const sheet = this;
    return {
      getValues() {
        return Array.from({length: height}, (_, y) => Array.from({length: width}, (_, x) => sheet.rows[row - 1 + y]?.[column - 1 + x] ?? ''));
      },
      setValues(values) {
        assert.equal(values.length, height);
        values.forEach((valuesRow, y) => {
          assert.equal(valuesRow.length, width);
          sheet.rows[row - 1 + y] ||= [];
          valuesRow.forEach((value, x) => {
            // Match Sheets' literal prefix, and catch accidental formula writes.
            assert.ok(typeof value !== 'string' || !value.startsWith('='), 'Unsafe formula write');
            sheet.rows[row - 1 + y][column - 1 + x] = typeof value === 'string' && /^'[=+@-]/.test(value) ? value.slice(1) : value;
          });
        });
        return this;
      },
      setValue(value) { return this.setValues([[value]]); },
      setFontWeight() { return this; }
    };
  }
}

class Paragraph {
  constructor(text, body) { this.text = text; this.body = body; }
  setHeading() { return this; }
  setAttributes() { return this; }
  setSpacingBefore() { return this; }
  setSpacingAfter() { return this; }
  setAlignment() { return this; }
  appendInlineImage(blob) {
    if (blob.broken) throw new Error('Invalid image data.');
    const image = {id: blob.id, width: blob.width, height: blob.height,
      getWidth() { return this.width; }, getHeight() { return this.height; },
      setWidth(value) { this.width = value; return this; }, setHeight(value) { this.height = value; return this; }};
    this.body.images.push(image);
    return image;
  }
  // Paragraph intentionally has no setBold: that belongs to Text in Apps Script.
}

class Body {
  constructor() { this.paragraphs = []; this.images = []; this.breaks = 0; }
  clear() { this.paragraphs = []; this.images = []; this.breaks = 0; this.cleared = true; return this; }
  setPageWidth() { return this; }
  setPageHeight() { return this; }
  setMarginTop() { return this; }
  setMarginBottom() { return this; }
  setMarginLeft() { return this; }
  setMarginRight() { return this; }
  setAttributes() { return this; }
  appendParagraph(text) { const p = new Paragraph(text, this); this.paragraphs.push(p); return p; }
  appendPageBreak() { this.breaks++; }
}

function properties() {
  const values = {};
  return {values, getProperty: key => values[key] ?? null,
    setProperty(key, value) { values[key] = value; },
    setProperties(input) { Object.assign(values, input); },
    deleteProperty(key) { delete values[key]; }};
}

function fixture() {
  const sheets = new Map(), files = new Map(), folders = new Map();
  const state = {sheets, files, folders, alerts: [], docs: [], requests: [], responses: [], locked: false};
  const book = {getSheetByName: name => sheets.get(name) || null,
    insertSheet(name) { const sheet = new Sheet(name); sheets.set(name, sheet); return sheet; }};
  const userProps = properties(), docProps = properties();
  const context = vm.createContext({
    SpreadsheetApp: {getActiveSpreadsheet: () => book, flush() {}, getUi: () => ({alert: message => state.alerts.push(message)})},
    LockService: {getDocumentLock: () => ({tryLock() { if (state.locked) return false; state.locked = true; return true; }, releaseLock() { state.locked = false; }})},
    PropertiesService: {getUserProperties: () => userProps, getDocumentProperties: () => docProps},
    DriveApp: {
      getFolderById(id) { if (!folders.has(id)) throw new Error('Folder not found.'); return folders.get(id); },
      getFileById(id) { if (!files.has(id)) throw new Error('File not found.'); return files.get(id); }
    },
    DocumentApp: {Attribute: {FONT_FAMILY: 'font', FONT_SIZE: 'size', BOLD: 'bold'},
      ParagraphHeading: {HEADING2: 'h2'}, HorizontalAlignment: {CENTER: 'center'},
      create(title) {
        const id = 'document_' + (state.docs.length + 1);
        const body = new Body();
        const doc = {id, title, body, closed: false, getId: () => id, getBody: () => body,
          saveAndClose() { this.closed = true; }};
        state.docs.push(doc);
        files.set(id, {trashed: false, isTrashed() { return this.trashed; }, setTrashed(value) { this.trashed = value; }, moveTo(folder) { this.folder = folder; }});
        return doc;
      }
    },
    UrlFetchApp: {fetch(url, options) {
      state.requests.push({url, options, payload: JSON.parse(options.payload)});
      const next = state.responses.shift();
      if (!next) throw new Error('Unexpected fetch.');
      if (next instanceof Error) throw next;
      return next;
    }},
    Utilities: {
      base64Encode: bytes => Buffer.from(bytes).toString('base64'),
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url'),
      computeDigest: (_algorithm, input) => [...crypto.createHash('sha256').update(input).digest()],
      DigestAlgorithm: {SHA_256: 'sha256'}, Charset: {UTF_8: 'utf8'},
      formatDate: () => '2026-10-22 14:00:00'
    },
    Session: {getScriptTimeZone: () => 'Africa/Casablanca'}
  });
  vm.runInContext(source, context, {filename: 'Code.gs'});
  state.app = context;
  state.userProps = userProps;
  state.docProps = docProps;
  state.set = (name, value) => {
    const sheet = sheets.get('Settings');
    const index = sheet.rows.findIndex(row => row[0] === name);
    assert.ok(index > 0, name);
    sheet.getRange(index + 1, 2).setValue(value);
  };
  state.addImage = (position, options = {}) => {
    const id = options.id || 'photo_file_' + position;
    const name = options.name || String(position).padStart(2, '0') + '.jpg';
    const file = {id, name, mime: options.mime || 'image/jpeg', size: options.size || 1000, updated: 100,
      getId: () => id, getName: () => name,
      getMimeType() { return this.mime; }, getSize() { return this.size; }, getLastUpdated() { return new Date(this.updated); },
      getBlob: () => ({id, width: options.width || 1600, height: options.height || 1200, broken: options.broken,
        getBytes: () => [...Buffer.from('image-bytes-' + id)]})};
    files.set(id, file);
    return file;
  };
  state.folder = list => {
    folders.set('source_folder_123', {getFiles() { let i = 0; return {hasNext: () => i < list.length, next: () => list[i++]}; }});
    state.set('SOURCE_FOLDER_ID', 'https://drive.google.com/drive/folders/source_folder_123');
  };
  state.import = positions => { state.folder(positions.map(p => state.addImage(p))); context.importPhotos(); };
  context.prepareStudio();
  assert.match(state.alerts.at(-1), /^Prepared/);
  return state;
}

function response(result, status = 200) {
  return {getResponseCode: () => status, getContentText: () => typeof result === 'string' ? result : JSON.stringify(result)};
}

function aiDraft(caption = 'A quiet courtyard, framed by warm light.', subject = 'Courtyard') {
  return response({status: 'completed', output: [{type: 'message', content: [{type: 'output_text',
    text: JSON.stringify({subject, caption, hashtags: ['#TravelDesign']})}]}]});
}

test('prepare is repeatable and preserves configured values', () => {
  const s = fixture();
  s.set('BRAND_NAME', 'Example Hotel');
  const before = plain(s.sheets.get('Settings').rows);
  s.app.prepareStudio();
  assert.deepEqual(s.sheets.get('Settings').rows, before);
  assert.equal(s.sheets.size, 2);
});

test('existing unexpected tabs are not overwritten', () => {
  const s = fixture();
  s.sheets.get('Feed').rows[0][0] = 'My own data';
  const before = plain(s.sheets.get('Feed').rows);
  s.app.prepareStudio();
  assert.match(s.alerts.at(-1), /Unexpected columns/);
  assert.deepEqual(s.sheets.get('Feed').rows, before);
});

test('shuffled Drive results import in numeric order and reruns preserve edits', () => {
  const s = fixture();
  s.import([10, 2, 1]);
  const sheet = s.sheets.get('Feed');
  assert.deepEqual(sheet.rows.slice(1).map(row => row[0]), [1, 2, 10]);
  sheet.getRange(2, 5).setValue('My hand-written caption.');
  s.app.importPhotos();
  assert.equal(sheet.rows.length, 4);
  assert.equal(sheet.rows[1][4], 'My hand-written caption.');
  assert.match(s.alerts.at(-1), /Imported 0 new/);
});

test('grid reverses the visual positions; publication mode does not mutate input', () => {
  const s = fixture();
  s.import([1, 2, 3]);
  s.set('ORDER_MODE', 'GRID');
  s.app.refreshPublicationOrder();
  assert.deepEqual(s.sheets.get('Feed').rows.slice(1).map(row => row[6]), [3, 2, 1]);
  s.set('ORDER_MODE', 'PUBLICATION');
  s.app.refreshPublicationOrder();
  assert.deepEqual(s.sheets.get('Feed').rows.slice(1).map(row => row[6]), [1, 2, 3]);
});

test('conflicting positions fail before any partial import', () => {
  const s = fixture();
  s.folder([s.addImage(1), s.addImage(2), s.addImage(1, {id: 'different_file_1'})]);
  s.app.importPhotos();
  assert.match(s.alerts.at(-1), /Position 1 is already used/);
  assert.equal(s.sheets.get('Feed').getLastRow(), 1);
});

test('unsupported image formats are rejected, non-images are ignored', () => {
  const s = fixture();
  s.folder([s.addImage(1), s.addImage(2, {mime: 'image/webp'})]);
  s.app.importPhotos();
  assert.match(s.alerts.at(-1), /JPG or PNG/);
  assert.equal(s.sheets.get('Feed').getLastRow(), 1);
  s.folder([s.addImage(1), s.addImage(2, {mime: 'application/pdf', name: 'brief.pdf'})]);
  s.app.importPhotos();
  assert.equal(s.sheets.get('Feed').getLastRow(), 2);
});

test('export exercises the complete document workflow without an API key', () => {
  const s = fixture();
  s.import([1, 2, 3]);
  s.set('ORDER_MODE', 'GRID');
  s.app.createReviewDocument();
  assert.equal(s.docs.length, 1);
  assert.equal(s.docs[0].closed, true);
  assert.equal(s.docs[0].body.breaks, 2);
  assert.deepEqual(s.docs[0].body.images.map(image => image.id), ['photo_file_3', 'photo_file_2', 'photo_file_1']);
  assert.equal(s.docs[0].body.paragraphs.filter(p => p.text === '[Write your English caption here.]').length, 3);
  assert.equal(s.requests.length, 0);
  assert.match(s.sheets.get('Feed').rows[1][7], /document_1/);
  assert.equal(s.files.get('document_1').trashed, false);
});

test('unchanged export reuses output and preserves edits in Docs; changes create a new version', () => {
  const s = fixture();
  s.import([1]);
  s.app.createReviewDocument();
  s.docs[0].body.appendParagraph('My edit inside Docs');
  s.app.createReviewDocument();
  assert.equal(s.docs.length, 1);
  assert.equal(s.docs[0].body.paragraphs.at(-1).text, 'My edit inside Docs');
  s.sheets.get('Feed').getRange(2, 5).setValue('New caption in the sheet');
  s.app.createReviewDocument();
  assert.equal(s.docs.length, 2);
  assert.equal(s.files.get('document_1').trashed, false);
  assert.ok(s.docs[1].body.paragraphs.some(p => p.text === 'New caption in the sheet'));
});

test('changed source file or trashed output triggers a fresh document', () => {
  const s = fixture();
  s.import([1]);
  s.app.createReviewDocument();
  s.files.get('photo_file_1').updated++;
  s.app.createReviewDocument();
  assert.equal(s.docs.length, 2);
  s.files.get('document_2').setTrashed(true);
  s.app.createReviewDocument();
  assert.equal(s.docs.length, 3);
});

test('failed rendering trashes only the new incomplete output', () => {
  const s = fixture();
  s.import([1]);
  s.app.createReviewDocument();
  s.folder([s.addImage(2, {broken: true})]);
  s.app.importPhotos();
  s.app.createReviewDocument();
  assert.match(s.alerts.at(-1), /Invalid image data/);
  assert.equal(s.files.get('document_1').trashed, false);
  assert.equal(s.files.get('document_2').trashed, true);
  assert.equal(s.docProps.values.STUDIO_DOC_ID, 'document_1');
});

test('overlong text fails before creating an output document', () => {
  const s = fixture();
  s.import([1]);
  s.sheets.get('Feed').getRange(2, 5).setValue('A'.repeat(901));
  s.app.createReviewDocument();
  assert.match(s.alerts.at(-1), /900 characters/);
  assert.equal(s.docs.length, 0);
});

test('image sizing preserves aspect ratio and avoids upscaling', () => {
  const {app} = fixture();
  assert.deepEqual(plain(app.fitImage_(1600, 1200)), {width: 413, height: 310});
  assert.deepEqual(plain(app.fitImage_(100, 50)), {width: 100, height: 50});
  assert.deepEqual(plain(app.fitImage_(1000, 2000)), {width: 155, height: 310});
  assert.throws(() => app.fitImage_(0, 500), /dimensions/);
});

for (const accountType of ['hotel', 'restaurant']) {
  test(`vision request uses the actual image, facts and ${accountType} account context`, () => {
    const s = fixture();
    s.import([1]);
    s.set('ACCOUNT_TYPE', accountType);
    s.set('VERIFIED_DETAILS', 'Only confirmed details.');
    s.sheets.get('Feed').getRange(2, 4).setValue('Courtyard in the afternoon.');
    s.app.saveCaptionAssistantKey('sk-test-abcdefghijklmnop');
    s.responses.push(aiDraft());
    s.app.draftEnglishCaptions();
    const req = s.requests[0];
    assert.equal(req.url, 'https://api.openai.com/v1/responses');
    const context = JSON.parse(req.payload.input[0].content[0].text);
    assert.equal(context.account_type, accountType);
    assert.equal(context.photo_facts, 'Courtyard in the afternoon.');
    assert.match(req.payload.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
    assert.equal(Buffer.from(req.payload.input[0].content[1].image_url.split(',')[1], 'base64').toString(), 'image-bytes-photo_file_1');
    assert.match(req.payload.instructions, /caption in English/);
    assert.equal(req.payload.store, false);
    assert.equal(req.options.validateHttpsCertificates, true);
    assert.equal(req.options.followRedirects, false);
    assert.ok(!JSON.stringify(req.payload).includes('sk-test'));
    assert.ok(!JSON.stringify(s.sheets.get('Feed').rows).includes('sk-test'));
    assert.match(s.sheets.get('Feed').rows[1][8], /Courtyard/);
  });
}

test('caption batches save three posts and resume without replacing existing text', () => {
  const s = fixture();
  s.import([1, 2, 3, 4]);
  s.set('ACCOUNT_TYPE', 'hotel');
  s.app.saveCaptionAssistantKey('sk-test-abcdefghijklmnop');
  s.responses.push(aiDraft('First'), aiDraft('Second'), aiDraft('Third'), aiDraft('Fourth'));
  s.app.draftEnglishCaptions();
  assert.equal(s.requests.length, 3);
  assert.equal(s.sheets.get('Feed').rows[4][4], '');
  s.sheets.get('Feed').getRange(2, 5).setValue('My edited caption');
  s.app.draftEnglishCaptions();
  assert.equal(s.requests.length, 4);
  assert.equal(s.sheets.get('Feed').rows[1][4], 'My edited caption');
  assert.equal(s.sheets.get('Feed').rows[4][4], 'Fourth');
});

test('API failure preserves partial progress, hides response secrets, and permits resume', () => {
  const s = fixture();
  s.import([1, 2]);
  s.set('ACCOUNT_TYPE', 'restaurant');
  s.app.saveCaptionAssistantKey('sk-test-abcdefghijklmnop');
  s.responses.push(aiDraft('Saved draft'), response('sensitive-response-content', 429));
  s.app.draftEnglishCaptions();
  assert.equal(s.sheets.get('Feed').rows[1][4], 'Saved draft');
  assert.equal(s.sheets.get('Feed').rows[2][4], '');
  assert.match(s.alerts.at(-1), /1 draft\(s\) saved/);
  assert.match(s.alerts.at(-1), /HTTP 429/);
  assert.ok(!JSON.stringify(s.alerts).includes('sensitive-response-content'));
  s.responses.push(aiDraft('Resumed draft'));
  s.app.draftEnglishCaptions();
  assert.equal(s.sheets.get('Feed').rows[2][4], 'Resumed draft');
});

test('connection errors cannot leak authorization details', () => {
  const s = fixture();
  s.import([1]);
  s.set('ACCOUNT_TYPE', 'hotel');
  s.app.saveCaptionAssistantKey('sk-test-abcdefghijklmnop');
  s.responses.push(new Error('failure including sk-test-abcdefghijklmnop'));
  s.app.draftEnglishCaptions();
  assert.match(s.alerts.at(-1), /could not be reached/);
  assert.ok(!JSON.stringify(s.alerts).includes('sk-test'));
});

test('caption assistant requires account type and key, and disconnect erases the key', () => {
  const s = fixture();
  s.import([1]);
  s.app.draftEnglishCaptions();
  assert.match(s.alerts.at(-1), /ACCOUNT_TYPE/);
  s.set('ACCOUNT_TYPE', 'restaurant');
  s.app.draftEnglishCaptions();
  assert.match(s.alerts.at(-1), /Connect caption assistant first/);
  s.app.saveCaptionAssistantKey('sk-test-abcdefghijklmnop');
  s.app.disconnectCaptionAssistant();
  assert.equal(s.userProps.getProperty('STUDIO_OPENAI_KEY'), null);
  assert.equal(s.requests.length, 0);
});

test('malformed, incomplete, refused and over-limit AI outputs are rejected', () => {
  const {app} = fixture();
  for (const input of ['not JSON', 'null', {status: 'incomplete'}, {status: 'completed', output: []},
    {status: 'completed', output: [{content: [{type: 'refusal', refusal: 'No'}]}]}]) {
    assert.throws(() => app.parseCaptionResponse_(response(input), ''));
  }
  assert.throws(() => app.parseCaptionResponse_(aiDraft('A'.repeat(901)), ''), /900/);
  assert.throws(() => app.parseCaptionResponse_(response('secret-should-not-appear', 401), ''), /HTTP 401/);
  const parsed = app.parseCaptionResponse_(aiDraft(), '#Brand #traveldesign');
  assert.equal(parsed.hashtags, '#Brand #traveldesign');
});

test('formula-like captions are stored as literal text', () => {
  const s = fixture();
  s.import([1]);
  s.set('ACCOUNT_TYPE', 'other');
  s.app.saveCaptionAssistantKey('sk-test-abcdefghijklmnop');
  s.responses.push(aiDraft('=This is a caption, not a formula'));
  s.app.draftEnglishCaptions();
  assert.equal(s.sheets.get('Feed').rows[1][4], '=This is a caption, not a formula');
  assert.match(s.alerts.at(-1), /1 English draft/);
});

test('invalid and duplicate sheet positions or file IDs cannot produce documents', () => {
  const s = fixture();
  s.import([1, 2]);
  const sheet = s.sheets.get('Feed');
  sheet.getRange(3, 1).setValue(1);
  s.app.createReviewDocument();
  assert.match(s.alerts.at(-1), /Duplicate Position/);
  sheet.getRange(3, 1).setValue(0);
  s.app.createReviewDocument();
  assert.match(s.alerts.at(-1), /positive whole number/);
  sheet.getRange(3, 1).setValue(2);
  sheet.getRange(3, 2).setValue('photo_file_1');
  s.app.createReviewDocument();
  assert.match(s.alerts.at(-1), /Duplicate File ID/);
  assert.equal(s.docs.length, 0);
});

test('document lock prevents overlapping operations', () => {
  const s = fixture();
  s.locked = true;
  s.app.importPhotos();
  assert.match(s.alerts.at(-1), /Another Studio action/);
  assert.equal(s.sheets.get('Feed').getLastRow(), 1);
});

test('full workflow endpoint imports, drafts in batches, exports and reuses unchanged output', () => {
  const s = fixture();
  s.folder([4, 1, 3, 2].map(position => s.addImage(position)));
  s.set('ORDER_MODE', 'GRID');
  s.set('ACCOUNT_TYPE', 'hotel');
  s.app.saveCaptionAssistantKey('sk-test-abcdefghijklmnop');
  s.responses.push(aiDraft('Fourth photo caption'), aiDraft('Third photo caption'),
    aiDraft('Second photo caption'), aiDraft('First photo caption'));
  const initialAlertCount = s.alerts.length;

  const imported = s.app.runStudioStep('import');
  assert.equal(imported.remaining, 4);
  assert.equal(typeof imported.message, 'string');
  assert.equal(s.locked, false);
  assert.deepEqual(s.sheets.get('Feed').rows.slice(1).map(row => row[6]), [4, 3, 2, 1]);

  const firstBatch = s.app.runStudioStep('draft');
  assert.equal(firstBatch.remaining, 1);
  assert.equal(s.requests.length, 3);
  assert.equal(s.locked, false);
  const finalBatch = s.app.runStudioStep('draft');
  assert.equal(finalBatch.remaining, 0);
  assert.equal(s.requests.length, 4);
  assert.equal(s.locked, false);
  assert.deepEqual(s.sheets.get('Feed').rows.slice(1).map(row => row[4]),
    ['First photo caption', 'Second photo caption', 'Third photo caption', 'Fourth photo caption']);

  const exported = s.app.runStudioStep('export');
  assert.match(exported.url, /^https:\/\/docs\.google\.com\/document\/d\/document_1\/edit$/);
  assert.equal(typeof exported.message, 'string');
  assert.equal(s.locked, false);
  assert.equal(s.docs[0].body.cleared, true);
  assert.deepEqual(s.docs[0].body.images.map(image => image.id),
    ['photo_file_4', 'photo_file_3', 'photo_file_2', 'photo_file_1']);
  assert.equal(s.docs[0].body.breaks, 3);
  assert.ok(s.docs[0].body.paragraphs.some(paragraph => paragraph.text === 'Fourth photo caption'));

  assert.equal(s.app.runStudioStep('import').remaining, 0);
  assert.equal(s.app.runStudioStep('draft').remaining, 0);
  assert.equal(s.app.runStudioStep('export').url, exported.url);
  assert.equal(s.docs.length, 1);
  assert.equal(s.requests.length, 4);
  assert.equal(s.alerts.length, initialAlertCount, 'RPC steps must not open blocking alert dialogs');
});

test('full workflow can skip the paid caption step and still produce a review document', () => {
  const s = fixture();
  s.folder([s.addImage(1), s.addImage(2)]);
  assert.equal(s.app.runStudioStep('import').remaining, 2);
  const exported = s.app.runStudioStep('export');
  assert.match(exported.url, /document_1/);
  assert.equal(s.requests.length, 0);
  assert.equal(s.docs[0].body.paragraphs.filter(p => p.text === '[Write your English caption here.]').length, 2);
  assert.equal(s.locked, false);
});

test('workflow endpoint rejects unknown steps without keeping the document locked', () => {
  const s = fixture();
  for (const step of ['publish', '', null, {step: 'import'}]) {
    assert.throws(() => s.app.runStudioStep(step), /step/i);
    assert.equal(s.locked, false);
  }
  assert.equal(s.docs.length, 0);
  assert.equal(s.requests.length, 0);
});

test('workflow import failure releases the lock and a corrected import can run', () => {
  const s = fixture();
  s.folder([s.addImage(1), s.addImage(1, {id: 'duplicate_position_file'})]);
  assert.throws(() => s.app.runStudioStep('import'), /Position 1 is already used/);
  assert.equal(s.locked, false);
  assert.equal(s.sheets.get('Feed').getLastRow(), 1);
  s.folder([s.addImage(1)]);
  assert.equal(s.app.runStudioStep('import').remaining, 1);
  assert.equal(s.locked, false);
});

test('workflow draft failure releases the lock, preserves progress and resumes the remaining row', () => {
  const s = fixture();
  s.import([1, 2]);
  s.set('ACCOUNT_TYPE', 'restaurant');
  s.app.saveCaptionAssistantKey('sk-test-abcdefghijklmnop');
  s.responses.push(aiDraft('Saved before API failure'), response('private response body', 429));
  assert.throws(() => s.app.runStudioStep('draft'), /1 draft\(s\) saved.*HTTP 429/);
  assert.equal(s.locked, false);
  assert.equal(s.sheets.get('Feed').rows[1][4], 'Saved before API failure');
  assert.equal(s.sheets.get('Feed').rows[2][4], '');
  assert.equal(s.docs.length, 0, 'Failed drafting must not implicitly export');
  s.responses.push(aiDraft('Resumed after failure'));
  assert.equal(s.app.runStudioStep('draft').remaining, 0);
  assert.equal(s.locked, false);
  assert.equal(s.sheets.get('Feed').rows[2][4], 'Resumed after failure');
});

test('workflow export failure releases its lock and trashes the incomplete output', () => {
  const s = fixture();
  s.folder([s.addImage(1, {broken: true})]);
  s.app.runStudioStep('import');
  assert.throws(() => s.app.runStudioStep('export'), /Invalid image data/);
  assert.equal(s.locked, false);
  assert.equal(s.files.get('document_1').trashed, true);
  assert.equal(s.docProps.getProperty('STUDIO_DOC_ID'), null);
});

test('workflow endpoint never releases a document lock owned by another action', () => {
  const s = fixture();
  s.folder([s.addImage(1)]);
  s.locked = true;
  assert.throws(() => s.app.runStudioStep('import'), /Another Studio action/);
  assert.equal(s.locked, true);
  assert.equal(s.sheets.get('Feed').getLastRow(), 1);
});

test('manifest declares supported runtime and the required Google scopes', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../apps-script/appsscript.json')));
  assert.equal(manifest.runtimeVersion, 'V8');
  for (const scope of ['drive', 'documents', 'script.external_request', 'spreadsheets.currentonly', 'script.container.ui']) {
    assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/' + scope));
  }
});
