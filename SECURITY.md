# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's **Security → Report a
vulnerability** on this repository, not in a public issue. Include the affected file and
line, the platform and steps to reproduce.

## Migration status

The native-stdio security migration is implemented in this source tree, but it has **not
been applied to a production installation**. An older installed setup may still have
keyless QMD and LongMemory HTTP listeners until the user approves and completes
`node scripts/ensure.mjs --apply`. `--plan` and `--check` are read-only; they do not stop
legacy listeners. Do not describe an existing installation as remediated until apply
reports success and the connected agents use the migrated configuration.

`--plan` and `--check` use local state and local probes. They do not query the npm
registry, Git remotes or mutable upstream `main`, and they do not modify files or
services. A `--plan` can report local health endpoints for a legacy setup; this is not an
external network request. `--update` builds and switches to only the reviewed LongMemory
source and dependency graph. It does not follow `main`, refresh arbitrary packages or
replace the full `--apply` migration. Use it only after `--apply` completes initial setup
or agent-configuration repair. Before writing, it blocks when private storage or the
native launcher is unavailable, or the setup-owned legacy LongMemory service remains.
Once those preconditions hold, it changes only the reviewed LongMemory build and leaves
agent configurations and service registrations unchanged. Its `ready` result means that
LongMemory build was updated; it does not certify full setup readiness.

## Connections and trust boundaries

- QMD and LongMemory are native stdio MCP child processes, each started by an agent's
  managed client configuration when that agent connects. The configuration passes the
  pinned Node executable, the setup launcher, the server name and the private runtime
  record path. The launcher selects the reviewed executable, clears inherited QMD,
  LongMemory, OpenMemory, index and Ollama host overrides plus `NODE_OPTIONS` and
  `NODE_PATH`, and applies private storage permissions before spawning the server. Their
  memory requests travel over the agent-owned pipes; the managed design creates no
  shared QMD or LongMemory HTTP listener.
- The LongMemory launcher uses the upstream native `create_stdio_mcp` transport with the
  default tenant/user and `project_id: null`. This preserves the prior shared memory
  scope across projects instead of inheriting the CLI `mcp` command's working-directory
  project scope. MCP initialization and `tools/list` alone do not prove write/recall
  compatibility across directories.
- Ollama remains available at `127.0.0.1:11434` for embedding requests. This endpoint is
  local and is not the agent-to-memory transport. The LongMemory launcher waits for the
  selected model to appear in Ollama before starting the stdio process.
- Apply migrates only the recognized legacy agent HTTP entries and retires setup-owned
  QMD/LongMemory service registrations. It backs up each changed agent configuration
  and owned service file before writing or retiring it. Custom or foreign MCP definitions,
  foreign service registrations and unmanaged memory listeners that conflict with the
  migration are preserved and block the affected work; the setup does not overwrite,
  adopt or stop them.
- Memory storage is restricted to the current user's access where the platform's
  permission model supports it. Startup also sets a restrictive process umask and
  revalidates the protected paths. Existing database contents are retained; setup does
  not delete the LongMemory database.
- On Windows, setup builds one protected descriptor for the current user and applies it
  with a single `Set-Acl` call, then verifies the resulting ACL. It does not reset access
  with `icacls /reset` before granting access again.

## Reviewed software inputs

- QMD is pinned to `@tobilu/qmd` **2.8.3** in `dependencies/qmd/package.json` and its
  committed npm lockfile.
- LongMemory is pinned to source commit
  `9ee2c8e1ed42d83eb788afb9ffc3a82b84405da5`. Its reviewed root-only npm manifest and
  lockfile are under `dependencies/longmemory/`; they preserve the pinned source root's
  build and direct dependency versions and include the audited transitive fixes. The
  installer uses `npm ci` against these committed lockfiles. It does not bootstrap pnpm,
  resolve newer direct dependency ranges or build mutable upstream `main`.
- The reviewed root manifest and lockfile are copied into the pinned source checkout and
  consumed by `npm ci`. A build receipt then identifies the source commit, manifest and
  lock, tracked source, generated output, LongMemory stdio bootstrap and npm's hidden
  `.package-lock.json` graph metadata. The receipt must still match after the smoke test
  and when a build is reused. It checks source/output/lock-resolution drift; it is not a
  perpetual byte-level authenticity check for every file under `node_modules`.
- The frozen upstream baseline listed 35 vulnerable LongMemory root paths. The reviewed
  lock closes those paths, and auditing the committed production graphs with
  `npm audit --omit=dev` found no production advisories.

Retrieval remains CPU-only. The managed QMD environment uses Metal for `qmd embed` on
Apple Silicon and Vulkan elsewhere; this policy does not move Ollama or the memory MCP
processes onto a GPU transport.

## Apply behavior and rollback

Before changing an agent configuration or retiring a setup-owned legacy service,
`--apply` writes the exact prior file bytes to a hash-named backup in the private
`~/.config/local-memory-setup/backups/` directory. If a custom or foreign definition or
service blocks the plan, resolve it explicitly; do not remove the blocker by replacing
that configuration with a generated one.

LongMemory builds live separately from the database under
`~/.local/share/local-memory-setup/longmemory/builds/`. The candidate build and its stdio
smoke test must pass before the current pointer changes. The previously current build is
retained as the previous build for rollback; a later reviewed update may prune older
builds. The database at `~/.local/share/local-memory-setup/longmemory.db` is outside the
build tree and is not deleted by migration or rollback.

There is no automatic configuration rollback. To roll back a completed migration,
restore the relevant configuration or service file from its matching backup, select a
still-retained previous LongMemory build, then restart the affected agent so it recreates
its client process. Restoring a legacy HTTP service also restores its former exposure;
only do that deliberately and keep the database's private permissions. Preserve the
previous build and backups until rollback is no longer required. A source-only revert
does not reverse installed agent or service configuration.

The implementation work has not performed a production apply or a full end-to-end
validation on every supported operating system. Platform-specific logic and isolated
tests are not evidence that every operating-system migration path has been exercised.

## Elevated access

On Linux, setup may run `sudo -n` (never an interactive prompt) to run the pinned Ollama
installer, enable Ollama's service or enable systemd linger. When a password would be
needed, it stops and prints the exact command for the user. The Ollama installer is
downloaded from the release tag matching the pinned version and checked against a pinned
SHA-256 before execution.

## Data

The LongMemory database is stored at
`~/.local/share/local-memory-setup/longmemory.db`; QMD indexes only the folders selected
by the user. Setup downloads reviewed software and models to the machine. Never store
secrets or `.env` contents in indexed folders or memory.
