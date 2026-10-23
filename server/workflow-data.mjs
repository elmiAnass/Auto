import { createHash } from 'node:crypto';
import { validateCanvaUrl } from './providers.mjs';

const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const IMAGE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MODES = new Set(['GRID', 'PUBLICATION']);
const HEADER = ['Publication', 'Page Canva', 'Photo', 'Caption', 'Hashtags'];
const PROJECT_KEYS = ['title', 'orderMode', 'canvaUrl', 'folderId'];
const IMAGE_KEYS = ['id', 'fileId', 'mime', 'width', 'height', 'sourceIndex', 'publication', 'name', 'sha256'];
const EXPORT_KEYS = ['hash', 'documentId'];
const WORKFLOW_KEYS = [...PROJECT_KEYS, 'images', 'export'];
const MAX_IMAGES = 60;
const MAX_METADATA_ROWS = 3 + MAX_IMAGES;
const MAX_PLANNING_ROWS = 1000;

export class WorkflowDataError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'WorkflowDataError';
    this.status = status;
  }
}

function fail(message) { throw new WorkflowDataError(message); }

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys, description) {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    fail(description + ' : structure invalide.');
  }
}

function validId(value, expression = DRIVE_ID) {
  return typeof value === 'string' && expression.test(value);
}

export function parsePlanningUrl(input) {
  const message = 'Collez le lien HTTPS du Google Sheet de planning créé par Feed Studio.';
  if (typeof input !== 'string' || !input.length || input.length > 4096 || /[\u0000-\u0020\u007f]/.test(input.trim())) fail(message);
  const trimmed = input.trim();
  // Check the authority before URL normalization: even an explicit default port
  // or empty user information is outside the accepted link format.
  if (!/^https:\/\/docs\.google\.com\//i.test(trimmed)) fail(message);
  let url;
  try { url = new URL(trimmed); } catch { fail(message); }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.username || url.password || url.port) fail(message);
  const match = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{1,200})(?:\/[^\\]*)?$/.exec(url.pathname);
  if (!match) fail(message);
  return { id: match[1], url: 'https://docs.google.com/spreadsheets/d/' + match[1] + '/edit' };
}

function normalizedWorkflow(value) {
  exactKeys(value, WORKFLOW_KEYS, 'Métadonnées du projet');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 100) {
    fail('Métadonnées du projet : le titre doit contenir de 1 à 100 caractères.');
  }
  if (!MODES.has(value.orderMode)) fail('Métadonnées du projet : ordre de publication invalide.');
  let canvaUrl;
  try { canvaUrl = validateCanvaUrl(value.canvaUrl).href; }
  catch { fail('Métadonnées du projet : lien Canva invalide.'); }
  if (canvaUrl.length > 4096) fail('Métadonnées du projet : lien Canva trop long.');
  if (!validId(value.folderId)) fail('Métadonnées du projet : identifiant du dossier Drive invalide.');
  if (!Array.isArray(value.images) || !value.images.length || value.images.length > MAX_IMAGES) {
    fail('Métadonnées du projet : utilisez de 1 à 60 photos.');
  }
  exactKeys(value.export, EXPORT_KEYS, "Métadonnées de l’export");
  if (typeof value.export.hash !== 'string' || (value.export.hash !== '' && !SHA256.test(value.export.hash)) ||
      typeof value.export.documentId !== 'string' || (value.export.documentId !== '' && !validId(value.export.documentId))) {
    fail('Métadonnées de l’export : empreinte ou identifiant du document invalide.');
  }
  const ids = new Set(), fileIds = new Set(), sources = new Set();
  const images = value.images.map((image, index) => {
    const description = 'Métadonnées de la photo ' + (index + 1);
    exactKeys(image, IMAGE_KEYS, description);
    if (!validId(image.id, IMAGE_ID) || !validId(image.fileId) || ids.has(image.id) || fileIds.has(image.fileId)) {
      fail(description + ' : identifiant invalide ou dupliqué.');
    }
    if (!['image/png', 'image/jpeg'].includes(image.mime)) fail(description + ' : format PNG ou JPEG requis.');
    if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width <= 0 || image.height <= 0 ||
        image.width * image.height > 25_000_000) fail(description + ' : dimensions invalides ou supérieures à 25 mégapixels.');
    if (!Number.isInteger(image.sourceIndex) || image.sourceIndex < 1 || image.sourceIndex > value.images.length || sources.has(image.sourceIndex)) {
      fail(description + ' : numéro de page Canva invalide ou dupliqué.');
    }
    const publication = value.orderMode === 'GRID' ? value.images.length - image.sourceIndex + 1 : image.sourceIndex;
    if (image.publication !== publication) fail(description + ' : numéro de publication incompatible avec la page Canva.');
    if (typeof image.name !== 'string' || image.name.length > 120) fail(description + ' : nom limité à 120 caractères.');
    if (typeof image.sha256 !== 'string' || !SHA256.test(image.sha256)) fail(description + ' : empreinte SHA-256 invalide.');
    ids.add(image.id); fileIds.add(image.fileId); sources.add(image.sourceIndex);
    return Object.fromEntries(IMAGE_KEYS.map(key => [key, image[key]]));
  }).sort((a, b) => a.sourceIndex - b.sourceIndex);
  return {
    title: value.title.trim(), orderMode: value.orderMode, canvaUrl, folderId: value.folderId,
    images, export: { hash: value.export.hash, documentId: value.export.documentId },
  };
}

export function encodeMetadata(workflow) {
  const value = normalizedWorkflow(workflow);
  return [
    ['FeedStudio', '1'],
    ['project', JSON.stringify(Object.fromEntries(PROJECT_KEYS.map(key => [key, value[key]])))],
    ['export', JSON.stringify(value.export)],
    ...value.images.map(image => ['image', JSON.stringify(image)]),
  ];
}

function metadataJson(row, kind, rowIndex, maximum) {
  if (!Array.isArray(row) || row.length !== 2 || row[0] !== kind || typeof row[1] !== 'string' || row[1].length > maximum) {
    fail('Métadonnées, ligne ' + (rowIndex + 1) + ' : entrée ' + kind + ' invalide.');
  }
  try { return JSON.parse(row[1]); }
  catch { fail('Métadonnées, ligne ' + (rowIndex + 1) + ' : JSON invalide.'); }
}

export function decodeMetadata(rows) {
  if (!Array.isArray(rows) || rows.length < 4 || rows.length > MAX_METADATA_ROWS ||
      !Array.isArray(rows[0]) || rows[0].length !== 2 || rows[0][0] !== 'FeedStudio' || rows[0][1] !== '1') {
    fail('Métadonnées Feed Studio absentes, invalides ou de version incompatible.');
  }
  const project = metadataJson(rows[1], 'project', 1, 8000);
  const previousExport = metadataJson(rows[2], 'export', 2, 512);
  exactKeys(project, PROJECT_KEYS, 'Métadonnées du projet');
  return normalizedWorkflow({
    ...project,
    images: rows.slice(3).map((row, index) => metadataJson(row, 'image', index + 3, 4000)),
    export: previousExport,
  });
}

function rowError(row, field, message) { fail('Ligne ' + row + ', ' + field + ' : ' + message); }

function blank(value) { return value == null || (typeof value === 'string' && !value.trim()); }

function planningInteger(value, row, field) {
  const number = typeof value === 'string' && /^[1-9][0-9]{0,2}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isInteger(number) || number < 1 || number > MAX_IMAGES) rowError(row, field, 'entier de 1 à 60 requis.');
  return number;
}

function checkedText(captionValue, hashtagValue, row) {
  if (!blank(captionValue) && typeof captionValue !== 'string') rowError(row, 'Caption', 'texte requis.');
  if (!blank(hashtagValue) && typeof hashtagValue !== 'string') rowError(row, 'Hashtags', 'texte requis.');
  // Match the DOCX renderer so the validated text and exported text are identical.
  const caption = String(captionValue ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim();
  if (caption.length > 900 || caption.split('\n').length > 6) rowError(row, 'Caption', '900 caractères et 6 lignes maximum.');
  const rawTags = String(hashtagValue ?? '').trim();
  if (rawTags.length > 320) rowError(row, 'Hashtags', '320 caractères maximum.');
  const tags = rawTags ? rawTags.split(/[\s,]+/u).filter(Boolean) : [];
  if (tags.length > 5) rowError(row, 'Hashtags', '5 hashtags maximum.');
  const seen = new Set();
  for (const tag of tags) {
    if (!/^#[\p{L}\p{N}_]{1,60}$/u.test(tag)) rowError(row, 'Hashtags', 'chaque hashtag doit commencer par # et contenir de 1 à 60 lettres, chiffres ou _.');
    const key = tag.toLowerCase();
    if (seen.has(key)) rowError(row, 'Hashtags', 'les hashtags doivent être uniques, sans distinction de casse.');
    seen.add(key);
  }
  return { caption, hashtags: tags.join(' ') };
}

export function checkedPlanningRows(rows, workflow) {
  const value = normalizedWorkflow(workflow);
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_PLANNING_ROWS) fail('Planning : nombre de lignes invalide.');
  if (!Array.isArray(rows[0]) || rows[0].length !== HEADER.length || HEADER.some((heading, index) => rows[0][index] !== heading)) {
    rowError(1, 'en-tête', 'conservez Publication, Page Canva, Photo, Caption et Hashtags.');
  }
  const bySource = new Map(value.images.map(image => [image.sourceIndex, image]));
  const seen = new Set(), posts = [];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index], rowNumber = index + 1;
    if (!Array.isArray(row)) rowError(rowNumber, 'Planning', 'ligne invalide.');
    if (row.every(blank)) continue;
    if (row.length > HEADER.length) rowError(rowNumber, 'Planning', '5 colonnes maximum.');
    const publication = planningInteger(row[0], rowNumber, 'Publication');
    const sourceIndex = planningInteger(row[1], rowNumber, 'Page Canva');
    const image = bySource.get(sourceIndex);
    if (!image) rowError(rowNumber, 'Page Canva', 'cette page ne fait pas partie du projet.');
    if (seen.has(sourceIndex)) rowError(rowNumber, 'Page Canva', 'cette page apparaît plusieurs fois.');
    if (publication !== image.publication) rowError(rowNumber, 'Publication', 'le numéro ne correspond pas à la page Canva.');
    // Photo is display-only. Its content never chooses a Drive file or URL.
    if (!blank(row[2]) && typeof row[2] !== 'string') rowError(rowNumber, 'Photo', 'libellé texte requis.');
    posts.push({ ...image, ...checkedText(row[3], row[4], rowNumber) });
    seen.add(sourceIndex);
  }
  const missing = value.images.find(image => !seen.has(image.sourceIndex));
  if (missing) rowError(rows.length + 1, 'Page Canva', 'la page ' + missing.sourceIndex + ' est absente du planning.');
  return posts.sort((a, b) => a.sourceIndex - b.sourceIndex);
}

export function orderedPosts(posts, orderMode) {
  if (!MODES.has(orderMode)) fail('Ordre de publication invalide.');
  if (!Array.isArray(posts) || !posts.length || posts.length > MAX_IMAGES) fail('Utilisez de 1 à 60 publications.');
  const seen = new Set();
  for (const post of posts) {
    if (!record(post) || !Number.isInteger(post.sourceIndex) || post.sourceIndex < 1 || post.sourceIndex > posts.length || seen.has(post.sourceIndex)) {
      fail('Numéros de page Canva invalides ou dupliqués.');
    }
    const publication = orderMode === 'GRID' ? posts.length - post.sourceIndex + 1 : post.sourceIndex;
    if (post.publication !== publication) fail('Numéro de publication incompatible avec la page Canva.');
    seen.add(post.sourceIndex);
  }
  const result = posts.slice().sort((a, b) => a.sourceIndex - b.sourceIndex);
  return orderMode === 'GRID' ? result.reverse() : result;
}

export function exportDigest(workflow, posts) {
  const value = normalizedWorkflow(workflow);
  const ordered = orderedPosts(posts, value.orderMode);
  if (ordered.length !== value.images.length) fail('Le nombre de publications ne correspond pas aux métadonnées.');
  const images = new Map(value.images.map(image => [image.sourceIndex, image]));
  const content = ordered.map(post => {
    const image = images.get(post.sourceIndex);
    if (!image || IMAGE_KEYS.some(key => post[key] !== image[key])) fail('Une publication ne correspond pas aux métadonnées de sa photo.');
    return { ...image, ...checkedText(post.caption, post.hashtags, post.sourceIndex + 1) };
  });
  return createHash('sha256').update(JSON.stringify({ title: value.title, orderMode: value.orderMode, posts: content })).digest('hex');
}
