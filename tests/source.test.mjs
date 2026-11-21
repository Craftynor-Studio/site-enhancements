import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, cpSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../tools/release.mjs';
import { loadSource, httpsReader } from '../lib/loader.mjs';
import { resolveParts, changeParts, validateMapping, sha256 } from '../lib/source.mjs';

const example = fileURLToPath(new URL('../examples/source/', import.meta.url));
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const available = { enhancement: true, adFilters: true };
const rule = (from, type = 'requires') => ({ from, to: from === 'enhancement' ? 'adFilters' : 'enhancement', type });
function mapping(relationships) { return { format: 'site-feature-mapping', version: 1, sites: { 'example.com': { relationships } } }; }
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'site-source-'));
  cpSync(example, root, { recursive: true });
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
async function load(output, options = {}) {
  const signature = sign('sha256', output.bytes, keys.privateKey).toString('base64');
  return loadSource({ publicKey, read: async path => path === 'manifest.json' ? output.bytes : path === 'manifest.sig' ? signature : output.files.get(path), ...options });
}

test('combined source verifies and keeps site parts separate', async () => {
  const output = fixture(root => build(root));
  const snapshot = await load(output);
  assert.equal(snapshot.packages.length, 2);
  assert.equal(snapshot.files.size, 5);
  assert.deepEqual(snapshot.mapping.sites['example.com'].relationships, []);
});
for (const [remove, kind] of [['enhancements', 'adFilters'], ['ad-filters', 'enhancement']]) {
  test(`${kind} works as a standalone source without the other path`, async () => {
    const output = fixture(root => { rmSync(join(root, remove), { recursive: true }); return build(root); });
    assert.deepEqual((await load(output)).packages.map(p => p.kind), [kind]);
  });
}
test('valid empty revision removes all packages', async () => {
  const output = fixture(root => {
    for (const folder of ['enhancements', 'ad-filters']) rmSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, 'mapping.json'), JSON.stringify({ format: 'site-feature-mapping', version: 1, sites: {} }));
    return build(root);
  });
  assert.equal((await load(output)).packages.length, 0);
});
test('hash mutation fails; previous snapshot remains untouched', async () => {
  const output = fixture(root => build(root)); const snapshot = await load(output);
  output.files.set('enhancements/example.com/reading.js', Buffer.from('changed'));
  await assert.rejects(load(output), /Invalid file/);
  assert.equal(snapshot.files.get('enhancements/example.com/reading.js').toString().includes('lineHeight'), true);
});
test('wrong publisher and catalog mutation fail verification', async () => {
  const output = fixture(root => build(root));
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await assert.rejects(load(output, { publicKey: other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }), /signature/);
  const signature = sign('sha256', output.bytes, keys.privateKey).toString('base64');
  await assert.rejects(loadSource({ publicKey, read: async p => p === 'manifest.json' ? Buffer.concat([output.bytes, Buffer.from(' ')]) : signature }), /signature/);
});
test('rollback and changed revision bytes fail; identical revision is accepted', async () => {
  const output = fixture(root => build(root)); const previous = await load(output);
  await load(output, { previous });
  await assert.rejects(load(output, { previous: { ...previous, revision: 2 } }), /rollback/);
  await assert.rejects(load(output, { previous: { ...previous, digest: 'wrong' } }), /reused/);
});
test('mapping rejects cross-source/cross-site rules, absent parts and cycles', () => {
  const sites = new Map([['example.com', new Set(['enhancement', 'adFilters'])]]);
  for (const extra of [{ source: 'another' }, { site: 'other.example' }]) assert.throws(() => validateMapping(mapping([{ ...rule('enhancement'), ...extra }]), sites));
  assert.throws(() => validateMapping(mapping([rule('enhancement')]), new Map([['example.com', new Set(['enhancement'])]])));
  assert.throws(() => validateMapping(mapping([rule('enhancement', 'suppresses'), rule('adFilters', 'suppresses')]), sites));
  assert.throws(() => validateMapping(mapping([rule('enhancement'), rule('adFilters', 'suppresses')]), sites));
  validateMapping(mapping([rule('enhancement'), rule('adFilters')]), sites);
});
for (const relationships of [[], [rule('enhancement')], [rule('adFilters')], [rule('enhancement'), rule('adFilters')]]) {
  test(`requires fixed point and toggle closure: ${relationships.map(r => r.from).join(',') || 'none'}`, () => {
    for (const enhancement of [false, true]) for (const adFilters of [false, true]) {
      const requested = { enhancement, adFilters };
      for (const adsPolicy of [false, true]) {
        const resolved = resolveParts(available, requested, relationships, { adFilters: adsPolicy });
        assert.deepEqual(resolved.requested, requested);
        assert.deepEqual(resolveParts(available, resolved.effective, relationships, { adFilters: adsPolicy }).effective, resolved.effective);
        for (const r of relationships) if (resolved.effective[r.from]) assert.equal(resolved.effective[r.to], true);
      }
      for (const kind of ['enhancement', 'adFilters']) for (const on of [false, true]) {
        const next = changeParts(requested, kind, on, relationships);
        assert.equal(next[kind], on);
        for (const r of relationships) if (next[r.from]) assert.equal(next[r.to], true);
      }
    }
  });
}
test('suppression retains choices and restores the suppressed part', () => {
  const relationships = [rule('enhancement', 'suppresses')];
  assert.deepEqual(resolveParts(available, available, relationships).effective, { enhancement: true, adFilters: false });
  const next = changeParts(available, 'enhancement', false, relationships);
  assert.equal(next.adFilters, true);
  assert.equal(resolveParts(available, next, relationships).effective.adFilters, true);
});
test('packaging rejects undeclared files, escaped hosts, unreadable and dynamic scripts', () => {
  fixture(root => { writeFileSync(join(root, 'enhancements/example.com/unlisted.js'), 'a'); assert.throws(() => build(root), /Undeclared/); });
  fixture(root => {
    const path = join(root, 'enhancements/example.com/enhancement.json'); const data = JSON.parse(readFileSync(path));
    data.hosts = ['unrelated.example']; writeFileSync(path, JSON.stringify(data)); assert.throws(() => build(root), /escapes/);
  });
  for (const code of ['eval("code")', 'fetch("https://example.com")', 'x'.repeat(201)]) fixture(root => {
    writeFileSync(join(root, 'enhancements/example.com/reading.js'), code); assert.throws(() => build(root));
  });
});
test('raw HTTPS reader rejects unsafe source URLs and paths', async () => {
  for (const base of ['http://example.com/', 'https://u:p@example.com/', 'https://example.com/?key=x']) assert.throws(() => httpsReader(base));
  const reader = httpsReader('https://example.com/', async () => { throw Error('should not fetch'); });
  for (const path of ['../secret', '/secret', 'https://other.example']) await assert.rejects(reader(path, 100), /Unsafe/);
});
