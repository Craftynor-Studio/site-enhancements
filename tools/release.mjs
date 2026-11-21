import { readFileSync, readdirSync, existsSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { FORMAT, sha256, validSite, validatePackage, validateMapping, verifyManifest, requireValid } from '../lib/source.mjs';

export function build(root) {
  const source = JSON.parse(readFileSync(join(root, 'source.json')));
  requireValid(Number.isSafeInteger(source.revision) && source.revision > 0 && typeof source.name === 'string' && source.name.length <= 60, 'Invalid source metadata');
  const packages = [], files = new Map(), sites = new Map();
  const read = path => {
    requireValid(lstatSync(join(root, path)).isFile() && !lstatSync(join(root, path)).isSymbolicLink(), 'Source file must be a regular file');
    return readFileSync(join(root, path));
  };
  for (const [folder, kind, descriptor] of [['enhancements', 'enhancement', 'enhancement.json'], ['ad-filters', 'adFilters', 'filter.json']]) {
    if (!existsSync(join(root, folder))) continue;
    requireValid(!lstatSync(join(root, folder)).isSymbolicLink(), 'Symlink package root');
    const entries = readdirSync(join(root, folder), { withFileTypes: true });
    requireValid(!entries.some(entry => entry.isSymbolicLink()), 'Symlink package directory');
    for (const directory of entries.filter(entry => entry.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) {
      const site = directory.name; requireValid(validSite(site), 'Invalid site directory');
      const prefix = `${folder}/${site}/`, path = prefix + descriptor;
      const metadata = JSON.parse(read(path));
      const declared = validatePackage(kind, site, metadata, name => read(prefix + name));
      const actual = readdirSync(join(root, prefix)).sort();
      requireValid(JSON.stringify(actual) === JSON.stringify([descriptor, ...declared].sort()), 'Undeclared site files');
      for (const name of [descriptor, ...declared]) files.set(prefix + name, read(prefix + name));
      packages.push({ site, kind, version: metadata.version, path });
      if (!sites.has(site)) sites.set(site, new Set()); sites.get(site).add(kind);
    }
  }
  const mappingBytes = existsSync(join(root, 'mapping.json')) ? read('mapping.json') : Buffer.from('{"format":"site-feature-mapping","version":1,"sites":{}}\n');
  validateMapping(JSON.parse(mappingBytes), sites); files.set('mapping.json', mappingBytes);
  const manifest = { format: FORMAT, schema: 1, name: source.name, revision: source.revision,
    packages: packages.sort((a,b) => a.path.localeCompare(b.path)),
    files: [...files].sort(([a],[b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })) };
  requireValid([...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) <= 8 * 1024 * 1024, 'Source exceeds 8 MiB');
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  requireValid(packages.length <= 128 && files.size <= 2048 && bytes.length <= 512 * 1024, 'Catalog exceeds limits');
  requireValid([...files.values()].every(value => value.length <= 512 * 1024), 'File exceeds limit');
  return { manifest, bytes, files };
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || 'check';
  const output = build(root);
  if (command === 'check') console.log(`Valid source: ${output.manifest.packages.length} packages, revision ${output.manifest.revision}`);
  else if (command === 'build') {
    requireValid(!!process.argv[3], 'Usage: node tools/release.mjs build <local-private-key.pem>');
    const key = createPrivateKey(readFileSync(resolve(process.argv[3])));
    const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
    const signature = sign('sha256', output.bytes, key).toString('base64');
    verifyManifest(output.bytes, signature, publicKey);
    writeFileSync(join(root, 'manifest.json'), output.bytes); writeFileSync(join(root, 'manifest.sig'), signature + '\n');
    writeFileSync(join(root, 'public-key.txt'), publicKey + '\n');
    if (!existsSync(join(root, 'mapping.json'))) writeFileSync(join(root, 'mapping.json'), output.files.get('mapping.json'));
    console.log(`Signed source revision ${output.manifest.revision}; ${output.manifest.packages.length} packages. Private key stays local.`);
  } else throw Error('Unknown release command');
}
