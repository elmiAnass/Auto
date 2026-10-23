import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowDataError, parsePlanningUrl, encodeMetadata, decodeMetadata,
  checkedPlanningRows, orderedPosts, exportDigest,
} from '../server/workflow-data.mjs';

const HEADER = ['Publication', 'Page Canva', 'Photo', 'Caption', 'Hashtags'];

function workflow(orderMode = 'GRID', count = 3) {
  return {
    title: 'Planning été', orderMode,
    canvaUrl: 'https://www.canva.com/design/DESIGN_TEST_01/edit', folderId: 'private_folder-123',
    images: Array.from({ length: count }, (_, index) => ({
      id: 'image_' + (index + 1), fileId: 'file_' + (index + 1), mime: 'image/png',
      width: 1080, height: 1350, sourceIndex: index + 1,
      publication: orderMode === 'GRID' ? count - index : index + 1,
      name: 'Photo ' + (index + 1) + ' & <été>.png', sha256: String(index + 1).repeat(64),
    })),
    export: { hash: '', documentId: '' },
  };
}

function planning(value, { captions = true } = {}) {
  return [HEADER.slice(), ...value.images.map(image => [
    image.publication, image.sourceIndex, 'Photo ' + image.sourceIndex,
    captions ? 'Caption ' + image.sourceIndex : '', captions ? '#été #Lieu_' + image.sourceIndex : '',
  ])];
}

function invalid(action, expression) {
  assert.throws(action, error => {
    assert.ok(error instanceof WorkflowDataError);
    assert.equal(error.status, 400);
    if (expression) assert.match(error.message, expression);
    return true;
  });
}

test('planning URLs use the fixed Planning tab and discard edit, gid and other link details', () => {
  const expected = { id: 'sheet_123-abc', url: 'https://docs.google.com/spreadsheets/d/sheet_123-abc/edit' };
  for (const input of [
    'https://docs.google.com/spreadsheets/d/sheet_123-abc',
    'https://docs.google.com/spreadsheets/d/sheet_123-abc/edit?gid=987#gid=654',
    '  https://docs.google.com/spreadsheets/d/sheet_123-abc/edit?usp=sharing  ',
  ]) assert.deepEqual(parsePlanningUrl(input), expected);
});

test('planning URL validation rejects arbitrary hosts, userinfo, every explicit port and invalid IDs', () => {
  for (const input of [
    '', null, {}, 'sheet_123', 'http://docs.google.com/spreadsheets/d/sheet_123/edit',
    'https://docs.google.com.evil.test/spreadsheets/d/sheet_123/edit',
    'https://evil.test/spreadsheets/d/sheet_123/edit',
    'https://user:private@docs.google.com/spreadsheets/d/sheet_123/edit',
    'https://@docs.google.com/spreadsheets/d/sheet_123/edit',
    'https://docs.google.com:443/spreadsheets/d/sheet_123/edit',
    'https://docs.google.com:8443/spreadsheets/d/sheet_123/edit',
    'https://docs.google.com/document/d/sheet_123/edit',
    'https://docs.google.com/spreadsheets/d/é/edit',
    'https://docs.google.com/spreadsheets/d/%61/edit',
    'https://docs.google.com/spreadsheets/d/' + 'x'.repeat(201) + '/edit',
    'https://docs.google.com/spreadsheets/d/id/edit?' + 'x'.repeat(4096),
    'https://docs.google.com/spreadsheets/d/one\n/edit',
  ]) invalid(() => parsePlanningUrl(input), /Google Sheet/);
});

test('metadata is a versioned, exact two-column persistent schema without placeholder captions', () => {
  const value = workflow();
  const rows = encodeMetadata(value);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], ['FeedStudio', '1']);
  assert.deepEqual(JSON.parse(rows[1][1]), {
    title: value.title, orderMode: 'GRID', canvaUrl: value.canvaUrl, folderId: value.folderId,
  });
  assert.deepEqual(rows[2], ['export', '{"hash":"","documentId":""}']);
  assert.deepEqual(rows.slice(3).map(row => row[0]), ['image', 'image', 'image']);
  assert.deepEqual(decodeMetadata(rows), value);
  assert.ok(rows.every(row => row.length === 2));
  assert.ok(!JSON.stringify(rows).includes('caption'));
});

test('metadata normalizes whitespace, Canva fragments and source array order for reload', () => {
  const value = workflow('PUBLICATION');
  value.title = '  Mon feed  ';
  value.canvaUrl += '#private-section';
  value.images.reverse();
  value.export = { hash: 'a'.repeat(64), documentId: 'saved_document' };
  const decoded = decodeMetadata(encodeMetadata(value));
  assert.equal(decoded.title, 'Mon feed');
  assert.ok(!decoded.canvaUrl.includes('#'));
  assert.deepEqual(decoded.images.map(image => image.sourceIndex), [1, 2, 3]);
  assert.deepEqual(decoded.export, value.export);
  assert.deepEqual(value.images.map(image => image.sourceIndex), [3, 2, 1]);
});

test('metadata accepts the maximum 60 images in exactly 63 rows', () => {
  const value = workflow('GRID', 60);
  value.images.forEach(image => { image.sha256 = 'a'.repeat(64); });
  const rows = encodeMetadata(value);
  assert.equal(rows.length, 63);
  assert.equal(decodeMetadata(rows).images.length, 60);
});

test('metadata rejects malformed, unknown, duplicate and missing rows with safe errors', () => {
  const original = encodeMetadata(workflow());
  const cases = [
    [], original.slice(0, 3), [['FeedStudio', '2'], ...original.slice(1)],
    [['FeedStudio', 1], ...original.slice(1)],
    [...original, ['unknown', '{}']],
    [original[0], original[2], original[1], ...original.slice(3)],
    [original[0], ['project', '{private-payload'], ...original.slice(2)],
    [original[0], ['project', 'null'], ...original.slice(2)],
    [original[0], ['project', '[]'], ...original.slice(2)],
    [...original.slice(0, 3), ['image', '{}']],
    [...original.slice(0, 3), ['image', ' '.repeat(4001)]],
    [original[0], ['project', ' '.repeat(8001)], ...original.slice(2)],
    [original[0], original[1], ['export', ' '.repeat(513)], ...original.slice(3)],
    [...original.slice(0, 3), ['image', original[3][1], 'unexpected']],
    [...original, ...Array.from({ length: 60 }, () => original[3])],
  ];
  for (const rows of cases) invalid(() => decodeMetadata(rows));
  try { decodeMetadata([original[0], ['project', '{private-payload'], ...original.slice(2)]); }
  catch (error) { assert.ok(!error.message.includes('private-payload')); }
});

test('metadata encode and decode enforce the same untrusted project, image and export validators', () => {
  const mutations = [
    value => { value.extra = 'unknown'; },
    value => { value.title = ''; },
    value => { value.title = 'x'.repeat(101); },
    value => { value.orderMode = 'REVERSED'; },
    value => { value.canvaUrl = 'https://evil.test/design/ABCDE'; },
    value => { value.canvaUrl += '?' + 'a'.repeat(4096); },
    value => { value.folderId = '../outside'; },
    value => { value.folderId = 'é'; },
    value => { value.images = []; },
    value => { value.images[0].id = 'x'.repeat(101); },
    value => { value.images[1].id = value.images[0].id; },
    value => { value.images[1].fileId = value.images[0].fileId; },
    value => { value.images[0].fileId = 'https://private.test'; },
    value => { value.images[0].fileId = 'x'.repeat(201); },
    value => { value.images[0].mime = 'image/svg+xml'; },
    value => { value.images[0].width = 0; },
    value => { value.images[0].height = -1; },
    value => { value.images[0].width = 1.5; },
    value => { value.images[0].width = Infinity; },
    value => { value.images[0].width = 5001; value.images[0].height = 5000; },
    value => { value.images[0].sourceIndex = 0; },
    value => { value.images[0].sourceIndex = 4; },
    value => { value.images[1].sourceIndex = 1; },
    value => { value.images[0].publication = 1; },
    value => { value.images[0].name = 'x'.repeat(121); },
    value => { value.images[0].sha256 = 'A'.repeat(64); },
    value => { value.images[0].sha256 = 'a'.repeat(63); },
    value => { delete value.images[0].name; },
    value => { value.images[0].arbitraryUrl = 'https://evil.test'; },
    value => { value.export.hash = 'not-a-hash'; },
    value => { value.export.documentId = 'https://evil.test'; },
    value => { value.export = null; },
  ];
  for (const mutate of mutations) {
    const value = workflow();
    mutate(value);
    invalid(() => encodeMetadata(value));
    const project = Object.fromEntries(['title', 'orderMode', 'canvaUrl', 'folderId'].map(key => [key, value[key]]));
    if (value.extra) project.extra = value.extra;
    const rows = [
      ['FeedStudio', '1'], ['project', JSON.stringify(project)], ['export', JSON.stringify(value.export)],
      ...value.images.map(image => ['image', JSON.stringify(image)]),
    ];
    invalid(() => decodeMetadata(rows));
  }
});

for (const mode of ['GRID', 'PUBLICATION']) {
  test(mode + ' maps whole reordered Sheet rows to their original Canva pages', () => {
    const value = workflow(mode);
    const rows = planning(value);
    const reordered = [rows[0], rows[3], [], ['', '', '', ' ', ''], rows[1], rows[2]];
    reordered[1][2] = 'https://untrusted.example/never-fetch-this';
    const posts = checkedPlanningRows(reordered, value);
    assert.deepEqual(posts.map(post => post.sourceIndex), [1, 2, 3]);
    assert.deepEqual(posts.map(post => post.caption), ['Caption 1', 'Caption 2', 'Caption 3']);
    assert.deepEqual(posts.map(post => post.fileId), ['file_1', 'file_2', 'file_3']);
    const ordered = orderedPosts(posts, mode);
    assert.deepEqual(ordered.map(post => post.sourceIndex), mode === 'GRID' ? [3, 2, 1] : [1, 2, 3]);
    assert.deepEqual(ordered.map(post => post.publication), [1, 2, 3]);
    assert.deepEqual(posts.map(post => post.sourceIndex), [1, 2, 3]);
  });
}

test('blank caption and hashtags remain blank, with no generated filler', () => {
  const value = workflow();
  const rows = planning(value, { captions: false });
  rows[1].length = 3;
  const posts = checkedPlanningRows(rows, value);
  assert.ok(posts.every(post => post.caption === '' && post.hashtags === ''));
});

test('planning captions normalize line endings and tabs and keep leading equals literal', () => {
  const value = workflow('PUBLICATION', 1), rows = planning(value);
  rows[1][0] = '1'; rows[1][1] = '1';
  rows[1][3] = '  =SUM(A1:A2)\r\nÉté\tfrançais\rالعربية  ';
  rows[1][4] = '#Été, #العربية\n#東京 #Lieu_2026';
  const [post] = checkedPlanningRows(rows, value);
  assert.equal(post.caption, '=SUM(A1:A2)\nÉté français\nالعربية');
  assert.equal(post.hashtags, '#Été #العربية #東京 #Lieu_2026');
});

test('planning rejects invalid headers, mappings, missing or extra pages and malformed row cells', () => {
  const cases = [
    { mutate: rows => { rows[0][1] = 'Page'; }, expression: /Ligne 1, en-tête/ },
    { mutate: rows => { rows[1][0] = 1; }, expression: /Ligne 2, Publication/ },
    { mutate: rows => { rows[1][1] = 4; }, expression: /Ligne 2, Page Canva/ },
    { mutate: rows => { rows[1][0] = 1.5; }, expression: /Ligne 2, Publication/ },
    { mutate: rows => { rows[1][1] = '1e0'; }, expression: /Ligne 2, Page Canva/ },
    { mutate: rows => { rows[1][1] = true; }, expression: /Ligne 2, Page Canva/ },
    { mutate: rows => { rows[2] = rows[1].slice(); }, expression: /Ligne 3, Page Canva.*plusieurs/ },
    { mutate: rows => { rows.pop(); }, expression: /Page Canva.*absente/ },
    { mutate: rows => { rows.push([4, 4, 'Photo 4']); }, expression: /Ligne 5, Page Canva/ },
    { mutate: rows => { rows[1].push('extra'); }, expression: /Ligne 2, Planning/ },
    { mutate: rows => { rows[1] = {}; }, expression: /Ligne 2, Planning/ },
    { mutate: rows => { rows[1][2] = {}; }, expression: /Ligne 2, Photo/ },
    { mutate: rows => { rows[1][3] = 123; }, expression: /Ligne 2, Caption/ },
    { mutate: rows => { rows[1][4] = true; }, expression: /Ligne 2, Hashtags/ },
  ];
  for (const { mutate, expression } of cases) {
    const value = workflow(), rows = planning(value);
    mutate(rows);
    invalid(() => checkedPlanningRows(rows, value), expression);
  }
  invalid(() => checkedPlanningRows(Array.from({ length: 1001 }, () => []), workflow()), /nombre de lignes/);
});

test('caption limits allow exactly 900 characters and six lines and reject longer text without truncation', () => {
  const value = workflow('PUBLICATION', 1), rows = planning(value);
  rows[1][3] = 'é'.repeat(900);
  assert.equal(checkedPlanningRows(rows, value)[0].caption.length, 900);
  rows[1][3] += 'é';
  invalid(() => checkedPlanningRows(rows, value), /Ligne 2, Caption.*900/);
  rows[1][3] = Array.from({ length: 6 }, () => 'Ligne').join('\r\n');
  assert.equal(checkedPlanningRows(rows, value)[0].caption.split('\n').length, 6);
  rows[1][3] += '\r\nSeptième';
  invalid(() => checkedPlanningRows(rows, value), /Ligne 2, Caption.*6 lignes/);
});

test('hashtags enforce count, characters, case-insensitive uniqueness and both length bounds', () => {
  const value = workflow('PUBLICATION', 1), rows = planning(value);
  rows[1][4] = '#' + 'é'.repeat(60) + ' #Deux #三 #أربعة #cinq_5';
  assert.equal(checkedPlanningRows(rows, value)[0].hashtags, rows[1][4]);
  for (const text of [
    '#a #b #c #d #e #f', '#Paris #PARIS', '#Été #ÉTÉ', 'sans_diese', '#',
    '#a-b', '#emoji😀', '#avec.point', '#' + 'a'.repeat(61),
    '#a' + ' '.repeat(319) + '#b',
  ]) {
    rows[1][4] = text;
    invalid(() => checkedPlanningRows(rows, value), /Ligne 2, Hashtags/);
  }
  rows[1][4] = '#a' + ' '.repeat(316) + '#b';
  assert.equal(rows[1][4].length, 320);
  assert.equal(checkedPlanningRows(rows, value)[0].hashtags, '#a #b');
});

test('ordering rejects bad modes, missing pages and publication mismatches before export', () => {
  const value = workflow(), posts = checkedPlanningRows(planning(value), value);
  invalid(() => orderedPosts(posts, 'arbitrary'));
  invalid(() => orderedPosts([], 'GRID'));
  invalid(() => orderedPosts([posts[0], posts[0], posts[2]], 'GRID'));
  invalid(() => orderedPosts([{ ...posts[0], publication: 1 }, ...posts.slice(1)], 'GRID'));
  invalid(() => orderedPosts(posts.slice(1), 'GRID'));
});

test('export digest is stable across Sheet or metadata row reorder and ignores previous export state', () => {
  const value = workflow(), rows = planning(value), posts = checkedPlanningRows(rows, value);
  const hash = exportDigest(value, posts);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(exportDigest(value, [posts[2], posts[0], posts[1]]), hash);
  const reordered = [rows[0], rows[2], [], rows[3], rows[1]];
  assert.equal(exportDigest(value, checkedPlanningRows(reordered, value)), hash);
  const resumed = structuredClone(value);
  resumed.images.reverse();
  resumed.export = { hash: 'f'.repeat(64), documentId: 'previous_document' };
  resumed.folderId = 'another_private_folder';
  resumed.canvaUrl = 'https://canva.link/another_design';
  assert.equal(exportDigest(resumed, posts), hash);
});

test('export digest changes when document content, source image identities or image hashes change', () => {
  const original = workflow();
  const hash = exportDigest(original, checkedPlanningRows(planning(original), original));
  const mutations = [
    value => { value.title = 'Un autre titre'; },
    value => { value.orderMode = 'PUBLICATION'; value.images.forEach(image => { image.publication = image.sourceIndex; }); },
    value => { value.images[0].fileId = 'a_new_private_image'; },
    value => { value.images[0].sha256 = 'a'.repeat(64); },
    value => { value.images[0].id = 'a_new_image_identity'; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(original);
    mutate(value);
    assert.notEqual(exportDigest(value, checkedPlanningRows(planning(value), value)), hash);
  }
  const posts = checkedPlanningRows(planning(original), original);
  posts[0].caption = 'Un texte modifié';
  assert.notEqual(exportDigest(original, posts), hash);
  posts[0].caption = 'Caption 1'; posts[0].hashtags = '#autre';
  assert.notEqual(exportDigest(original, posts), hash);
});

test('export digest rejects invalid texts and tampered image mapping rather than hashing unsafe data', () => {
  const value = workflow(), posts = checkedPlanningRows(planning(value), value);
  invalid(() => exportDigest(value, [{ ...posts[0], fileId: 'other_file' }, ...posts.slice(1)]), /métadonnées/);
  invalid(() => exportDigest(value, [{ ...posts[0], caption: 'x'.repeat(901) }, ...posts.slice(1)]), /Caption/);
  invalid(() => exportDigest(value, [{ ...posts[0], hashtags: '#tag #TAG' }, ...posts.slice(1)]), /Hashtags/);
  invalid(() => exportDigest(value, posts.slice(1)));
});
