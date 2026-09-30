/**
 * Readiness gate for the LongMemory runner:
 *   node wait_for_ollama.mjs <tags url> <model> <seconds>
 * exits 0 once Ollama's GET /api/tags lists <model>, or 1 after <seconds>. The service
 * manager (or the Windows runner loop) then starts the runner again.
 *
 * LongMemory does not probe its embedding provider at startup, and a failed
 * Ollama call falls through to a synthetic embedder (src/core/embeddings/stack.ts).
 * Waiting for the model itself, not only for the port, keeps a boot-time race or a
 * missing model from writing synthetic vectors. A later Ollama outage still falls back
 * upstream; LongMemory logs it.
 *
 * Copied with ollama_plan.mjs and health.mjs into the skill's bin/gate directory.
 */
import { longMemoryGateReady } from "./health.mjs";

const [url, model, secondsText] = process.argv.slice(2);
const seconds = Number(secondsText);
if (!url || !model || !Number.isFinite(seconds) || seconds <= 0) {
    process.stderr.write("usage: node wait_for_ollama.mjs <tags url> <model> <seconds>\n");
    process.exit(2);
}

const deadline = Date.now() + seconds * 1000;
while (Date.now() < deadline) {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    const body = response?.ok ? await response.json().catch(() => null) : null;
    if (longMemoryGateReady(body, model)) process.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 2000));
}
process.stderr.write(`Ollama at ${url} did not list ${model} within ${seconds} s\n`);
process.exit(1);
