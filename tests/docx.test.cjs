const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {buildDocument, fittedImage, xmlText} = require('../web/docx.js');

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNYkOIGAALyAUvBFwg1AAAAAElFTkSuQmCC', 'base64'));
function post(options = {}) {
  return {id: 'one', name: '01 - courtyard.png', bytes: png, mime: 'image/png', width: 1080, height: 1350,
    caption: 'Warm light, quiet corners.', hashtags: '#HotelDesign #SlowTravel', ...options};
}

// Independent straightforward CRC implementation for verifying the archive writer.
function crc32(bytes) {
  let checksum = 0xFFFFFFFF;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = checksum & 1 ? (checksum >>> 1) ^ 0xEDB88320 : checksum >>> 1;
  }
  return (checksum ^ 0xFFFFFFFF) >>> 0;
}

async function unzip(blob) {
  const data = Buffer.from(await blob.arrayBuffer());
  assert.equal(data.readUInt32LE(data.length - 22), 0x06054B50);
  const directoryOffset = data.readUInt32LE(data.length - 6);
  const count = data.readUInt16LE(data.length - 12);
  const entries = new Map();
  let local = 0;
  for (let index = 0; index < count; index++) {
    assert.equal(data.readUInt32LE(local), 0x04034B50);
    assert.equal(data.readUInt16LE(local + 8), 0); // Stored, no compression.
    const size = data.readUInt32LE(local + 18);
    assert.equal(data.readUInt32LE(local + 22), size);
    const nameLength = data.readUInt16LE(local + 26);
    const extraLength = data.readUInt16LE(local + 28);
    const name = data.subarray(local + 30, local + 30 + nameLength).toString();
    const start = local + 30 + nameLength + extraLength;
    const contents = data.subarray(start, start + size);
    assert.equal(data.readUInt32LE(local + 14), crc32(contents));
    entries.set(name, contents);
    local = start + size;
  }
  assert.equal(local, directoryOffset);
  let directory = directoryOffset;
  for (const [name] of entries) {
    assert.equal(data.readUInt32LE(directory), 0x02014B50);
    const nameLength = data.readUInt16LE(directory + 28);
    const extraLength = data.readUInt16LE(directory + 30);
    const commentLength = data.readUInt16LE(directory + 32);
    assert.equal(data.subarray(directory + 46, directory + 46 + nameLength).toString(), name);
    const originalOffset = data.readUInt32LE(directory + 42);
    assert.equal(data.readUInt32LE(originalOffset), 0x04034B50);
    directory += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(directory, data.length - 22);
  return entries;
}

test('exports a valid stored ZIP with complete DOCX package relationships and original media', async () => {
  const blob = await buildDocument([post()], {title: 'Hotel & courtyard', accountType: 'hotel'});
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const entries = await unzip(blob);
  assert.equal(entries.size, 6);
  assert.deepEqual(entries.get('word/media/image1.png'), Buffer.from(png));
  assert.match(entries.get('[Content_Types].xml').toString(), /wordprocessingml.document.main\+xml/);
  assert.match(entries.get('_rels/.rels').toString(), /Target="word\/document.xml"/);
  assert.match(entries.get('word/_rels/document.xml.rels').toString(), /Id="rIdImage1"[^>]+Target="media\/image1.png"/);
  assert.match(entries.get('docProps/core.xml').toString(), /Hotel &amp; courtyard/);
});

test('keeps caller order, inserts exactly one page break between posts, and no trailing break', async () => {
  const entries = await unzip(await buildDocument([
    post({id: 'last', caption: 'Publish this first.'}),
    post({id: 'middle', caption: 'Publish this second.'}),
    post({id: 'first', caption: 'Publish this third.'})
  ]));
  const xml = entries.get('word/document.xml').toString();
  assert.equal((xml.match(/<w:pageBreakBefore\/>/g) || []).length, 2);
  assert.equal((xml.match(/<wp:docPr /g) || []).length, 3);
  assert.match(xml, /POST 01/);
  assert.match(xml, /POST 03/);
  assert.ok(xml.indexOf('Publish this first.') < xml.indexOf('Publish this second.'));
  assert.ok(xml.indexOf('Publish this second.') < xml.indexOf('Publish this third.'));
  assert.match(xml, /<wp:docPr id="1"/);
  assert.match(xml, /<wp:docPr id="2"/);
  assert.match(xml, /<wp:docPr id="3"/);
  assert.ok(!xml.slice(xml.indexOf('Publish this third.')).includes('pageBreakBefore'));
  assert.equal((xml.match(/<w:sectPr>/g) || []).length, 1);
  assert.match(xml, /w:pgSz w:w="11906" w:h="16838"/);
});

test('empty fields produce editable caption/hashtag placeholders on the same post', async () => {
  const entries = await unzip(await buildDocument([post({caption: '', hashtags: ''})]));
  const xml = entries.get('word/document.xml').toString();
  assert.match(xml, /\[Write your English caption here\.\]/);
  assert.match(xml, /\[Add hashtags here\.\]/);
  assert.equal((xml.match(/pageBreakBefore/g) || []).length, 0);
});

test('escapes text and attributes, filters invalid XML characters, and preserves emoji and line breaks', async () => {
  const entries = await unzip(await buildDocument([post({
    name: 'A "courtyard" <view> & detail\u0000.png', caption: 'A & B <sun> "warm"\nTravel 🌴\u0000\u000B\uFFFF\uD800',
    hashtags: '#HotelDesign'
  })], {title: '<Private> & "title"\u0001'}));
  const xml = entries.get('word/document.xml').toString();
  assert.match(xml, /A &amp; B &lt;sun&gt; &quot;warm&quot;/);
  assert.match(xml, /descr="A &quot;courtyard&quot; &lt;view&gt; &amp; detail.png"/);
  assert.match(xml, /<w:br\/>/);
  assert.ok(xml.includes('Travel 🌴'));
  assert.ok(!/[\u0000\u000B\uFFFF\uD800]/.test(xml));
  assert.equal(xmlText("' < & > \""), '&apos; &lt; &amp; &gt; &quot;');
});

test('sizes portrait, landscape and small images without stretching or upscaling', async () => {
  assert.deepEqual(fittedImage(1000, 2000), {width: 155, height: 310});
  assert.deepEqual(fittedImage(2000, 1000), {width: 420, height: 210});
  assert.deepEqual(fittedImage(120, 80), {width: 120, height: 80});
  const entries = await unzip(await buildDocument([post({width: 1000, height: 2000})]));
  assert.match(entries.get('word/document.xml').toString(), /<wp:extent cx="1968500" cy="3937000"/);
});

test('rejects empty/oversized feeds, unsupported images, bad dimensions and missing bytes', async () => {
  for (const input of [[], null, Array.from({length: 61}, () => post())]) {
    await assert.rejects(buildDocument(input), /1 and 60/);
  }
  await assert.rejects(buildDocument([post({mime: 'image/webp'})]), /JPG or PNG/);
  await assert.rejects(buildDocument([post({bytes: new Uint8Array()})]), /missing/);
  await assert.rejects(buildDocument([post({width: NaN})]), /dimensions/);
  await assert.rejects(buildDocument([post({height: 0})]), /dimensions/);
  await assert.rejects(buildDocument([post({bytes: new Uint8Array(8 * 1024 * 1024 + 1)})]), /8 MB/);
});

test('rejects text that cannot fit the intended review layout', async () => {
  await assert.rejects(buildDocument([post({caption: 'A'.repeat(901)})]), /900 characters/);
  await assert.rejects(buildDocument([post({caption: 'One\nTwo\nThree\nFour\nFive\nSix\nSeven'})]), /6 lines/);
  await assert.rejects(buildDocument([post({hashtags: '#one #two #three #four #five #six'})]), /5 valid hashtags/);
  await assert.rejects(buildDocument([post({hashtags: 'not-a-hashtag'})]), /valid hashtags/);
});

test('long allowed text reduces displayed image height to reserve a single post page', async () => {
  const caption = Array(6).fill('W'.repeat(149)).join('\n');
  const hashtags = Array.from({length: 5}, (_, i) => '#' + i + 'W'.repeat(59)).join(' ');
  const entries = await unzip(await buildDocument([post({caption, hashtags})]));
  const xml = entries.get('word/document.xml').toString();
  const height = Number(xml.match(/<wp:extent cx="\d+" cy="(\d+)"/)[1]) / 12700;
  assert.ok(height < 220, 'Reserve text space instead of pushing hashtags onto a new page.');
  assert.deepEqual(entries.get('word/media/image1.png'), Buffer.from(png));
});

test('supports JPEG and PNG relationships without re-encoding media', async () => {
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]);
  const entries = await unzip(await buildDocument([post(), post({mime: 'image/jpeg', bytes: jpeg})]));
  assert.deepEqual(entries.get('word/media/image2.jpeg'), Buffer.from(jpeg));
  assert.match(entries.get('[Content_Types].xml').toString(), /Extension="jpeg" ContentType="image\/jpeg"/);
  assert.match(entries.get('word/_rels/document.xml.rels').toString(), /Target="media\/image2.jpeg"/);
});

test('browser-global build works without require/module or external scripts', async () => {
  const context = vm.createContext({Blob, TextEncoder, Uint8Array, DataView, Number});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/docx.js'), 'utf8'), context);
  assert.equal(typeof context.InstagramDocx.buildDocument, 'function');
  const blob = await context.InstagramDocx.buildDocument([post()]);
  const entries = await unzip(blob);
  assert.ok(entries.has('word/document.xml'));
});
