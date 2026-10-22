/* Small, dependency-free DOCX writer. Media stays local and at original quality. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InstagramDocx = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  var encoder = new TextEncoder();
  var crcTable = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var bit = 0; bit < 8; bit++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var index = 0; index < bytes.length; index++) crc = crcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function xmlText(input) {
    var clean = '';
    for (var character of String(input == null ? '' : input)) {
      var code = character.codePointAt(0);
      if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xD7FF) ||
          (code >= 0xE000 && code <= 0xFFFD) || (code >= 0x10000 && code <= 0x10FFFF)) clean += character;
    }
    return clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function zip(files) {
    var parts = [], central = [], offset = 0, directorySize = 0;
    files.forEach(function (file) {
      var name = encoder.encode(file.name);
      var data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
      var crc = crc32(data);
      var header = new Uint8Array(30 + name.length);
      var view = new DataView(header.buffer);
      view.setUint32(0, 0x04034B50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true); // UTF-8 filenames.
      view.setUint16(10, 0, true);
      view.setUint16(12, 33, true); // 1980-01-01, a valid DOS date.
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, name.length, true);
      header.set(name, 30);
      parts.push(header, data);

      var entry = new Uint8Array(46 + name.length);
      var entryView = new DataView(entry.buffer);
      entryView.setUint32(0, 0x02014B50, true);
      entryView.setUint16(4, 20, true);
      entryView.setUint16(6, 20, true);
      entryView.setUint16(8, 0x0800, true);
      entryView.setUint16(14, 33, true);
      entryView.setUint32(16, crc, true);
      entryView.setUint32(20, data.length, true);
      entryView.setUint32(24, data.length, true);
      entryView.setUint16(28, name.length, true);
      entryView.setUint32(42, offset, true);
      entry.set(name, 46);
      central.push(entry);
      directorySize += entry.length;
      offset += header.length + data.length;
    });
    if (offset + directorySize > 0xFFFFFFFF) throw new Error('The document is too large to export.');
    var end = new Uint8Array(22);
    var endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054B50, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, directorySize, true);
    endView.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [end]), {type: MIME});
  }

  function fittedImage(width, height, maxHeight) {
    var factor = Math.min(1, 420 / width, (maxHeight || 310) / height);
    return {width: Math.max(1, Math.floor(width * factor)), height: Math.max(1, Math.floor(height * factor))};
  }

  function validatePost(post, index) {
    if (!post || ['image/jpeg', 'image/png'].indexOf(post.mime) < 0) throw new Error('Photo ' + (index + 1) + ': use JPG or PNG.');
    if (!(post.bytes instanceof Uint8Array) || !post.bytes.length) throw new Error('Photo ' + (index + 1) + ': image data is missing.');
    if (post.bytes.length > 8 * 1024 * 1024) throw new Error('Photo ' + (index + 1) + ': maximum image size is 8 MB.');
    if (!Number.isFinite(post.width) || !Number.isFinite(post.height) || post.width <= 0 || post.height <= 0) {
      throw new Error('Photo ' + (index + 1) + ': image dimensions are invalid.');
    }
    var caption = String(post.caption || '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim();
    if (caption.length > 900 || caption.split('\n').length > 6) throw new Error('Photo ' + (index + 1) + ': keep the caption within 900 characters and 6 lines.');
    var hashtags = String(post.hashtags || '').trim();
    var tags = hashtags ? hashtags.split(/\s+/) : [];
    if (tags.length > 5 || tags.some(function (tag) { return !/^#[\p{L}\p{N}_]{1,60}$/u.test(tag); })) {
      throw new Error('Photo ' + (index + 1) + ': use at most 5 valid hashtags, separated by spaces.');
    }
    return {caption: caption, hashtags: tags.join(' ')};
  }

  function run(text, bold) {
    return '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/>' +
      (bold ? '<w:b/>' : '') + '</w:rPr>' + String(text).split('\n').map(function (line, i) {
        return (i ? '<w:br/>' : '') + '<w:t xml:space="preserve">' + xmlText(line) + '</w:t>';
      }).join('') + '</w:r>';
  }

  function paragraph(text, bold, before, after) {
    return '<w:p><w:pPr><w:spacing w:before="' + (before || 0) + '" w:after="' + (after || 0) +
      '" w:line="264" w:lineRule="auto"/></w:pPr>' + run(text, bold) + '</w:p>';
  }

  function drawing(post, index, text) {
    // Reserve space conservatively for wide letters and long hashtag words.
    // Long captions get a smaller displayed image; its original bytes are kept.
    var captionLines = text.caption.split('\n').reduce(function (sum, line) {
      return sum + Math.max(1, Math.ceil(line.length / 44));
    }, 0);
    var tagLines = text.hashtags ? text.hashtags.split(' ').reduce(function (sum, tag) {
      return sum + Math.ceil(tag.length / 44);
    }, 0) : 1;
    var imageHeight = Math.max(120, Math.min(310, 660 - 14 * (captionLines + tagLines)));
    var size = fittedImage(post.width, post.height, imageHeight);
    var cx = size.width * 12700, cy = size.height * 12700;
    var number = index + 1;
    return '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="140"/></w:pPr><w:r><w:drawing>' +
      '<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="' + number + '" name="Photo ' + number +
      '" descr="' + xmlText(post.name || 'Photo ' + number) + '"/><wp:cNvGraphicFramePr>' +
      '<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>' +
      '</wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr>' +
      '<pic:cNvPr id="' + number + '" name="image' + number + '"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill>' +
      '<a:blip r:embed="rIdImage' + number + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr>' +
      '<a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>' +
      '</wp:inline></w:drawing></w:r></w:p>';
  }

  async function buildDocument(posts, options) {
    if (!Array.isArray(posts) || !posts.length || posts.length > 60) throw new Error('Choose between 1 and 60 photos.');
    options = options || {};
    var text = posts.map(validatePost);
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    var document = xml + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>';
    var relationships = xml + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    var media = [];
    posts.forEach(function (post, index) {
      var number = index + 1;
      var extension = post.mime === 'image/png' ? 'png' : 'jpeg';
      var imagePath = 'media/image' + number + '.' + extension;
      media.push({name: 'word/' + imagePath, data: post.bytes});
      relationships += '<Relationship Id="rIdImage' + number + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' + imagePath + '"/>';
      document += '<w:p><w:pPr>' + (index ? '<w:pageBreakBefore/>' : '') +
        '<w:keepNext/><w:spacing w:before="0" w:after="160"/></w:pPr>' + run('POST ' + String(number).padStart(2, '0'), true) + '</w:p>';
      document += drawing(post, index, text[index]);
      document += paragraph('Caption (English)', true, 120, 80);
      document += paragraph(text[index].caption || '[Write your English caption here.]', false, 0, 180);
      document += paragraph('Hashtags', true, 0, 80);
      document += paragraph(text[index].hashtags || '[Add hashtags here.]', false, 0, 0);
    });
    document += '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="840" w:bottom="720" w:left="840" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>';
    relationships += '</Relationships>';
    var contentTypes = xml + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
    var packageRelationships = xml + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
    var core = xml + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' + xmlText(options.title || 'Instagram feed') +
      '</dc:title><dc:subject>' + xmlText(options.accountType || '') + '</dc:subject><dc:creator>Instagram Studio</dc:creator></cp:coreProperties>';
    return zip([
      {name: '[Content_Types].xml', data: contentTypes},
      {name: '_rels/.rels', data: packageRelationships},
      {name: 'word/document.xml', data: document},
      {name: 'word/_rels/document.xml.rels', data: relationships},
      {name: 'docProps/core.xml', data: core}
    ].concat(media));
  }

  return {buildDocument: buildDocument, fittedImage: fittedImage, xmlText: xmlText};
}));
