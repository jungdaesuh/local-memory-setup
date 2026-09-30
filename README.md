# local-memory-setup

An agent skill that gives your AI coding agents local note search and durable memory.

It installs three tools:

- **[QMD](https://github.com/tobi/qmd)** searches your notes and documents.
- **[LongMemory](https://github.com/CaviraOSS/LongMemory)** lets agents remember decisions between sessions.
- **[Ollama](https://ollama.com)** runs the embedding model LongMemory uses.

The setup targets **Claude Code, Codex, Grok and OpenCode** on **Linux, macOS and Windows**.
The security migration has not yet been applied to an installed production setup; see
[SECURITY.md](SECURITY.md) before using an older installation.

## Install

1. Install [Node.js](https://nodejs.org) 22.15+ and git.
2. Copy this folder into your agent's skills folder:

   | Agent | Folder |
   |---|---|
   | Claude Code | `~/.claude/skills/local-memory-setup` |
   | Codex | `~/.agents/skills/local-memory-setup` |
   | Grok | `~/.grok/skills/local-memory-setup` |

3. Start a new session. The agent explains what it will install and asks which model
   size to use and whether to install now. You can customize the agents, folders and,
   on Linux, whether Ollama starts at boot or login. Nothing is installed until you agree.

## How it runs

When an agent connects to memory, its MCP client starts a private QMD or LongMemory
process over native standard input/output (stdio). Each connection owns its process;
QMD and LongMemory do not need shared HTTP memory listeners. The generated client entry
contains the pinned Node executable, the setup launcher, the server name and the private
runtime-settings path. The launcher resolves the reviewed executable and data paths,
filters inherited server overrides, and protects setup-owned storage before starting it.
LongMemory keeps the shared default tenant/user scope across agent working directories;
it does not narrow memory to the current directory. Its launcher waits until Ollama
reports the selected embedding model before starting LongMemory.

Ollama remains a local service at `127.0.0.1:11434`, used for embeddings. QMD retrieval
runs on CPU; `qmd embed` uses Metal on Apple Silicon and Vulkan elsewhere, as configured.
Your LongMemory database stays at `~/.local/share/local-memory-setup/longmemory.db`.

The setup uses QMD **2.8.3** and LongMemory source commit
`9ee2c8e1ed42d83eb788afb9ffc3a82b84405da5`. Their reviewed npm dependency graphs are
committed under `dependencies/`; installs use `npm ci` and the lockfiles. LongMemory's
build uses a root-only manifest for the pinned source checkout, without bootstrapping
pnpm or tracking mutable upstream `main`.

## Commands

The agent runs these for you, but you can run them from this folder:

| Command | What it does |
|---|---|
| `node scripts/ensure.mjs --plan` | Read-only plan from local state and local service probes; no package/main lookup or changes. |
| `node scripts/ensure.mjs --apply --yes` | Apply the reviewed plan or repair using the saved choices. Migrates only recognized legacy entries, backs up changed setup-owned files and retires setup-owned legacy memory services. |
| `node scripts/ensure.mjs --check` | Read-only local health and configuration check. Silent when everything is ready. |
| `node scripts/ensure.mjs --update` | Build and switch to the reviewed LongMemory source and dependency pins; it does not follow upstream `main` or apply every QMD/agent migration. |

Use `--update` only after `--apply` has completed initial setup or configuration repair.
Before writing, `--update` blocks if private storage or the native launcher is not ready,
or the setup-owned legacy LongMemory service remains. Once those prerequisites hold, it
changes only the reviewed LongMemory build; its success result does not certify the rest
of the setup.

Custom agent definitions, foreign service registrations or unmanaged memory listeners
that conflict with migration are preserved and block the affected work. Review the plan
and resolve the conflict explicitly; the setup does not overwrite or stop foreign state.
Apply keeps memory database contents. It stores exact backups of changed agent configs
and setup-owned service registrations under `~/.config/local-memory-setup/backups/`.

## Good to know

- QMD retrieval and LongMemory requests travel through each agent's local stdio pipes;
  Ollama is the only one of these tools that remains on a local network endpoint.
- Setup downloads reviewed program dependencies and required models to your machine.
  QMD indexes only the folders you choose.
- The first search or indexing run can be slow while its model is downloaded.
- On Linux, installing Ollama and starting it at boot can require an admin command.
  The setup never waits for an interactive password prompt; it prints the exact command.
- A LongMemory candidate is built and smoke-tested before becoming current. The prior
  build remains available as the previous build for rollback until a later update.

## Where things are

| What | Where |
|---|---|
| Memories | `~/.local/share/local-memory-setup/longmemory.db` |
| Setup settings and runtime record | `~/.config/local-memory-setup/` |
| Changed config/service backups | `~/.config/local-memory-setup/backups/` |
| Reviewed QMD package | `~/.local/share/local-memory-setup/qmd/node_modules/@tobilu/qmd/` |
| LongMemory builds | `~/.local/share/local-memory-setup/longmemory/builds/` |
| QMD index configuration and database | `~/.config/qmd/index.yml` and `~/.cache/qmd/index.sqlite` by default |

See [SECURITY.md](SECURITY.md) for known risks, migration behavior and rollback notes.

## Development

Run the tests with `node --test`. [SKILL.md](SKILL.md) is what the agent reads, and the
code in `scripts/` documents the edge cases.

## License

[MIT](LICENSE)
