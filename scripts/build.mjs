import { readFile, writeFile } from 'node:fs/promises';
const base = new URL('../', import.meta.url);
let html = await readFile(new URL('web/index.template.html', base), 'utf8');
for (const [token, file] of [['STYLE', 'web/styles.css'], ['APP', 'web/app.js']]) {
  const content = await readFile(new URL(file, base), 'utf8');
  if (token === 'APP' && /<\/script/i.test(content)) throw new Error('Unexpected script closing tag: ' + file);
  html = html.replace('{{' + token + '}}', () => content);
}
if (/\{\{[A-Z]+\}\}/.test(html)) throw new Error('Unresolved template token');
await writeFile(new URL('index.html', base), html);
console.log('Built self-contained index.html');
