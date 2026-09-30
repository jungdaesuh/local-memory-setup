---
date: 2026-09-30
problem: Native stdio migration must not report unreviewed runtimes or legacy HTTP registrations as secure and ready.
tags: [security, stdio, migration]
---

# Treat transport readiness and server health as separate facts

## Problem

The setup used to treat a healthy local HTTP endpoint and a matching server name in an agent config as evidence that memory connections were ready. That conflated reachability with transport identity, source provenance, whether an old HTTP service could still expose memory data, and whether the new transport preserved existing data scope.

## Dead ends

- Reusing the old health probe as readiness would leave unauthenticated HTTP servers eligible for a green check.
- Adopting a globally installed QMD based on a supported version would make its dependency graph and launch behavior unverifiable.
- Treating marked-but-inactive legacy registrations as absent would skip retirement and could leave them enabled for a future login or boot.
- Using LongMemory's CLI `mcp` entrypoint passed MCP initialization and tool listing but applied a working-directory project scope, which hid existing shared memories. A real write/recall check across different working directories exposed the compatibility break.

## Working approach

1. Count an agent connection only when its complete launch tuple matches the exact stdio command, launcher, server name, and runtime path.
2. Count QMD only when its private package and install stamp match the reviewed version and dependency fingerprint; replace only the setup-owned legacy install.
3. Count LongMemory only when its source pin and dependency fingerprint validate, and count the launcher runtime only when the recorded Node is usable and its copied files match.
4. Launch LongMemory through a static bootstrap of upstream `create_stdio_mcp` with default tenant/user and `project_id: null`; test an actual write and recall across different working directories, not only MCP initialization and `tools/list`. Explicitly close the server on stdin EOF: the upstream convenience runner waits for a close event that its stdio transport does not emit on EOF.
5. Keep HTTP health as a migration signal: an unmanaged listener blocks; a setup-owned old registration stays pending retirement even if inactive; an unmarked same-name registration blocks.
6. Report native stdio as ready only after those facts agree.

## Why it worked

Transport, data scope, provenance, launchability, and listener retirement are independent claims. A green result is trustworthy only when each claim is checked from the artifact that owns it. MCP protocol discovery cannot prove equivalent project visibility or persistence; a real write/recall test is needed.

## Reusable rule

When migrating a service from HTTP to stdio, preserve its tenant/user/project scope explicitly, prove write/recall across working directories, require an exact launch tuple and reviewed runtime, and retire or block every old listener and same-name registration.

## Pointers

- `scripts/detect.mjs`: agent stdio inspection, QMD reviewed stamp, LongMemory source pin, usable Node runtime, service ownership.
- `scripts/plan.mjs`: reviewed install gates, foreign listener blockers, legacy service retirement, accurate stdio summaries.
- `scripts/plan.test.mjs`: reviewed graph, foreign registration, and HTTP migration contract.
- `scripts/stdio_config.mjs`: exact launch tuple inspection and safe config migration.
- `scripts/longmemory_stdio.mjs`: explicit default tenant/user and shared `project_id: null` bootstrap.
