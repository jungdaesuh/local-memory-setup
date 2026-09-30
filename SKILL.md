---
name: local-memory-setup
description: >
  Sets up and keeps healthy a private, on-this-computer search and memory system for AI
  agents: QMD (searches your notes), CaviraOSS LongMemory (lets agents remember across
  sessions), and Ollama (runs the memory model). Use at session start to run a silent
  health check, and when the user asks to set up, install, repair, or check local memory,
  QMD, or LongMemory. Installs only after the user agrees in chat.
---

# Local memory setup

`SCRIPT` below means `node <absolute directory of this SKILL.md>/scripts/ensure.mjs`.
The script prints one JSON document on stdout; progress goes to stderr.

## At session start: silent check

Run `SCRIPT --check`. It changes nothing, never calls sudo or contacts external services,
and checks local runtime, storage, agent configuration and service state.

- Exit 0 and no output: everything is healthy. Say nothing about this skill.
- Exit 3 with `"installed": false`: local memory has never been set up here. Start the
  first-time flow below, unless the user already said "Not now" in this session.
- Exit 3 with `"installed": true`: something broke. Tell the user in one or two plain
  sentences what `problems` says, and offer a repair. With their consent, run
  `SCRIPT --apply --yes`. With a setup already saved, `--yes` repairs it with the saved
  choices (agents that are no longer installed are left out).
- Any other exit: show `detail` and stop.

The security migration is prepared in this source tree but has not yet been applied to
an installed setup. A read-only check does not stop legacy QMD or LongMemory HTTP
listeners. If one is still installed, tell the user it remains exposed until a reviewed
`--apply` completes; get their agreement before applying.

## First-time flow: plan, explain, ask once

1. Run `SCRIPT --plan`. It changes nothing and uses local probes only; it does not query
   Git, npm or a mutable upstream `main` branch.
2. Explain it in plain, non-technical words. Cover:
   - what gets installed: a search engine for their notes (QMD), a memory server that lets
     their AI agents remember things between sessions (LongMemory), and Ollama, which runs
     the memory model;
   - why it helps: agents can find what they wrote before and recall earlier decisions;
   - the download size: `totals.downloadBytes`, in GB, rounded, and `notes` (QMD downloads
     its search models the first time it needs them, so the first search or indexing is
     slow; say the size in `totals.firstUseDownloadBytes`, or that they are already
     downloaded when the note says so);
   - whether an admin password is needed: `totals.needsAdmin`, and for which step
     (the action with `needsAdmin: true`);
   - when things start: QMD and LongMemory start on demand when an agent connects over
     stdio. Ollama's timing is in `detected.ollama.owner` (`system-unit` starts at boot;
     otherwise the setup may start it when they log in);
   - how connections work: each agent starts QMD or LongMemory as its own native stdio
     MCP child process through the managed launcher. The agent entry names the pinned
     Node executable, launcher, server (`qmd` or `longmemory`) and private runtime file;
     the servers do not share memory HTTP listeners. LongMemory keeps the shared default
     tenant/user scope across working directories. Its launcher waits until Ollama reports
     the selected model at `127.0.0.1:11434` before starting it. Setup downloads reviewed
     programs and models;
   - which reviewed releases will be used: QMD 2.8.3 and LongMemory commit
     `9ee2c8e1ed42d83eb788afb9ffc3a82b84405da5`. The npm manifests and lockfiles are
     committed under `dependencies/`; installs use `npm ci`. LongMemory uses a reviewed
     root-only npm graph for its source build and does not bootstrap pnpm or follow
     mutable `main`;
   - that each connected agent gets short global instructions telling it when to recall
     and what to store (the `instructions-<agent>` actions).
3. Explain the model size. One size sets both the note-search model (QMD) and the
   agent-memory model (LongMemory), with one exception: when `detected.qmd.configModels`
   is not null, QMD already has an index with its own models, which it keeps; then say
   the size changes only the agent-memory model. In plain words, never by model name:
   - what the recommended size (`recommended.modelTier`) means, and why it fits this
     computer: say the memory in `hardware.ramBytes` (GB) and the graphics memory in
     `hardware.vramBytes`, or that it is an Apple Silicon Mac (`hardware.appleSilicon`);
   - for each entry of `options.modelTier`: its `description` (it covers both search and
     memory) and its `approxDownloadBytes` in GB.
   If `detected.lockedTiers` is not null, memories already exist: offer only those sizes
   and say why (a different memory model could not read the stored memories).
4. Ask with the agent's question tool (Claude Code: AskUserQuestion with both questions in
   one call; Grok: ask_user_question; Codex and OpenCode: ask in chat):
   - "Which model size?" with each allowed size as an option, the recommended one first
     and labelled "(Recommended)". Skip this question when only one size is allowed.
   - "Install now?" with the options **Yes**, **Customize**, **Not now**.
   Then:
   - **Yes** with the recommended size: run `SCRIPT --apply --yes` (`--yes` means the saved
     choices when a setup exists, otherwise the plan's `recommended` choices).
   - **Yes** with another size: write a choices file (format below) that is
     `recommended` with `modelTier` set to their size, and run
     `SCRIPT --apply --choices <that file>`.
   - **Customize**: keep their size, and ask at most these three questions, with the
     recommended answer first:
     1. Which agents to connect (multi-select from `options.agents`; preselect `recommended.agents`).
     2. Linux only (`options.bootMode` not empty): start when the computer starts, or when
        they log in. Starting at boot needs the admin password once unless the plan shows
        `enable-boot-start` without `needsAdmin`.
     3. Folders for QMD to search. Default: `recommended.qmdFolders`: `~/notes` when it exists,
        or when QMD has no folders yet (apply then creates `~/notes` with a short README);
        otherwise none, and QMD's existing folders stay as they are.
     Then write the answers as a choices file (format below) and run
     `SCRIPT --apply --choices <that file>`.
   - **Not now**: do nothing, and do not ask again in this session.

Never run `--apply` or `--update` unless the user agreed in this chat. `--apply` migrates
only recognized legacy HTTP client entries, backs up changed agent configuration and
setup-owned service files under `~/.config/local-memory-setup/backups/`, and retires
setup-owned legacy QMD/LongMemory HTTP services. Custom/foreign definitions and foreign
service registrations are preserved and block migration; show the blockers and do not
work around them. It never deletes the memory database.

Run `--update` only after a successful `--apply` has completed initial setup or repaired
agent configurations. Before writing, it blocks if private storage or the native
launcher is unavailable, or the setup-owned legacy LongMemory service remains. Once
ready, it builds and switches only the reviewed LongMemory source commit and npm lockfile;
it does not follow upstream `main`, update arbitrary packages or change agent
configurations or service registrations. A candidate is built and smoke-tested before
switching. The prior build is retained as the previous build for rollback until a later
update.

On successful `--update`, the result names the installed `commit`. Report that reviewed
LongMemory build only; do not say the full setup or agent-configuration migration was
applied unless a separate `--apply` reports success.

## Reading the apply result

- `"status": "ready"`: tell the user it is done in two or three sentences: the model size
  they got, that their agents are connected, and when things start again (`startsAgain`).
  QMD and LongMemory start on demand when an agent connects over stdio; only Ollama is a
  managed background service.
- `"status": "needs_admin"`: show `detail` and each line of `commands`. Ask the user to run
  them in a terminal, then run the same apply command again. When only start-at-boot needs
  it, `detail` says everything else is already set up and running; say so.
- `"status": "blocked"`: something already on this computer conflicts, and apply changed
  nothing. Show each line of `blockers` in plain words (for example: a QMD version this
  setup does not support, a QMD built for another Node.js). Do not work around it.
- `"status": "failed"`: show `detail` and stop.

Apply is safe to run again: steps already done are skipped. The choices are saved once
everything works, including when only the start-at-boot admin step is still waiting.
The setup never downloads QMD's search models itself; QMD fetches each one the first
time it needs it. Retrieval stays on CPU; `qmd embed` uses Metal on Apple Silicon or
Vulkan elsewhere according to the managed environment. The plan's `totals.blockers`
lists conflicts before you ask the user anything; mention them in the explanation.

## Choices file

```json
{
  "schemaVersion": 1,
  "modelTier": "medium",
  "agents": ["claude", "codex"],
  "bootMode": "login",
  "qmdFolders": ["/home/ana/notes"]
}
```

`modelTier` is one of `options.modelTier[].id`. `agents` are from `options.agents`.
`bootMode` is `"boot"` or `"login"` on Linux and `null` elsewhere. `qmdFolders` are
absolute paths to existing folders, except the recommended `~/notes`, which apply creates. All five keys are required and no others are allowed.
Once LongMemory holds memories (stored rows, not just an empty database), apply refuses
a model size that uses a different memory model (`detected.lockedTiers`). QMD keeps whatever search model its index already uses;
the model size sets QMD's model only for a new index.

## Leave alone

Do not install the npm package named `longmemory` from a registry. This skill builds the
reviewed LongMemory commit `9ee2c8e1ed42d83eb788afb9ffc3a82b84405da5` with its committed
root-only `package-lock.json`; it does not track upstream `main` or use pnpm. Each reviewed
build has a source-and-dependency identity and its own directory; the memory database
stays outside those directories. A candidate is switched only after its build and stdio
smoke test pass. The current and previous builds are retained for rollback. Leave an
existing OpenMemory server alone. Foreign QMD installations, configurations and services
are never silently replaced or stopped; the plan blocks when they conflict with migration.
