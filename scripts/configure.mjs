import { readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, createDecipheriv } from 'node:crypto';
import { parseEnv } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
const fields = [
  ['CANVA_CLIENT_ID', 'Canva — Client ID'],
  ['CANVA_CLIENT_SECRET', 'Canva — Client secret'],
  ['GOOGLE_CLIENT_ID', 'Google — Client ID'],
  ['GOOGLE_CLIENT_SECRET', 'Google — Client secret']
];

function activationValues(code) {
  const message = 'Code d’activation incorrect ou configuration endommagée. Aucun changement enregistré.';
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code || '')) throw new Error();
    const key = Buffer.from(code, 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== code) throw new Error();
    const source = readFileSync(new URL('../config/activation.enc.json', import.meta.url));
    if (source.length > 16 * 1024) throw new Error();
    const envelope = JSON.parse(source.toString('utf8'));
    if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') throw new Error();
    const decode = (value, size) => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.toString('base64url') !== value || (size && bytes.length !== size)) throw new Error();
      return bytes;
    };
    const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.iv, 12));
    decipher.setAAD(Buffer.from('feed-studio-oauth-config:v1'));
    decipher.setAuthTag(decode(envelope.tag, 16));
    const plaintext = Buffer.concat([decipher.update(decode(envelope.data)), decipher.final()]);
    const saved = JSON.parse(plaintext.toString('utf8'));
    if (!saved || Array.isArray(saved) || Object.keys(saved).length !== fields.length) throw new Error();
    for (const [name] of fields) {
      const value = saved[name];
      if (typeof value !== 'string' || !value.length || value.length > 1024 ||
          /[\s\u0000-\u001f\u007f#"'`\\=]/.test(value)) throw new Error();
    }
    if (!saved.GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com')) throw new Error();
    return saved;
  } catch {
    throw Object.assign(new Error(message), { publicMessage: message });
  }
}

async function configure() {
  const args = process.argv.slice(2);
  const activating = args.length === 2 && args[0] === '--activate';
  if (args.length && !activating) throw new Error('Arguments inconnus.');
  if (!activating && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Lancez npm run setup directement dans le terminal de votre Codespace.');
  }

  let original = '';
  try {
    if (!lstatSync(envPath).isFile()) throw new Error('Le chemin .env doit être un fichier ordinaire.');
    original = readFileSync(envPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const existing = parseEnv(original);
  const saved = activating ? activationValues(args[1]) : {};
  if (!activating) {
    // Readline retains its normal editing/paste behavior, but its output is muted
    // for every answer. Credentials never appear in the terminal or shell history.
    const quiet = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const input = createInterface({ input: process.stdin, output: quiet, terminal: true });
    const abort = new AbortController();
    input.once('close', () => abort.abort());
    const cancelled = () => { input.close(); };
    input.on('SIGINT', cancelled);
    let completed = false;
    try {
      process.stdout.write('\nConfiguration privée de Feed Studio\nCopiez les 4 valeurs depuis vos messages précédents. La saisie est masquée.\nEntrée conserve une valeur déjà enregistrée ; Ctrl+C annule sans rien modifier.\n\n');
      for (const [key, label] of fields) {
        const fallback = process.env[key] || existing[key] || '';
        while (true) {
          process.stdout.write(label + (fallback ? ' [déjà enregistré]' : '') + ' : ');
          const entered = await input.question('', { signal: abort.signal });
          process.stdout.write('\n');
          const value = entered.trim() || fallback;
          if (!value) { process.stdout.write('Collez la valeur correspondante, puis appuyez sur Entrée.\n'); continue; }
          if (/[\s\u0000-\u001f\u007f#"'`\\]/.test(value) || value.includes('=')) {
            process.stdout.write('Collez uniquement la valeur, sans nom de variable, guillemets ou espace.\n');
            continue;
          }
          if (key === 'GOOGLE_CLIENT_ID' && !value.endsWith('.apps.googleusercontent.com')) {
            process.stdout.write('Le Client ID Google se termine par .apps.googleusercontent.com.\n');
            continue;
          }
          saved[key] = value;
          break;
        }
      }
      completed = true;
    } finally {
      input.close();
      if (!completed) process.stdout.write('\nConfiguration annulée. Aucun fichier modifié.\n');
    }
  }

  // Preserve unrelated local settings and comments; replace only these four keys.
  const keys = new Set(fields.map(([key]) => key));
  const lines = original.split(/\r?\n/).filter(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || !keys.has(match[1]);
  });
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (lines.length) lines.push('');
  for (const [key] of fields) lines.push(key + '=' + saved[key]);
  const content = lines.join('\n') + '\n';
  const verified = parseEnv(content);
  for (const [key] of fields) {
    if (verified[key] !== saved[key]) throw new Error('Le fichier .env existant doit être corrigé avant de poursuivre. Aucun changement enregistré.');
  }
  for (const [key, value] of Object.entries(existing)) {
    if (!keys.has(key) && verified[key] !== value) throw new Error('Les réglages existants ne peuvent pas être conservés. Aucun changement enregistré.');
  }
  const temporary = envPath + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, envPath);
    chmodSync(envPath, 0o600);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const overrides = fields.map(([key]) => key).filter(key => process.env[key] !== undefined && process.env[key] !== saved[key]);
  process.stdout.write('\nConfiguration enregistrée dans .env. Ce fichier reste privé et ignoré par Git.\n');
  if (overrides.length) {
    process.stdout.write('\nCes anciennes variables du terminal ont priorité sur .env. Exécutez avant de démarrer :\nunset ' + overrides.join(' ') + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Vous pouvez lancer npm start.\n');
}

configure().catch(error => {
  if (error.code !== 'ABORT_ERR' && error.code !== 'ERR_USE_AFTER_CLOSE') {
    // Do not echo unexpected filesystem/input errors which might include values.
    process.stderr.write((error.publicMessage || 'Configuration interrompue. Vérifiez le terminal et les droits du fichier .env, puis relancez npm run setup.') + '\n');
  }
  process.exitCode = 1;
});
