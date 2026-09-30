/**
 * Decisions and commands the apply executors carry out, as pure functions so they can
 * be tested without a service manager: how to start Ollama for its owner, how to rebuild
 * native modules for the setup's Node, and which native module holds each ABI.
 */
import path from "node:path";

/**
 * What start-ollama does.
 * - A server that answers and is not the setup's own is left alone (a second one would
 *   crash-loop on the port).
 * - The setup's own service is always (re)registered: registerService restarts it when
 *   its runner changed and only starts it otherwise, so an up-to-date service is untouched.
 * @param {{
 *   owner: "system-unit" | "external" | "skill",
 *   platform: "linux" | "darwin" | "win32",
 *   up: boolean,
 *   own: boolean,
 *   unit: { enabled: boolean, active: boolean },
 *   brewService: boolean,
 * }} state
 * @returns {"leave" | "enable-system-unit" | "brew-services-start" | "open-app" | "launch-windows-app" | "register-own"}
 */
export function ollamaStartStep(state) {
    if (state.owner === "system-unit") {
        if (state.unit.enabled && state.unit.active) return "leave";
        // Something else serves the port while the unit is stopped: leave both alone.
        return !state.unit.active && state.up ? "leave" : "enable-system-unit";
    }
    if (state.owner === "external") {
        if (state.up) return "leave";
        if (state.platform === "darwin") return state.brewService ? "brew-services-start" : "open-app";
        return "launch-windows-app";
    }
    return state.up && !state.own ? "leave" : "register-own";
}

/**
 * The file whose exported symbol names the Node ABI a component's native modules were
 * built for (better-sqlite3 exports node_register_module_v<ABI>; QMD and LongMemory
 * both depend on it). node-llama-cpp uses Node-API and does not depend on the ABI.
 * @param {"qmd" | "longmemory"} component
 * @param {{ qmdPackage: string, qmdRoot?: string, sourceDir: string }} L
 */
export function nativeModuleFile(component, L) {
    const root = component === "qmd" ? L.qmdRoot ?? L.qmdPackage : L.sourceDir;
    return path.join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
}

/**
 * The Node ABI (process.versions.modules) a native module was built for, from its
 * `node_register_module_v<N>` export, or null when the binary carries none.
 * @param {Buffer} binary
 * @returns {string | null}
 */
export function nativeModuleAbi(binary) {
    const match = /node_register_module_v(\d+)/.exec(binary.toString("latin1"));
    return match ? match[1] : null;
}

/**
 * The command that rebuilds a component's native modules for `nodeBin`. The Node's own
 * directory goes first on PATH, so npm, node-gyp and prebuild-install all build or
 * fetch binaries for that Node.
 * @param {"qmd" | "longmemory"} component
 * @param {{ L: { qmdPackage: string, qmdRoot?: string, sourceDir: string }, nodeBin: string, npm: string, pathEnv: string, delimiter: string }} spec
 * @returns {{ command: string, args: string[], cwd: string, pathEnv: string }}
 */
export function rebuildCommand(component, spec) {
    const pathEnv = `${path.dirname(spec.nodeBin)}${spec.delimiter}${spec.pathEnv}`;
    if (component === "qmd") return { command: spec.npm, args: ["rebuild"], cwd: spec.L.qmdRoot ?? spec.L.qmdPackage, pathEnv };
    return { command: spec.npm, args: ["rebuild"], cwd: spec.L.sourceDir, pathEnv };
}
