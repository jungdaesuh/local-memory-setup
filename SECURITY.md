# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's
**Security → Report a vulnerability** on this repository, not in a public issue.
Include the affected file and line, the platform, and steps to reproduce.

## What this skill does with elevated access

- On Linux it may run `sudo -n` (never an interactive prompt) to run Ollama's
  installer, enable `ollama.service`, and enable systemd linger. When a password
  would be needed it stops and prints the exact command for you to run.
- Ollama's Linux `install.sh` is downloaded from the tagged GitHub release that
  matches the pinned Ollama version and is checked against a pinned SHA-256
  before it runs. A mismatch stops the install.

## Known risks

- **Local servers accept requests from local web pages (DNS rebinding).**
  QMD (`localhost:8181`) and LongMemory (`127.0.0.1:7331`) listen only on the
  loopback interface. LongMemory runs without an API key, and neither server
  validates the `Host` header. A malicious web page that rebinds its own domain
  to `127.0.0.1` could read or write memories and read indexed notes while the
  page is open. QMD's behavior is upstream; LongMemory's is a deliberate choice
  for a keyless local setup. If this matters on your machine, set
  `LONGMEMORY_API_KEY` for the LongMemory service and pass it as `X-API-Key`
  in your agents' MCP settings.
- **LongMemory tracks upstream `main`.** Each install or `--update` builds the
  latest commit of `CaviraOSS/LongMemory`. A new build must pass a smoke test
  before it replaces the running one, but a commit that passes can still change
  behavior. Review upstream changes if you need a fixed version.
- **npm dependencies are not locked.** QMD's own version is pinned, but npm
  resolves its dependencies at install time and runs their install scripts
  (needed for native modules).

## Data

Everything stays on the machine. Memories live in
`~/.local/share/local-memory-setup/longmemory.db` (the same path under your home
folder on Linux, macOS and Windows); QMD indexes only the folders you choose. Never store secrets or
`.env` contents in either.
