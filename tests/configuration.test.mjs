import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const fixtureValues = {
  CANVA_CLIENT_ID: 'OC-ActivationFixture',
  CANVA_CLIENT_SECRET: 'canva-private-fixture',
  GOOGLE_CLIENT_ID: 'activation-fixture.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'google-private-fixture'
};
const original = '# Keep local preferences\nPUBLIC_ORIGIN=https://keep.example\nOTHER="keep this value"\nCANVA_CLIENT_SECRET=old-fixture\n';

function fixture(t, values = fixtureValues) {
  const root = mkdtempSync(path.join(tmpdir(), 'feed-activation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(path.join(root, 'scripts/configure.mjs'), readFileSync(new URL('../scripts/configure.mjs', import.meta.url)));
  const envPath = path.join(root, '.env');
  writeFileSync(envPath, original);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('feed-studio-oauth-config:v1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(values)), cipher.final()]);
  const envelope = { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') };
  const bundlePath = path.join(root, 'config/activation.enc.json');
  const save = () => writeFileSync(bundlePath, JSON.stringify(envelope));
  save();
  const run = (code = key.toString('base64url'), extraEnv = {}) => {
    const env = { ...process.env };
    for (const name of Object.keys(fixtureValues)) delete env[name];
    return spawnSync(process.execPath, ['scripts/configure.mjs', '--activate', code], {
      cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 10_000
    });
  };
  return { root, envPath, envelope, save, run };
}

test('private activation imports without prompts, preserves local preferences and never prints credentials', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const values = parseEnv(readFileSync(f.envPath, 'utf8'));
  for (const [name, value] of Object.entries(fixtureValues)) {
    assert.equal(values[name], value);
    assert.ok(!(result.stdout + result.stderr).includes(value));
  }
  assert.equal(values.PUBLIC_ORIGIN, 'https://keep.example');
  assert.equal(values.OTHER, 'keep this value');
  assert.equal(statSync(f.envPath).mode & 0o777, 0o600);
});

test('an incorrect activation key leaves existing credentials untouched', t => {
  const f = fixture(t);
  const result = f.run(randomBytes(32).toString('base64url'));
  assert.equal(result.status, 1);
  assert.equal(readFileSync(f.envPath, 'utf8'), original);
  assert.match(result.stderr, /Code d’activation incorrect/);
});

test('authenticated encryption rejects modified ciphertext before changing the file', t => {
  const f = fixture(t);
  const bytes = Buffer.from(f.envelope.data, 'base64url');
  bytes[0] ^= 1;
  f.envelope.data = bytes.toString('base64url');
  f.save();
  assert.equal(f.run().status, 1);
  assert.equal(readFileSync(f.envPath, 'utf8'), original);
});

test('invalid authentication tags and malformed activation codes fail closed', t => {
  const f = fixture(t);
  f.envelope.tag = randomBytes(15).toString('base64url');
  f.save();
  assert.equal(f.run().status, 1);
  assert.equal(f.run('not-a-valid-code').status, 1);
  assert.equal(readFileSync(f.envPath, 'utf8'), original);
});

test('activation accepts only four OAuth values and refuses extra AI credentials', t => {
  const f = fixture(t, { ...fixtureValues, OPENAI_API_KEY: 'must-not-be-imported' });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(readFileSync(f.envPath, 'utf8'), original);
  assert.ok(!(result.stdout + result.stderr).includes('must-not-be-imported'));
});

test('multiline values cannot inject additional environment settings', t => {
  const f = fixture(t, { ...fixtureValues, CANVA_CLIENT_SECRET: 'fixture\nOTHER=injected' });
  assert.equal(f.run().status, 1);
  assert.equal(readFileSync(f.envPath, 'utf8'), original);
});

test('activation refuses a symlink without modifying its destination', t => {
  const f = fixture(t);
  const target = path.join(f.root, 'other-private-file');
  writeFileSync(target, original);
  rmSync(f.envPath);
  symlinkSync(target, f.envPath);
  assert.equal(f.run().status, 1);
  assert.equal(readFileSync(target, 'utf8'), original);
});

test('activation creates a missing private env file and wrong keys never create one', t => {
  const f = fixture(t);
  rmSync(f.envPath);
  assert.equal(f.run(randomBytes(32).toString('base64url')).status, 1);
  assert.equal(existsSync(f.envPath), false);
  assert.equal(f.run().status, 0);
  assert.equal(parseEnv(readFileSync(f.envPath, 'utf8')).CANVA_CLIENT_ID, fixtureValues.CANVA_CLIENT_ID);
  assert.equal(statSync(f.envPath).mode & 0o777, 0o600);
});

test('conflicting exported values stop startup and identify only the variable name', t => {
  const f = fixture(t);
  const result = f.run(undefined, { GOOGLE_CLIENT_SECRET: 'conflicting-private-value' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /unset GOOGLE_CLIENT_SECRET/);
  assert.ok(!result.stdout.includes('conflicting-private-value'));
  assert.equal(parseEnv(readFileSync(f.envPath, 'utf8')).GOOGLE_CLIENT_SECRET, fixtureValues.GOOGLE_CLIENT_SECRET);
});
