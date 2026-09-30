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

Run `SCRIPT --check`. It changes nothing and never calls sudo.

- Exit 0 and no output: everything is healthy. Say nothing about this skill.
- Exit 3 with `"installed": false`: local memory has never been set up here. Start the
  first-time flow below, unless the user already said "Not now" in this session.
- Exit 3 with `"installed": true`: something broke. Tell the user in one or two plain
  sentences what `problems` says, and offer a repair. With their consent, run
  `SCRIPT --apply --yes`. With a setup already saved, `--yes` repairs it with the saved
  choices (agents that are no longer installed are left out).
- Any other exit: show `detail` and stop.

## First-time flow: plan, explain, ask once

1. Run `SCRIPT --plan`. It changes nothing and prints the plan.
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
   - what starts again after a restart: on Linux with `bootMode` "boot", when the computer
     starts; otherwise when they log in. Ollama's own timing is in `detected.ollama.owner`
     (`system-unit` starts at boot);
   - that everything stays on this computer: the servers listen only on this machine, and
     the only network use is downloading the programs and models once;
   - that each connected agent gets short global instructions telling it when to recall
     and what to store (the `instructions-<agent>` actions).
3. Ask ONE question with the agent's question tool (Claude Code: AskUserQuestion; Grok:
   ask_user_question; Codex and OpenCode: ask in chat):
   "Install with recommended settings?" with the options **Yes**, **Customize**, **Not now**.
   - **Yes**: run `SCRIPT --apply --yes` (`--yes` means the saved choices when a setup exists,
     otherwise the plan's `recommended` choices).
   - **Customize**: ask at most these four questions, with the recommended answer first:
     1. Which agents to connect (multi-select from `options.agents`; preselect `recommended.agents`).
     2. Model size, described by disk and speed only, never by model name: for each entry of
        `options.modelTier`, its `approxDownloadBytes` in GB and its `description`.
     3. Linux only (`options.bootMode` not empty): start when the computer starts, or when
        they log in. Starting at boot needs the admin password once unless the plan shows
        `enable-boot-start` without `needsAdmin`.
     4. Folders for QMD to search. Default: `recommended.qmdFolders`: `~/notes` when it exists,
        or when QMD has no folders yet (apply then creates `~/notes` with a short README);
        otherwise none, and QMD's existing folders stay as they are.
     Then write the answers as a choices file (format below) and run
     `SCRIPT --apply --choices <that file>`.
   - **Not now**: do nothing, and do not ask again in this session.

Never run `--apply` unless the user agreed in this chat.

## Reading the apply result

- `"status": "ready"`: tell the user it is done in two or three sentences: the model size
  they got, that their agents are connected, and when things start again (`startsAgain`).
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
time it needs it. The plan's `totals.blockers` lists conflicts before you ask the
user anything; mention them in the explanation.

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

Do not install the npm package named `longmemory`: that is the old server. This skill builds
LongMemory from pinned commit `9ee2c8e1ed42d83eb788afb9ffc3a82b84405da5`. Leave an existing
OpenMemory server on port 8080 alone. The script itself leaves alone any QMD, LongMemory,
or Ollama that is already running and was started by something else, and never replaces
or downgrades an installed QMD.
