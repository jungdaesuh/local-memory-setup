/** Launch one native MCP process; stdout belongs exclusively to its protocol. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { memoryProcessSpec } from "./mcp_runtime.mjs";
import { parseEnvFile } from "./longmemory_env.mjs";
import { longMemoryGateReady } from "./health.mjs";
import { probeJson, waitFor } from "./proc.mjs";
import { OLLAMA_TAGS_URL } from "./layout.mjs";
import { secureMemoryStorage } from "./private_storage.mjs";

const [server, runtimePath] = process.argv.slice(2);
if (server !== "qmd" && server !== "longmemory") throw new Error("Choose qmd or longmemory.");
if (process.platform !== "win32") process.umask(0o077);
/** @type {import('./mcp_runtime.mjs').MemoryRuntime} */
const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
secureMemoryStorage(runtime.paths, process.platform);
const settings = server === "longmemory" ? parseEnvFile(fs.readFileSync(runtime.paths.envPath, "utf8")) : {};
if (server === "longmemory") {
    const model = settings.LONGMEMORY_OLLAMA_EMBEDDING_MODEL;
    if (!model) throw new Error("LongMemory embedding model is missing from its settings.");
    await waitFor("LongMemory embedding model", async () => longMemoryGateReady(await probeJson(OLLAMA_TAGS_URL), model), 120);
}
const spec = memoryProcessSpec(runtime, server, settings, process.env);
const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "inherit", windowsHide: true });
/** @type {NodeJS.Timeout | undefined} */
let killTimer;
function stop(signal) {
    child.kill(signal);
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    killTimer.unref();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
child.once("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once("exit", code => { clearTimeout(killTimer); process.exitCode = code ?? 1; });
