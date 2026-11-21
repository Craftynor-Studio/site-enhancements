import { createHash, createPublicKey, verify } from 'node:crypto';

export const FORMAT = 'site-enhancements';
export const KINDS = ['enhancement', 'adFilters'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const host = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const localFile = /^[a-z0-9][a-z0-9_-]{0,47}\.(js|txt)$/;
export function requireValid(condition, message) { if (!condition) throw Error(message); }
const integer = value => Number.isSafeInteger(value) && value > 0;
export function validSite(site) { return typeof site === 'string' && site.length <= 253 && host.test(site); }
export function validatePackage(kind, site, value, read) {
  requireValid(KINDS.includes(kind) && validSite(site), 'Invalid package kind/site');
  requireValid(value.format === (kind === 'enhancement' ? 'site-enhancement' : 'enhanced-ad-filters') && value.schema === 1, 'Unknown package format');
  requireValid(value.site === site && integer(value.version), 'Package identity/version mismatch');
  for (const [field, limit] of [['name', 60], ['description', 300]]) requireValid(typeof value[field] === 'string' && value[field].trim() && value[field].length <= limit, `Invalid ${field}`);
  requireValid(Array.isArray(value.hosts) && value.hosts.length > 0 && value.hosts.length <= 32 && new Set(value.hosts).size === value.hosts.length, 'Invalid hosts');
  for (const pattern of value.hosts) {
    const domain = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
    requireValid(validSite(domain) && (domain === site || domain.endsWith('.' + site)), 'Host escapes its site');
  }
  const files = new Set();
  function file(name, extension) {
    requireValid(typeof name === 'string' && localFile.test(name) && name.endsWith(extension), 'Unsafe package file');
    requireValid(!files.has(name), 'Duplicate package file'); files.add(name);
    const bytes = read(name);
    requireValid(bytes.length > 0 && bytes.length <= 512 * 1024, 'Empty or oversized package file');
    if (extension === '.js') {
      const code = bytes.toString('utf8');
      requireValid(!/\beval\s*\(|\bnew\s+Function\b|\bimport\s*\(|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|document\s*\.\s*cookie|\blocalStorage\b|\bsessionStorage\b/.test(code), 'Disallowed script API');
      requireValid(code.split('\n').every(line => line.length <= 200), 'Keep package scripts readable');
    }
  }
  requireValid(Array.isArray(value.scripts) && value.scripts.length <= 16, 'Invalid scripts');
  for (const script of value.scripts) {
    requireValid(['document_start', 'page_ready'].includes(script.run), 'Invalid script timing');
    if (kind === 'adFilters') requireValid(['top', 'all'].includes(script.frames), 'Invalid script frames');
    file(script.file, '.js');
  }
  if (kind === 'enhancement') {
    requireValid(value.scripts.length > 0, 'Enhancement requires a script');
    requireValid((value.capabilities || []).every(capability => ['media', 'pull-to-refresh', 'mini-player'].includes(capability)), 'Unknown capability');
    const options = value.options || [];
    requireValid(Array.isArray(options) && options.length <= 40, 'Invalid options');
    const ids = new Set();
    for (const option of options) {
      requireValid(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(option.id) && !ids.has(option.id), 'Invalid option ID'); ids.add(option.id);
      requireValid(['switch', 'text', 'texts', 'select'].includes(option.mode) && typeof option.title === 'string' && option.title.length <= 60, 'Invalid option');
      if (option.mode === 'select') requireValid(Array.isArray(option.choices) && option.choices.length >= 2 && option.choices.length <= 30 && new Set(option.choices.map(c => c.value)).size === option.choices.length, 'Invalid choices');
    }
  } else {
    requireValid(Array.isArray(value.filters) && Array.isArray(value.networkRules) && value.networkRules.length <= 64, 'Invalid filter rules');
    for (const name of value.filters) file(name, '.txt');
    for (const rule of value.networkRules) requireValid(/^\|\|[a-z0-9.-]+\/[a-zA-Z0-9_./-]+$/.test(rule), 'Network rule must be a host/path without modifiers');
    requireValid(files.size + value.networkRules.length > 0, 'Nonempty site entry requires filter content');
    for (const name of value.filters) for (const line of read(name).toString('utf8').split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('!')) continue;
      requireValid(line.startsWith(`${site}##+js(`) && /##\+js\((set-constant|json-prune)(?:,|\))/.test(line) && line.endsWith(')'), 'Scriptlet escapes its site or supported format');
    }
  }
  return [...files];
}
export function validateMapping(mapping, packages) {
  requireValid(mapping?.format === 'site-feature-mapping' && mapping.version === 1 && mapping.sites && !Array.isArray(mapping.sites), 'Invalid mapping');
  for (const [site, entry] of Object.entries(mapping.sites)) {
    requireValid(validSite(site) && packages.has(site), 'Mapping names an absent site');
    requireValid(Object.keys(entry).every(key => key === 'relationships') && Array.isArray(entry.relationships) && entry.relationships.length <= 4, 'Invalid relationship list');
    const seen = new Set();
    for (const rule of entry.relationships) {
      requireValid(Object.keys(rule).sort().join() === 'from,to,type', 'A relationship cannot name another source/site');
      requireValid(KINDS.includes(rule.from) && KINDS.includes(rule.to) && rule.from !== rule.to && ['requires', 'suppresses'].includes(rule.type), 'Invalid relationship');
      requireValid(packages.get(site).has(rule.from) && packages.get(site).has(rule.to), 'Relationship needs both local packages');
      const key = `${rule.from}:${rule.to}`;
      requireValid(!seen.has(key), 'Duplicate or contradictory relationship'); seen.add(key);
    }
    const requires = entry.relationships.filter(r => r.type === 'requires');
    const suppresses = entry.relationships.filter(r => r.type === 'suppresses');
    requireValid(!(suppresses.length && requires.length), 'Required parts cannot suppress each other');
    requireValid(suppresses.length <= 1, 'Mutual suppression has no deterministic priority');
  }
  return mapping;
}
export function resolveParts(available, requested, relationships = [], gates = {}) {
  const state = Object.fromEntries(KINDS.map(kind => [kind, !!available[kind] && !!requested[kind] && gates[kind] !== false]));
  const reasons = {};
  for (const kind of KINDS) if (available[kind] && requested[kind] && gates[kind] === false) reasons[kind] = 'Host policy is off';
  // Suppression is evaluated before dependency closure. Resolution only removes effective states: no oscillation.
  for (const rule of relationships.filter(rule => rule.type === 'suppresses')) if (state[rule.from] && state[rule.to]) {
    state[rule.to] = false; reasons[rule.to] = `Suppressed by ${rule.from}`;
  }
  for (let pass = 0; pass < KINDS.length; pass++) for (const rule of relationships.filter(rule => rule.type === 'requires')) {
    if (state[rule.from] && !state[rule.to]) { state[rule.from] = false; reasons[rule.from] = `Requires ${rule.to}`; }
  }
  return { requested: { ...requested }, effective: state, reasons };
}
export function changeParts(requested, kind, enabled, relationships = []) {
  requireValid(KINDS.includes(kind) && typeof enabled === 'boolean', 'Invalid choice');
  const next = { ...requested, [kind]: enabled };
  for (let pass = 0; pass < KINDS.length; pass++) for (const rule of relationships.filter(rule => rule.type === 'requires')) {
    if (enabled && next[rule.from]) next[rule.to] = true;
    if (!enabled && !next[rule.to]) next[rule.from] = false;
  }
  return next;
}
export function verifyManifest(bytes, signature, publicKey) {
  const key = createPublicKey({ key: Buffer.from(publicKey.trim(), 'base64'), format: 'der', type: 'spki' });
  requireValid(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails.namedCurve === 'prime256v1', 'Expected P-256 publisher key');
  requireValid(verify('sha256', bytes, key, Buffer.from(signature.trim(), 'base64')), 'Invalid publisher signature');
  const manifest = JSON.parse(bytes);
  requireValid(manifest.format === FORMAT && manifest.schema === 1 && integer(manifest.revision), 'Unknown source format');
  requireValid(Array.isArray(manifest.packages) && manifest.packages.length <= 128 && Array.isArray(manifest.files) && manifest.files.length <= 2048, 'Invalid catalog');
  const paths = new Set();
  for (const file of manifest.files) {
    requireValid(typeof file.path === 'string' && /^(mapping\.json|(enhancements|ad-filters)\/[a-z0-9.-]+\/[a-z0-9_-]+\.(json|js|txt))$/.test(file.path) && !file.path.includes('..'), 'Unsafe catalog path');
    requireValid(!paths.has(file.path) && /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= 512 * 1024, 'Invalid file record'); paths.add(file.path);
  }
  requireValid(paths.has('mapping.json'), 'Mapping is not signed');
  const entries = new Set();
  for (const item of manifest.packages) {
    const path = `${item.kind === 'enhancement' ? 'enhancements' : 'ad-filters'}/${item.site}/${item.kind === 'enhancement' ? 'enhancement' : 'filter'}.json`;
    requireValid(KINDS.includes(item.kind) && validSite(item.site) && integer(item.version) && paths.has(path) && item.path === path && !entries.has(path), 'Invalid package record'); entries.add(path);
  }
  return manifest;
}
