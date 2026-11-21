# Source format, version 1

## Identity and delivery

A source is an HTTPS folder pinned to a publisher's public key. Assign a stable local source ID to the normalized folder URL. Site keys are lowercase ASCII domain names; use punycode for international domains. Every choice and relationship is keyed by `(source ID, site, part)`. Parts are `enhancement` and `adFilters`.

Package host patterns are exact domains or `*.domain`; every domain must be the canonical site or a subdomain of it. A wildcard matches subdomains; list the domain separately to include it. Hosts run only on HTTPS. Package scripts do not escape their declared hosts; ad scripts additionally respect frame scope.

Fetch `manifest.json` and `manifest.sig` through raw HTTPS. No Pages build or external package registry is required. Reference readers reject redirects, credentials, query strings, and fragments in a source URL. Bound all reads and do not fetch undeclared paths.

## Signed catalog

The signature is base64 DER ECDSA SHA-256 over the exact UTF-8 bytes of `manifest.json`. The public key is base64 DER SubjectPublicKeyInfo for NIST P-256. Catalog fields:

| Field | Value |
| --- | --- |
| `format` | `site-enhancements` |
| `schema` | `1` |
| `name` | source display name, at most 60 characters |
| `revision` | positive increasing integer |
| `packages` | records with `kind`, `site`, positive `version`, and canonical descriptor `path` |
| `files` | records with safe relative `path`, exact `bytes`, lowercase SHA-256 `sha256` |

Limits: 512 KiB catalog, 128 packages, 2048 files, 512 KiB per file, 8 MiB total file bytes. `mapping.json` is always signed through a file record; the builder supplies an empty mapping when absent. Paths and package identities are unique. Every declared file must be used and every used file declared. Site folders contain only their descriptor and referenced files; no nested folders, remote scripts, path traversal, or symlinks.

Verify the signature before trusting paths. Verify sizes and hashes before parsing content. Validate all packages and mapping before one atomic replacement. Persist the highest verified revision and catalog digest. Reject lower revisions and a changed digest at the same revision. A successful empty catalog retires prior packages. Failures retain the last verified snapshot. Revision floors survive removal/re-addition; publisher key changes require an explicit trust decision.

## Package descriptors

Both descriptors contain `schema: 1`, `site`, positive `version`, `name` (1–60 characters), `description` (1–300), `hosts` (1–32 unique patterns), and `scripts` (up to 16). Script entries use a local `.js` filename and `run`: `document_start` or `page_ready`. Filters also declare `frames`: `top` or `all`. Filenames use lowercase letters, digits, underscores and hyphens, start with a letter or digit, and have at most 48 characters before the extension.

`enhancement.json` has `format: site-enhancement`, at least one script, optional `features` strings, `capabilities`, and `options`. Recognized capability names are `media`, `pull-to-refresh`, and `mini-player`. Hosts that cannot support a requested capability must disable the affected integration visibly. DOM-only enhancements need no capabilities. Scripts execute with an `enhancement` context exposing `options`, an `enabled` list, and optional `register` adapters. They need no application-specific globals. Adapter contracts are host extensions and must be documented by each host.

Options use unique `id`, `title`, optional `description`, `mode` (`switch`, `text`, `texts`, `select`) and a typed `default`. Select options supply `choices` with `value` and `title`. Hosts validate types and unknown options rather than treating helper internals as user switches. Publishers should expose only meaningful controls. Options never grant network or storage permissions.

`filter.json` has `format: enhanced-ad-filters`, `filters` (local `.txt` scriptlet files), `networkRules` and `scripts`. At least one rule/file/script is required. Network rules use `||host/path` without modifiers; hosts append `$domain=<site>` before native compilation. Scriptlet lines use `<site>##+js(set-constant, ...)` or `<site>##+js(json-prune, ...)`; blank lines and `!` comments are allowed. DOM removal can use local scripts. Engines must reject unsupported rules visibly rather than silently widening their scope. Ad scripts obey both frame and top-page ads policy.

Keep scripts readable. The reference validator rejects dynamic evaluation/imports, network APIs, cookies and page storage APIs. This is a publisher lint rule, not a security sandbox: trusted scripts can access the page DOM, and static checks cannot prove arbitrary JavaScript safe. Hosts must use suitable isolation and an explicit trust model.

## Mapping and effective state

`mapping.json` uses `format: site-feature-mapping`, `version: 1`, `sites: { "example.com": { "relationships": [...] } }`. Omitted site entries mean independent parts. Each rule has exactly `from`, `to`, and `type`; parts must differ and both exist locally. Type is `requires` or `suppresses`. No source ID, other site, remote path, or wildcard relationship is accepted. Duplicate direction pairs, mixed requires/suppresses, and two suppression directions are invalid. Mutual requires is valid.

Save requested choices separately. Begin effective state with available AND requested AND source-enabled AND host policy. Apply suppression first, then remove any required dependent whose dependency is unavailable. Two passes reach a fixed point for two parts. Never enable a saved choice during effective resolution. A user toggle applies dependency closure to requested choices in a single transaction: enabling follows outgoing `requires`; disabling follows incoming `requires`. Suppression changes only effective state.

Each UI entry shows requested state and an explanation if it cannot run. A host's global or site ads policy gates effective filters; it must not erase their requested choice. Both tabs and protection controls use the same persisted choice. Changes apply to existing pages through controlled reinjection or reload. Private/preview execution and overlapping content providers are host policy and must be evaluated separately.
