# local-memory-setup

An agent skill that gives your AI coding agents a memory, running entirely on your machine.

It installs and connects three local tools:

- **[QMD](https://github.com/tobi/qmd)** searches your notes and docs.
- **[LongMemory](https://github.com/CaviraOSS/LongMemory)** lets agents remember decisions and preferences between sessions.
- **[Ollama](https://ollama.com)** runs the embedding model LongMemory uses.

It works with **Claude Code, Codex, Grok and OpenCode** on **Linux, macOS and Windows**.

## Install

1. Install [Node.js](https://nodejs.org) 22.15+ and git.
2. Copy this folder into your agent's skills folder:

   | Agent | Folder |
   |---|---|
   | Claude Code | `~/.claude/skills/local-memory-setup` |
   | Codex | `~/.agents/skills/local-memory-setup` |
   | Grok | `~/.grok/skills/local-memory-setup` |

3. Start a new session. The agent explains what it will install and asks two things:
   - **Which model size?** *Small*, *Medium* or *Large*. One size sets both the note-search
     and the agent-memory model; the agent recommends the one that fits your computer and
     says why.
   - **Install now?** *Yes*, *Customize* (choose agents, folders, and start at boot or login),
     or *Not now*.

That's it. Nothing is installed until you say yes.

## What you get

- The three servers start automatically after a reboot or crash.
- Your agents are connected to them, with short instructions on when to recall and what to save.
- A `~/notes` folder that QMD indexes, if you don't have an index yet.
- Models sized to your hardware, all free and local.

Later sessions run a quick, silent health check and only speak up if something needs fixing.

## Commands

The agent runs these for you, but you can run them yourself from this folder:

| Command | What it does |
|---|---|
| `node scripts/ensure.mjs --plan` | Show what would be installed. Changes nothing. |
| `node scripts/ensure.mjs --apply --yes` | Install with recommended settings, or repair a broken setup. |
| `node scripts/ensure.mjs --check` | Health check. Silent when everything is fine. |
| `node scripts/ensure.mjs --update` | Update LongMemory to the latest version. |

## Good to know

- **Local only.** Nothing leaves your machine. The servers listen on `localhost` only.
- **Existing installs are respected.** If you already have QMD, Ollama or agent settings, the setup uses them and doesn't overwrite them.
- **First search is slow.** QMD downloads its search models the first time it needs them.
- **Admin password.** On Linux, installing Ollama and starting at boot need it once. The setup never waits for a password prompt; it prints the exact command to run instead.
- **LongMemory updates safely.** A new version is tested before it replaces the running one. Your memories are kept.

See [SECURITY.md](SECURITY.md) for known risks and how to report a problem.

## Where things are

| What | Where |
|---|---|
| Memories | `~/.local/share/local-memory-setup/longmemory.db` |
| Settings | `~/.config/local-memory-setup/` |
| QMD server | `http://localhost:8181/mcp` |
| LongMemory server | `http://127.0.0.1:7331/mcp` |

## Development

Run the tests with `node --test`. [SKILL.md](SKILL.md) is what the agent reads, and the code in `scripts/` documents the edge cases.

## License

[MIT](LICENSE)
