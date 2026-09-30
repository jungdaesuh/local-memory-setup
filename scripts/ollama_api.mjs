/**
 * Pull a model through Ollama's HTTP API, for a server with no local `ollama`
 * command (Ollama in docker, say).
 *
 * Streaming, because a non-streamed POST /api/pull answers only when the pull is done
 * (Ollama v0.34.4 server/routes.go PullHandler, waitForStream) and fetch gives up on
 * response headers after 300 s (undici headersTimeout), cancelling the pull. Streamed,
 * Ollama answers at once and sends one JSON object per line: progress, then
 * {"status":"success"}, or {"error":"..."} (docs/api.md "Pull a Model").
 */

/**
 * @param {string} pullUrl e.g. http://127.0.0.1:11434/api/pull
 * @param {string} model
 * @param {{ fetchFn?: typeof fetch, timeoutMs: number, onStatus?: (status: string) => void }} options
 */
export async function pullModelViaApi(pullUrl, model, options) {
    const fetchFn = options.fetchFn ?? fetch;
    const response = await fetchFn(pullUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true }),
        signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok || response.body === null) {
        throw new Error(`Ollama refused to pull ${model} (HTTP ${response.status}): ${(await response.text()).trim()}`);
    }
    const decoder = new TextDecoder();
    let pending = "";
    let lastStatus = "";
    for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim()) continue;
            const event = /** @type {{ status?: string, error?: string }} */ (JSON.parse(line));
            if (event.error !== undefined) throw new Error(`Ollama could not pull ${model}: ${event.error}`);
            if (event.status !== undefined && event.status !== lastStatus) {
                lastStatus = event.status;
                options.onStatus?.(event.status);
            }
        }
    }
    const tail = pending.trim();
    if (tail) {
        const event = /** @type {{ status?: string, error?: string }} */ (JSON.parse(tail));
        if (event.error !== undefined) throw new Error(`Ollama could not pull ${model}: ${event.error}`);
        if (event.status !== undefined) lastStatus = event.status;
    }
    if (lastStatus !== "success") throw new Error(`Ollama's pull of ${model} ended without success (last status: ${lastStatus || "none"}).`);
}
