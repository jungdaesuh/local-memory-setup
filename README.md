# Local memory setup

Shareable agent skill. The first session that loads it installs QMD and CaviraOSS LongMemory, chooses free local embedding models, starts them on this machine, and registers user services that come back after reboot.

| Piece | Where |
|---|---|
| QMD MCP | `http://127.0.0.1:8181/mcp` |
| LongMemory MCP | `http://127.0.0.1:7331/mcp` |
| LongMemory source | `~/.local/share/local-memory-setup/LongMemory` at commit `9ee2c8e1` |
| API key and model | `~/.config/local-memory-setup/longmemory.env` |
| Notes indexed by QMD | `~/.local/share/local-memory-setup/notes` (only if QMD had no collections) |

QMD retrieval stays on CPU. `qmd embed` uses the GPU when the machine has one. The model ladder lives in `scripts/model_choice.mjs`.

Boot behavior:

- Linux: systemd user services with `Restart=always`, plus `loginctl enable-linger` when the user can run it.
- macOS: LaunchAgents with `KeepAlive`, started at login.
- Windows: a logon task that restarts on failure.

Load the skill by copying this folder to the agent skill path:

- Claude Code: `~/.claude/skills/local-memory-setup`
- Codex: `~/.agents/skills/local-memory-setup`
- Grok: `~/.grok/skills/local-memory-setup`
- OpenCode: the same folder if that client loads `SKILL.md`; otherwise tell it to run `node <this>/scripts/ensure.mjs` at session start

Node.js 22 or newer and git are required. The Linux Ollama installer and linger need administrator rights once. The script stops and prints that command instead of hanging on a password prompt.
