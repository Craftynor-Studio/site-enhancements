import { sha256, verifyManifest, validatePackage, validateMapping, requireValid } from './source.mjs';

/** Verify a complete revision before returning it. The caller commits the returned snapshot atomically. */
export async function loadSource({ read, publicKey, previous }) {
  const bytes = Buffer.from(await read('manifest.json', 512 * 1024));
  requireValid(bytes.length <= 512 * 1024, 'Catalog exceeds limit');
  const signature = String(await read('manifest.sig', 4096));
  const manifest = verifyManifest(bytes, signature, publicKey);
  const digest = sha256(bytes);
  if (previous) {
    requireValid(manifest.revision >= previous.revision, 'Source rollback');
    requireValid(manifest.revision !== previous.revision || digest === previous.digest, 'Revision was reused');
  }
  const files = new Map(); let total = 0;
  for (const file of manifest.files) {
    total += file.bytes; requireValid(total <= 8 * 1024 * 1024, 'Source exceeds limit');
    const content = Buffer.from(await read(file.path, file.bytes));
    requireValid(content.length === file.bytes && sha256(content) === file.sha256, `Invalid file: ${file.path}`);
    files.set(file.path, content);
  }
  const used = new Set(['mapping.json']), sites = new Map(), packages = [];
  for (const entry of manifest.packages) {
    used.add(entry.path);
    const metadata = JSON.parse(files.get(entry.path));
    requireValid(metadata.version === entry.version, 'Package version mismatch');
    const prefix = entry.path.slice(0, entry.path.lastIndexOf('/') + 1);
    validatePackage(entry.kind, entry.site, metadata, name => {
      const path = prefix + name;
      requireValid(files.has(path), 'Missing package file');
      used.add(path); return files.get(path);
    });
    if (!sites.has(entry.site)) sites.set(entry.site, new Set()); sites.get(entry.site).add(entry.kind);
    packages.push({ ...entry, metadata });
  }
  requireValid(used.size === files.size && [...files.keys()].every(path => used.has(path)), 'Undeclared source file');
  const mapping = validateMapping(JSON.parse(files.get('mapping.json')), sites);
  return { revision: manifest.revision, digest, manifest, signature, files, packages, mapping };
}

/** Raw HTTPS reader with bounded bodies; publisher keys must come from a separate trusted channel. */
export function httpsReader(base, fetcher = fetch) {
  const folder = new URL(base.endsWith('/') ? base : base + '/');
  requireValid(folder.protocol === 'https:' && !folder.username && !folder.password && !folder.search && !folder.hash, 'Expected HTTPS source folder');
  return async (path, limit) => {
    requireValid(!path.includes('..') && !path.startsWith('/') && !path.includes(':'), 'Unsafe relative path');
    const response = await fetcher(new URL(path, folder), { redirect: 'error', signal: AbortSignal.timeout(30000) });
    requireValid(response.ok, `HTTP ${response.status}: ${path}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length; requireValid(size <= limit, 'Response exceeds limit'); chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
}
