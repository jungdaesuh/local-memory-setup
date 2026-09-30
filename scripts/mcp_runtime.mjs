/** Native MCP process configuration shared by apply, detection and the launcher. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { longMemoryStdio, OLLAMA_ORIGIN } from "./layout.mjs";

/** @typedef {ReturnType<typeof import('./layout.mjs').layout>} Layout */
/** @typedef {'qmd' | 'longmemory'} MemoryServer */
/**
 * @typedef {{node: string, modules: string, qmdEntry: string, paths: Layout}} MemoryRuntime
 */

export const MCP_LAUNCH_FILES = ["mcp_launch.mjs", "mcp_runtime.mjs", "private_storage.mjs", "proc.mjs", "platform.mjs", "layout.mjs", "longmemory_env.mjs", "fs_util.mjs", "health.mjs", "ollama_plan.mjs"];

/** @param {Layout} L @param {string} node */
export function memoryClientSpecs(L, node) {
    const launcher = path.join(L.gateDir, "mcp_launch.mjs");
    return ["qmd", "longmemory"].map((name) => ({ name, command: node, args: [launcher, name, L.runtimePath] }));
}

/**
 * Resolve one upstream stdio command with private, recorded paths. HTTP and model-provider
 * overrides in the agent's environment cannot alter this transport or the data location.
 * @param {MemoryRuntime} runtime
 * @param {MemoryServer} server
 * @param {Readonly<Record<string,string>>} settings
 * @param {NodeJS.ProcessEnv} base
 */
export function memoryProcessSpec(runtime, server, settings, base) {
    const env = Object.fromEntries(Object.entries(base).filter(([key]) => !/^(?:QMD_|LONGMEMORY_|OM_|INDEX_PATH$|NODE_OPTIONS$|NODE_PATH$|OLLAMA_HOST$)/i.test(key)));
    env.PATH = `${path.dirname(runtime.node)}${path.delimiter}${base.PATH ?? ""}`;
    const L = runtime.paths;
    if (server === "qmd") {
        return {
            command: runtime.node,
            args: [runtime.qmdEntry, "--index", "index", "mcp"],
            env: { ...env, QMD_FORCE_CPU: "1", QMD_CONFIG_DIR: path.dirname(L.qmdIndexConfig), INDEX_PATH: L.qmdIndexDb, XDG_CACHE_HOME: path.dirname(path.dirname(L.qmdModelCache)) },
            cwd: L.home,
        };
    }
    return {
        command: runtime.node,
        args: [longMemoryStdio(process.platform === "win32" ? fs.readFileSync(L.currentPointer, "utf8").trim() : L.currentLink), L.dbPath],
        env: { ...env, ...settings, LONGMEMORY_DB_PATH: L.dbPath, LONGMEMORY_MCP_HTTP: "false", LONGMEMORY_OLLAMA_URL: OLLAMA_ORIGIN, LONGMEMORY_TENANT_ID: "default", LONGMEMORY_USER_ID: "default" },
        cwd: L.home,
    };
}

/** The installed launcher, recorded paths and modules must match this setup exactly. */
export function memoryRuntimeCurrent(L, node) {
    if (!fs.existsSync(L.runtimePath)) return false;
    const runtime = JSON.parse(fs.readFileSync(L.runtimePath, "utf8"));
    if (runtime.node !== node || runtime.qmdEntry !== path.join(L.reviewedQmdPackage, "bin", "qmd") || !fs.existsSync(runtime.qmdEntry) || JSON.stringify(runtime.paths) !== JSON.stringify(L)) return false;
    const source = path.dirname(fileURLToPath(import.meta.url));
    return MCP_LAUNCH_FILES.every(name => {
        const installed = path.join(L.gateDir, name);
        return fs.existsSync(installed) && fs.readFileSync(installed).equals(fs.readFileSync(path.join(source, name)));
    });
}
