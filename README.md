# local-memory-setup

An agent skill that gives your AI coding agents a private search over your notes and a
memory that lasts between sessions, all on your own computer.

It installs three tools:

- **[QMD](https://github.com/tobi/qmd)** searches your notes and documents.
- **[LongMemory](https://github.com/CaviraOSS/LongMemory)** lets agents remember decisions between sessions.
- **[Ollama](https://ollama.com)** runs the model LongMemory uses to understand memories.

It works with **Claude Code, Codex, Grok and OpenCode** on **Linux, macOS and Windows**.

## Install

1. Install [Node.js](https://nodejs.org) 22.15 or newer, and git.
2. Copy this folder into your agent's skills folder:

   | Agent | Folder |
   |---|---|
   | Claude Code | `~/.claude/skills/local-memory-setup` |
   | Codex | `~/.agents/skills/local-memory-setup` |
   | Grok | `~/.grok/skills/local-memory-setup` |

3. Start a new session. The agent explains what it will install and asks which model size
   to use (it recommends one for your computer) and **Install now?**: **Yes**, **Customize**
   (pick the agents, the folders to search and, on Linux, whether Ollama starts at boot or
   at login) or **Not now**. Nothing is installed until you say yes.

## What you get

- Your agents can search the folders you choose (`~/notes` by default).
- Your agents recall earlier decisions and store new ones, across sessions and projects.
- Each agent gets short instructions on when to recall and what to remember.
- A silent health check each session; the agent speaks up only when something needs repair.

## Commands

The agent runs these for you. You can also run them from this folder:

- `node scripts/ensure.mjs --plan` shows what would be installed or changed, and changes nothing.
- `node scripts/ensure.mjs --apply --yes` installs or repairs the setup with your saved choices.
- `node scripts/ensure.mjs --check` checks that everything works, and prints nothing when it does.
- `node scripts/ensure.mjs --update` updates LongMemory to its latest version.

## Good to know

- Everything stays on your computer. Each agent talks to search and memory over its own
  private connection (stdio); only Ollama listens, and only on this computer (127.0.0.1).
- The first search or indexing run can be slow while its model downloads.
- On Linux, installing Ollama or starting it at boot can need an admin command. The setup
  never waits at a password prompt; it prints the exact command for you to run.
- LongMemory updates follow its latest version on GitHub. Each new version is built and
  tested next to the current one, including a security check of its dependencies, and is
  used only if it passes. Your memories are kept and the previous version stays available.
- Agent settings are backed up before any change; setups the tool did not create are left alone.

## Where things are

| What | Where |
|---|---|
| Memories | `~/.local/share/local-memory-setup/longmemory.db` |
| Settings | `~/.config/local-memory-setup/` |
| Backups of changed settings | `~/.config/local-memory-setup/backups/` |

Security details, known risks and rollback: [SECURITY.md](SECURITY.md).

## Development

Run the tests with `node --test`; [SKILL.md](SKILL.md) is what the agent reads.

## License

[MIT](LICENSE)
