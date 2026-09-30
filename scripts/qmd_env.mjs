/**
 * QMD device and model policy, per invocation.
 *
 * Retrieval (every subcommand except `embed`, including the MCP server) runs on
 * CPU. `qmd embed` uses the GPU when the probe found one: Metal on Apple silicon,
 * Vulkan elsewhere. QMD reads QMD_FORCE_CPU and QMD_LLAMA_GPU ("metal" | "vulkan" |
 * "cuda" | off) in dist/llm.js resolveLlamaGpuMode.
 *
 * The model is not set here: QMD's index.yml `models` block decides it (see
 * qmd_state.mjs qmdConfiguredModels), and the skill writes that block only for an
 * index that has none.
 */

import path from "node:path";

/**
 * @typedef {readonly [name: string, value: string | null]} EnvSetting null means unset
 */

/**
 * Pins QMD to its global index. Without it, QMD uses a project-local .qmd/index.yml found
 * by walking up from the working directory (dist/cli/qmd.js, --index handling; same in
 * 2.5.3 and 2.8.3), so the setup's collections and vectors could land in a project index.
 */
export const QMD_GLOBAL_INDEX_ARGS = /** @type {const} */ (["--index", "index"]);

/**
 * The folder that goes first on PATH wherever the setup runs QMD. QMD's bin/qmd launcher
 * re-spawns `node` from PATH (2.5.3 bin/qmd: spawn("node", [dist/cli/qmd.js])), so the
 * Node its native modules were built for must come first.
 * @param {string} node
 */
export function qmdPathPrepend(node) {
    return path.dirname(node);
}

/**
 * Both device variables are set or unset explicitly, so a stray value in the
 * user's shell cannot move retrieval onto the GPU.
 * @param {{ gpu: "nvidia" | "apple" | "other" | "none" }} hardware
 * @param {"embed" | "retrieval"} mode
 * @returns {readonly EnvSetting[]}
 */
export function qmdEnvironment(hardware, mode) {
    if (mode === "embed" && hardware.gpu !== "none") {
        return [["QMD_FORCE_CPU", null], ["QMD_LLAMA_GPU", hardware.gpu === "apple" ? "metal" : "vulkan"]];
    }
    return [["QMD_FORCE_CPU", "1"], ["QMD_LLAMA_GPU", null]];
}

/**
 * `base` with `settings` applied: a null value removes the variable.
 * @param {NodeJS.ProcessEnv} base
 * @param {readonly EnvSetting[]} settings
 * @returns {NodeJS.ProcessEnv}
 */
export function withEnv(base, settings) {
    const unset = new Set(settings.filter(([, value]) => value === null).map(([name]) => name));
    const set = Object.fromEntries(settings.flatMap(([name, value]) => (value === null ? [] : [[name, value]])));
    return { ...Object.fromEntries(Object.entries(base).filter(([name]) => !unset.has(name))), ...set };
}

/**
 * The environment the setup runs a QMD command in: the device policy for `mode`, and the
 * setup's Node first on PATH. The dispatcher and runner scripts write the same settings.
 * @param {NodeJS.ProcessEnv} base
 * @param {{ node: string, gpu: "nvidia" | "apple" | "other" | "none", mode: "embed" | "retrieval", delimiter: string }} spec
 * @returns {NodeJS.ProcessEnv}
 */
export function qmdProcessEnv(base, spec) {
    const env = withEnv(base, qmdEnvironment({ gpu: spec.gpu }, spec.mode));
    return { ...env, PATH: `${qmdPathPrepend(spec.node)}${spec.delimiter}${base.PATH ?? ""}` };
}
