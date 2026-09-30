/**
 * What a healthy answer from each server looks like, so a different program on
 * the same port is not mistaken for it.
 * - QMD 2.5.3 GET /health: {"status":"ok","uptime":N} (dist/mcp/server.js)
 * - LongMemory 9ee2c8e1 GET /health: {"data":{"ok":true,...},"meta":{...}}
 *   (src/server/routes/health.ts, src/server/app.ts)
 * - Ollama GET /api/tags: {"models":[{"name":"bge-m3:latest",...}]}
 */
import { ollamaHasModel } from "./ollama_plan.mjs";

/** @param {unknown} body */
export function qmdHealthy(body) {
    return typeof body === "object" && body !== null && /** @type {{ status?: unknown }} */ (body).status === "ok";
}

/** @param {unknown} body */
export function longMemoryHealthy(body) {
    if (typeof body !== "object" || body === null) return false;
    const data = /** @type {{ data?: unknown }} */ (body).data;
    return typeof data === "object" && data !== null && /** @type {{ ok?: unknown }} */ (data).ok === true;
}

/**
 * Model names from an Ollama /api/tags body, or null when the body is not one.
 * @param {unknown} body
 * @returns {string[] | null}
 */
export function ollamaModelNames(body) {
    if (typeof body !== "object" || body === null) return null;
    const models = /** @type {{ models?: unknown }} */ (body).models;
    if (!Array.isArray(models)) return null;
    return models.flatMap((entry) => (typeof entry === "object" && entry !== null && typeof entry.name === "string" ? [entry.name] : []));
}

/**
 * The LongMemory runner's gate: Ollama answers and lists the embedding model.
 * @param {unknown} tagsBody
 * @param {string} model
 */
export function longMemoryGateReady(tagsBody, model) {
    const names = ollamaModelNames(tagsBody);
    return names !== null && ollamaHasModel(names, model);
}
