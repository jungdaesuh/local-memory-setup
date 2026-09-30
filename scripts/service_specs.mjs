/**
 * What each generated script must contain, from the facts that determine it.
 * Apply writes these; detection renders the same specs and compares file contents,
 * so a stale script (a moved Node, a new model, an older skill version) counts as not done.
 */
import path from "node:path";
import { OLLAMA_HOST } from "./layout.mjs";
import { qmdEnvironment, qmdPathPrepend } from "./qmd_env.mjs";
import { qmdDispatcher, runnerScript, shQuote } from "./service_files.mjs";

/** @typedef {ReturnType<typeof import("./layout.mjs").layout>} Layout */
/** @typedef {"nvidia" | "apple" | "other" | "none"} Gpu */

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
 * @param {{ binary: string, platform: NodeJS.Platform }} spec
 */
export function ollamaRunnerText(spec) {
    return runnerScript({ env: [["OLLAMA_HOST", OLLAMA_HOST]], pathPrepend: null, gate: null, argv: [spec.binary, "serve"] }, spec.platform);
}
