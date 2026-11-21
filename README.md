# Site Enhancements

An open format and reference toolkit for independent site enhancements and Enhanced Ad Filters. Any browser, extension, or other host can implement the format. Publishers can distribute either kind alone or both together.

This repository is a reusable starting point. Its published catalog intentionally contains no active site packages. Runnable examples live under `examples/source/` and are excluded from that catalog.

## Layout

```text
source.json                         publisher name and increasing revision
enhancements/<site>/enhancement.json
enhancements/<site>/*.js
ad-filters/<site>/filter.json
ad-filters/<site>/*.js or *.txt
mapping.json                        optional relationships between local parts
manifest.json                       generated catalog and file hashes
manifest.sig                        detached signature
public-key.txt                      public verification key
```

The two package paths are independent. A filters-only repository can omit `enhancements/`; an enhancements-only repository can omit `ad-filters/`. No relationship is implied by sharing a site name.

## Create a source

Requires Node.js 20 or newer; no dependencies to install.

1. Copy this repository or use it as a template. Keep the MIT license notice.
2. Copy the relevant example site folder into `enhancements/` or `ad-filters/`, then replace `example.com`, hosts, metadata, and code with your site.
3. Leave `mapping.json` empty for independent parts, or declare the relationships described below.
4. Increase `source.json`'s `revision` for every release, including removals. Increase each changed package's `version`.
5. Run `npm test` and `npm run check`.
6. Create your own P-256 signing key outside the repository, for example `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out /private/source.pem`.
7. Run `npm run build -- /private/source.pem`. Only public artifacts are written into the repository.
8. Run `npm run verify`, then commit the packages, mapping, generated catalog, signature, and public key together. Publish them through raw HTTPS. Give consumers the source folder URL and public key through a trusted channel.

Never publish a private key. A copied source needs its publisher's own key. Consumers pin the expected key; downloading `public-key.txt` from an untrusted source is not sufficient authentication. Updating or removing a source must not silently replace its pinned key.

## Relationships and choices

Hosts present **Site Enhancements** with **Enhancements** and **Ad Filters** tabs. Each source has separate controls for the two kinds; each site has its own controls. Site protection and the Ad Filters tab share the same per-site choice.

For a site, `mapping.json` can declare no relationship, one direction, or both directions:

```json
{
  "format": "site-feature-mapping",
  "version": 1,
  "sites": {
    "example.com": {
      "relationships": [
        { "from": "enhancement", "to": "adFilters", "type": "requires" }
      ]
    }
  }
}
```

`requires` means the `from` part needs the `to` part. Enabling the dependent enables its dependency; disabling the dependency disables the dependent. Add the reverse rule for a mutual dependency. Turning off a dependent alone leaves its dependency on.

`suppresses` means an effective `from` part temporarily prevents `to` from running. Saved choices remain unchanged and return when suppression ends. Contradictory relationships and mutual suppression are rejected.

Every relationship is local to **one source and one canonical site**. An enhancement in source A cannot change filters from source B, even for the same domain. Cross-site and cross-source references are invalid. The mapping contains no source override fields.

Protection policy gates ad filters. An enhancement requiring filters cannot run while those filters are blocked by policy. Independent enhancements continue according to their own choice. Page presentation modes remain independent. Small helpers belong to their parent package rather than receiving extra switches.

## Implement a host

Read [the specification](SPECIFICATION.md). `lib/loader.mjs` is an executable reference loader; `lib/source.mjs` validates packages and resolves choices. Supply your own page injection, filter engine, controls, persistence, and atomic storage.

```js
import { loadSource, httpsReader } from './lib/loader.mjs';
const snapshot = await loadSource({
  read: httpsReader('https://raw.githubusercontent.com/OWNER/REPOSITORY/main/'),
  publicKey: pinnedPublisherKey,
  previous: savedRevisionAndDigest
});
// Atomically commit snapshot only after every file and relationship passes validation.
```

An unsigned or damaged update leaves the last verified snapshot usable. A valid empty revision removes old packages. Preserve user choices separately from cached packages. Do not execute source scripts until the publisher is trusted and all content has been verified.

## License

MIT. Preserve licenses and attribution for any third-party code you add. The source format and toolkit do not depend on a particular application or service.
