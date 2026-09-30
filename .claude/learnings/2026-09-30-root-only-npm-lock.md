---
date: 2026-09-30
problem: Remove production dependency advisories from the pinned LongMemory build without changing its upstream source commit or installing unrelated workspaces.
tags: [npm, lockfile, supply-chain]
---

# Lock only the root graph needed by a frozen source build

## Problem

The pinned LongMemory checkout needs its root TypeScript build and SQLite runtime,
while the source repository's workspace lock also describes other packages. Its frozen
root advisory evidence listed 35 vulnerable paths. The fix had to preserve the reviewed
source commit and compatible direct dependency versions, resolve every production
advisory, and provide an immutable graph that setup can install reproducibly.

## Dead ends

- Bootstrapping the source repository's pnpm version and installing the full frozen
  workspace would add another package-manager bootstrap and resolve packages that the
  root build does not use. This is unnecessary when only the root package is built.
- Regenerating a manifest from current semver ranges could choose newer direct package
  versions than the pinned source's root importer. That would make the lock drift from
  the reviewed source even if an audit passed.
- Following upstream `main` would change the source under review and could not establish
  that the original 35 advisory paths were closed by the dependency fix itself.

## Working approach

1. Freeze the LongMemory source at commit
   `9ee2c8e1ed42d83eb788afb9ffc3a82b84405da5`.
2. Read the committed workspace lock's root importer and preserve its resolved direct
   dependency versions in a private root-only npm manifest, together with the root build
   script needed by setup.
3. Apply exact, scoped transitive overrides for the affected advisory paths and generate
   a committed npm lockfile for this root graph in an isolated review directory, with
   lifecycle scripts disabled during lock generation.
4. Verify the resolved production graph with `npm audit --omit=dev` and compare it with
   the original advisory paths. Runtime installation uses `npm ci` against the reviewed
   manifest and lockfile.
5. Make build reuse depend on a receipt for the source commit, root manifest/lock, source
   and generated output, the LongMemory stdio bootstrap, and npm's hidden
   `node_modules/.package-lock.json`. Recheck it after the smoke test and on reuse. This
   catches source/output/lock-resolution drift; it does not hash every byte under
   `node_modules` as a continuing authenticity guarantee.

## Why it worked

The root package contains the code setup builds, so a root-only graph retains its actual
runtime/build dependencies while omitting unrelated workspace roots. Exact direct
versions maintain compatibility with the pinned source. Scoped transitive overrides
repair the audited dependency paths, and the committed npm lockfile fixes the complete
resolution that `npm ci` will consume. A separate build receipt ties reuse to the pinned
source, generated output and npm's installed-graph metadata, so a changed artifact is not
mistaken for the reviewed build. That receipt is a drift check; it does not independently
authenticate every file under `node_modules`. An audit of the locked production graph can
then answer the security question for the exact shipped build rather than for a later
source revision or the entire workspace.

## Reusable rule

When a frozen upstream checkout is used only for its root build, pin the source commit,
preserve its resolved root direct versions, and lock/audit a minimal root-only manifest;
tie reuse to source/output and npm graph receipts without claiming every `node_modules`
byte is authenticated. Do not bootstrap or install the full workspace unless the build
actually needs it.

## Pointers

- `dependencies/longmemory/package.json:1` — reviewed root-only manifest and exact
  transitive overrides.
- `dependencies/longmemory/package-lock.json:1` — immutable npm resolution used by
  `npm ci`.
- `scripts/dependency_install.mjs:1` — copies the committed graph and fingerprints the
  exact manifest/lock bytes for build identity.
