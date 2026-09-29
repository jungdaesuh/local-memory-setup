---
name: local-memory-setup
description: >
  Install and keep local QMD and CaviraOSS LongMemory running on the colleague's
  machine. Use on every session where this skill is loaded, before other work,
  and when the user says set up local memory, install qmd, install longmemory,
  or repair local memory. Runs scripts/ensure.mjs, which installs both servers
  natively, picks free local embedding models from the hardware, registers
  restart-on-boot user services, and wires Claude Code, Codex, Grok, and OpenCode.
---

# Local memory setup

Before any other action in a session where this skill is loaded, run:

```bash
node <directory-of-this-SKILL.md>/scripts/ensure.mjs
```

Use the absolute directory of this file. Do not install the npm package named `longmemory`. That package is the old server. The script builds CaviraOSS LongMemory from pinned commit `9ee2c8e1ed42d83eb788afb9ffc3a82b84405da5`.

Read the last stdout line. It is one JSON object.

- `status` `already`: both servers are healthy. Continue the user's task. Do not reinstall or announce the setup.
- `status` `ready`: tell the user, in a short summary, the QMD model, the LongMemory model and dimension, the two MCP URLs, and the `boot` sentence. The API key stays in the `env` file. Do not print the key.
- `status` `needs_admin`: show `detail` and `command`. Stop. Do not claim the setup finished.
- `status` `failed`: show `detail`. Stop.

The script is idempotent. A later session runs it again and takes the `already` path when both listeners are up. If a listener is down, the same command repairs and starts it.

Leave an existing OpenMemory server on port 8080 alone. QMD listens on `127.0.0.1:8181`. LongMemory listens on `127.0.0.1:7331`. QMD retrieval stays on CPU. `qmd embed` uses the GPU only when the hardware probe found one. LongMemory embeds through the local Ollama model named in the env file.
