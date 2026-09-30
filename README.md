# Local memory setup

A shareable agent skill. After the user agrees, it installs QMD (search over your notes),
CaviraOSS LongMemory (agent memory, built from the current `main` of
https://github.com/CaviraOSS/LongMemory), and Ollama (runs
LongMemory's embedding model). It picks free local models for the hardware, registers the
servers to start again after a reboot, and connects Claude Code, Codex, Grok, and OpenCode.

## Modes

| Command | What it does |
|---|---|
| `node scripts/ensure.mjs` or `--check` | Health check, no changes and no network. Exit 0 with no output when healthy; otherwise exit 3 and `{healthy, installed, problems, repairActions}`. Reports whether the running LongMemory build is healthy. |
| `node scripts/ensure.mjs --plan` | Detects OS, hardware, disk, installed agents and components, and admin access, and resolves LongMemory `main`. Prints the plan: recommended choices, options with download sizes, ordered actions, totals, and `LongMemory main @ <short sha>` when that commit differs from the running build. No changes. |
| `node scripts/ensure.mjs --apply --choices FILE` | Validates FILE against the plan (see SKILL.md), then runs only the pending actions, including a LongMemory update when `main` moved. |
| `node scripts/ensure.mjs --apply --yes` | Same, with the saved choices when a setup exists (agents no longer installed are left out), otherwise the plan's recommended choices. This is also the repair command. For IT or scripted installs. |
| `node scripts/ensure.mjs --update` | Resolves LongMemory `main` and runs only the LongMemory actions (build, smoke-test, switch, restart). Does not save choices. Same consent as `--apply`. |

Exit codes: 0 done or healthy, 1 failed or blocked, 2 an admin step is needed (the JSON
lists the exact commands), 3 unhealthy, 64 bad arguments. Apply is idempotent: finished
steps are skipped, so running it again repairs whatever is missing. Choices are saved
(`choices.json`) once everything works, including when only the start-at-boot admin step
is still waiting. `--check` never runs sudo. A saved folder that QMD already indexes does
not have to exist for a repair; only folders being added do. Downloads and installs have
time limits scaled to their size (ten minutes plus one second per MB, and twenty minutes
more for steps that also build); `mcp add` gets two minutes. A step that fails or runs out
of time stops apply with `Step <id> failed: <command and reason>`, and the same `--apply`
command retries it.

When QMD has no collection yet and `~/notes` does not exist, the plan offers `~/notes`:
apply creates it with a short README and indexes it. An index that already has
collections is never given one.

What already exists is kept:

- An installed QMD 2.5.3 or 2.8.3 is used as it is, and so is a newer one, whether or not
  it is running (the rule depends on the version only). It is looked for in `~/.local`,
  then behind the `qmd` on PATH, then in npm's global folder (`npm root -g`), where
  `npm install -g @tobilu/qmd` puts it; its services and `qmd` command run it from there.
  Any other version, or a `qmd` on PATH with no QMD package found for it, blocks the plan
  with an explanation; QMD is never replaced or downgraded. QMD 2.5.3 is installed only
  when there is none, and only a QMD this setup installed in `~/.local`
  (`~/.local/share/local-memory-setup/qmd-install.json`) is ever rebuilt.
- QMD's `~/.config/qmd/index.yml` `models` block decides QMD's models (QMD reads it before
  any environment variable and saves it on every command). The chosen size sets it only for
  a new index (no models block and no collections); an index without a models block keeps
  QMD's defaults, which built its vectors.
- A QMD, LongMemory, or Ollama already answering on its port that this setup did not
  start is left running and is not registered a second time.
- Once LongMemory holds memories (stored rows, counted read-only; an empty database does
  not count), a size with a different memory model is refused.
- QMD's search models are never downloaded, moved, or deleted by this setup: QMD fetches
  each one the first time it needs it, so the first search or indexing is slow. The plan
  states the approximate size (`notes`, `totals.firstUseDownloadBytes`). Folder indexing
  (`qmd embed -c`) has no time limit, and an interrupted run is continued by the next
  apply: a folder counts as indexed only when its documents all have vectors, and an index
  that cannot be read is never taken as complete. The size note counts only models not
  already in QMD's cache (checked read-only), and says so when it cannot tell. Every QMD
  command the setup runs, and its QMD service, uses QMD's global index (`--index index`),
  never a project's `.qmd/index.yml`.
- When the Node that runs the servers changes ABI (a major upgrade, a removed version),
  LongMemory's native modules, and QMD's when this setup installed QMD, are rebuilt for it
  (`npm rebuild`, `pnpm rebuild`, the Node's folder first on PATH) before the servers
  restart. A QMD the user installed is not rebuilt: an ABI mismatch blocks, naming both
  ABIs.
- A service this setup registered whose script is out of date (a new skill version, a
  moved Node) is rewritten and restarted. Scripts run the Node recorded at apply in
  `~/.config/local-memory-setup/runtime.json`; which Node runs `--check` does not matter.

## Memory instructions for each agent

Each connected agent also gets short global instructions: one `project_id` for every
LongMemory call (the git repository root's folder name, lowercased, other characters
turned into `-`, as LongMemory normalizes names itself), recall at session start
(`longmemory_project_context`, or `longmemory_recall` in `strict` mode), search order
(repository, then QMD `query`/`get`, then LongMemory), what to store
(`longmemory_remember_decision`, `longmemory_ingest`, notes QMD indexes), and never to
store secrets. One text, in `~/.config/local-memory-setup/agent-instructions.md`:

| Agent | Where it goes |
|---|---|
| Claude Code | `${CLAUDE_CONFIG_DIR:-~/.claude}/rules/local-memory-setup.md`, a file the setup owns |
| Grok | Nothing extra when Grok already reads the setup's Claude rules file, through its Claude compatibility (`GROK_CLAUDE_RULES_ENABLED`, else `compat.claude.rules`, on by default) or an `extra_rule_dirs` entry for `~/.claude/rules` (after `/import-claude`); otherwise the setup's folder is added to `[paths] extra_rule_dirs` in `$GROK_HOME/config.toml`. Never both. Settings in forms the setup cannot read or edit safely (inline tables, dotted or quoted `paths` keys) block with an edit-by-hand message. |
| OpenCode | The file's absolute path in `"instructions"` of the config in `${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/opencode}`: the last of `config.json` (global folder only; OpenCode does not read it from `OPENCODE_CONFIG_DIR`), `opencode.json`, `opencode.jsonc` that defines `instructions` (they merge in that order), else `opencode.json`. `AGENTS.md` is never created there: OpenCode would then stop reading `~/.claude/CLAUDE.md`. |
| Codex | A block between `<!-- local-memory-setup:begin -->` and `<!-- local-memory-setup:end -->` in `$CODEX_HOME/AGENTS.override.md` when it is non-empty, else `$CODEX_HOME/AGENTS.md`. Replaced in place; text outside the markers is not touched. |

Agent config files are read only for agents that are installed or chosen. A file that
cannot be parsed blocks that agent's steps with a message naming the file; other agents
go ahead.

`CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GROK_HOME` are honoured for MCP wiring and
instructions alike. OpenCode's MCP servers always go to its global folder
(`${XDG_CONFIG_HOME:-~/.config}/opencode`, where `opencode mcp add` writes);
`OPENCODE_CONFIG_DIR` only moves the instructions entry. A server already named `qmd` or
`longmemory` in any file OpenCode loads is left alone. Grok reads Claude Code's MCP servers
too (`compat.claude.mcps`); it merges them by name with its own `config.toml` first, so
each server appears once. `--check` reports a missing or outdated instructions file or
block, and `--apply --yes` repairs it.

## What starts again after a reboot

| | QMD and LongMemory | Ollama |
|---|---|---|
| Linux | systemd user units (`local-memory-*.service`, `Restart=always`). At boot when `bootMode` is `boot` (systemd linger); otherwise at login. Needs systemd as PID 1; WSL without systemd and containers are reported as blocked. | The system `ollama.service` from Ollama 0.34.4's tagged `scripts/install.sh` starts at boot. The file's SHA-256 is checked before it runs as root. Without that unit, a skill user unit runs `ollama serve` alongside QMD and LongMemory. With an AMD card install.sh also downloads ROCm (about 1.1 GB); with an NVIDIA card and no working driver it installs NVIDIA's driver packages. |
| macOS | LaunchAgents (`com.local-memory-setup.*`, `RunAtLoad`, `KeepAlive`). At login. | Installed with the Homebrew `ollama` formula (headless) and run by a skill LaunchAgent at login. If the Ollama app or `brew services` already runs Ollama, that stays the only owner. |
| Windows | Task Scheduler logon tasks (`LocalMemory*`), no time limit, run on battery, started through `powershell.exe -WindowStyle Hidden` so no console window stays open (it may show for an instant at logon). The runner restarts its server itself; Task Scheduler's restart-on-failure is not relied on to rerun an exited process. At logon. | winget installs the official Ollama app, whose login item starts it. A standalone `ollama.exe` gets a skill logon task instead. |

Only one program serves each port. LongMemory's runner waits until Ollama lists the memory
model before starting, because LongMemory falls back to a synthetic embedder when Ollama
does not answer. An Ollama outage while LongMemory runs still falls back (LongMemory logs
it); this is upstream behavior that cannot be switched off.

## Where things live

| Piece | Where |
|---|---|
| QMD MCP | `http://localhost:8181/mcp` (QMD listens on the name `localhost`) |
| LongMemory MCP | `http://127.0.0.1:7331/mcp`. Local only, no key: LongMemory listens on 127.0.0.1 only (`LONGMEMORY_HOST=127.0.0.1` in its settings), and its service unsets `LONGMEMORY_API_KEY`/`OM_API_KEY`, so it runs keyless. |
| QMD | `~/.local` (npm global prefix); an existing supported or newer one there, behind `qmd` on PATH, or in npm's global folder is used as is |
| LongMemory builds | `~/.local/share/local-memory-setup/longmemory/builds/<commit>`. `longmemory/current` is a symlink to the running build (on Windows, `longmemory/current.txt` is a pointer the runner reads). A new `main` is built in its own directory, smoke-tested (health, the MCP tools the instructions name, and the service's `serve` arguments), and switched only if that passes. The running build is left in place on failure. After a successful switch, older builds are removed; the current and previous builds are kept. |
| LongMemory database | `~/.local/share/local-memory-setup/longmemory.db`, outside the build directories, so a switch does not touch stored memories |
| LongMemory settings | `~/.config/local-memory-setup/longmemory.env` (host, port, database, embedding model; no key) |
| Saved choices | `~/.config/local-memory-setup/choices.json` |
| `qmd` command | `~/.local/libexec/local-memory-setup/qmd`, added to PATH unless another `qmd` is already first on PATH. It runs QMD on the Node that installed it. `qmd embed` uses the GPU when there is one (Metal on Apple silicon, Vulkan elsewhere); every other command runs on the CPU. |

## Install the skill

Copy or symlink this folder to the agent's skill path:

- Claude Code: `~/.claude/skills/local-memory-setup`
- Codex: `~/.agents/skills/local-memory-setup`
- Grok: `~/.grok/skills/local-memory-setup` (Grok also reads `~/.claude/skills`)
- OpenCode: a skills folder it loads, or tell it to run `node <this folder>/scripts/ensure.mjs --check` at session start

Requirements: Node.js 22.15 or newer to install or rebuild QMD or LongMemory (pnpm 11.5.2
needs 22.13; official builds before 22.15 cannot open the read-only SQLite URIs detection
uses). `--plan`, `--check`, and repairs that install nothing run on an older Node 22: the
plan notes it, and whether folders are fully indexed is judged by QMD collection
membership alone. Also npm and git; curl on Linux;
Homebrew on macOS; winget on Windows; zstd and tar on Linux (install.sh needs them). The Linux Ollama installer is downloaded from `https://raw.githubusercontent.com/ollama/ollama/v0.34.4/scripts/install.sh`, checked against the SHA-256 pinned next to `OLLAMA_VERSION`, and only then run. It needs the admin password
once (the printed command is the same download, `sha256sum -c`, and run), and so does start-at-boot unless polkit allows it. Apply never waits on a password
prompt: when the Ollama step needs one, it stops before changing anything; when only
start-at-boot needs one, it finishes the rest first. Either way it prints the exact command.

## Supply chain

QMD's npm version is pinned (`@tobilu/qmd@2.5.3`), but its dependencies are resolved by npm at install time and run install scripts.

Ollama's Linux installer is the `scripts/install.sh` file from the `v0.34.4` tag. Its SHA-256 is pinned in `scripts/layout.mjs` and checked before the file runs as root. LongMemory is the current `main` commit, built into its own directory and switched only after the smoke test above.

## Tests

`node --test` in this folder.
