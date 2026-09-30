/**
 * What each generated script must contain, from the facts that determine it.
 * Apply writes these; detection renders the same specs and compares file contents,
 * so a stale script (a moved Node, a new model, an older skill version) counts as not done.
 */
import path from "node:path";
import { LONGMEMORY_ENV_KEYS } from "./longmemory_env.mjs";
import { OLLAMA_HOST, OLLAMA_TAGS_URL, QMD_PORT, longMemoryCli, longMemoryServeArgv } from "./layout.mjs";
import { QMD_GLOBAL_INDEX_ARGS, qmdEnvironment, qmdPathPrepend } from "./qmd_env.mjs";
import { longMemoryWindowsRunner, qmdDispatcher, runnerScript, shQuote } from "./service_files.mjs";

/** @typedef {ReturnType<typeof import("./layout.mjs").layout>} Layout */
/** @typedef {"nvidia" | "apple" | "other" | "none"} Gpu */

/** Seconds the LongMemory runner waits for Ollama before exiting for a restart. */
export const OLLAMA_GATE_SECONDS = 120;
export const GATE_FILES = ["wait_for_ollama.mjs", "ollama_plan.mjs", "health.mjs"];

/**
 * @param {Layout} L
 * @param {NodeJS.Platform} platform
 * @param {"qmd" | "longmemory" | "ollama"} service
 */
export function runnerFile(L, platform, service) {
    return path.join(L.bin, `${service}.${platform === "win32" ? "cmd" : "sh"}`);
}

/**
 * The shell-startup line that puts the skill's `qmd` first on PATH.
 * @param {Layout} L
 */
export function rcPathLine(L) {
    return `export PATH=${shQuote(L.dispatchDir)}:"$PATH"`;
}

/**
 * @param {{ node: string, qmdEntry: string, gpu: Gpu, platform: NodeJS.Platform }} spec
 */
export function dispatcherText(spec) {
    return qmdDispatcher(
        {
            node: spec.node,
            entry: spec.qmdEntry,
            pathPrepend: qmdPathPrepend(spec.node),
            embedEnv: qmdEnvironment({ gpu: spec.gpu }, "embed"),
            retrievalEnv: qmdEnvironment({ gpu: spec.gpu }, "retrieval"),
        },
        spec.platform,
    );
}

/**
 * @param {{ node: string, qmdEntry: string, gpu: Gpu, platform: NodeJS.Platform }} spec
 */
export function qmdRunnerText(spec) {
    return runnerScript(
        {
            env: qmdEnvironment({ gpu: spec.gpu }, "retrieval"),
            pathPrepend: qmdPathPrepend(spec.node),
            gate: null,
            argv: [spec.node, spec.qmdEntry, ...QMD_GLOBAL_INDEX_ARGS, "mcp", "--http", "--port", String(QMD_PORT)],
        },
        spec.platform,
    );
}

/**
 * @param {{ node: string, L: Layout, model: string, platform: NodeJS.Platform }} spec
 */
export function longMemoryRunnerText(spec) {
    const env = LONGMEMORY_ENV_KEYS.map((key) => /** @type {const} */ ([key, null]));
    const gate = [spec.node, path.join(spec.L.gateDir, GATE_FILES[0]), OLLAMA_TAGS_URL, spec.model, String(OLLAMA_GATE_SECONDS)];
    // Windows reads the pointer on each start. Elsewhere the runner execs the symlink, so a restart follows a switched build without rewriting this script.
    if (spec.platform === "win32") {
        return longMemoryWindowsRunner({
            node: spec.node,
            envFile: spec.L.envPath,
            pointer: spec.L.currentPointer,
            env,
            pathPrepend: path.dirname(spec.node),
            gate,
        });
    }
    return runnerScript(
        {
            env,
            pathPrepend: path.dirname(spec.node),
            gate,
            argv: longMemoryServeArgv(spec.node, spec.L.envPath, longMemoryCli(spec.L.currentLink)),
        },
        spec.platform,
    );
}

/**
 * @param {{ binary: string, platform: NodeJS.Platform }} spec
 */
export function ollamaRunnerText(spec) {
    return runnerScript({ env: [["OLLAMA_HOST", OLLAMA_HOST]], pathPrepend: null, gate: null, argv: [spec.binary, "serve"] }, spec.platform);
}
