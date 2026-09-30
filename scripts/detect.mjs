/**
 * Read-only detection of the facts plan.mjs works from. Nothing here creates or changes
 * a file, starts a service, or installs anything: it reads files, asks service managers
 * for state, and sends GET requests to local ports. SQLite databases are opened read-only
 * (immutable when no write-ahead log exists, so no -shm/-wal file is created; when a live
 * writer keeps a -wal, SQLite's reader updates the existing -shm index as any reader
 * does). Probing whether admin rights are available (`sudo -n true`, polkit) runs only
 * when asked, so the silent session-start --check never touches sudo.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { grokState, opencodeEffectiveInstructions, opencodeFilesIn } from "./agent_config_files.mjs";
import { codexInstructionsTarget, instructionsBlockCurrent, instructionsText } from "./agent_instructions.mjs";
import { nativeModuleAbi, nativeModuleFile } from "./executor_steps.mjs";
import { readIfExists } from "./fs_util.mjs";
import { longMemoryHealthy, ollamaModelNames, qmdHealthy } from "./health.mjs";
import { LONGMEMORY_HEALTH_URL, LONGMEMORY_REPO, MARKER, OLLAMA_TAGS_URL, QMD_HEALTH_URL, QMD_VERSION, SERVICE_NAMES, SQLITE_URI_NODE } from "./layout.mjs";
import { resolveLongMemoryMain, runningLongMemory } from "./longmemory_build.mjs";
import { parseEnvFile } from "./longmemory_env.mjs";
import { memoryClientSpecs, memoryRuntimeCurrent } from "./mcp_runtime.mjs";
import { reviewedDependencyFingerprint } from "./dependency_install.mjs";
import { QMD_DEFAULT_MODELS } from "./model_choice.mjs";
import { AGENT_IDS } from "./plan.mjs";
import { binEntry, nodeAtLeast } from "./platform.mjs";
import { commandPath, probeJson, run } from "./proc.mjs";
import { memoryStoragePrivate } from "./private_storage.mjs";
import { jsonServerNames } from "./mcp_config.mjs";
import { qmdCollections, qmdConfiguredModels, qmdModelCacheFile } from "./qmd_state.mjs";
import { MANAGED_MARKER, managedPathBlockState } from "./service_files.mjs";
import { dispatcherText, ollamaRunnerText, rcPathLine, runnerFile } from "./service_specs.mjs";
import { inspectStdioJson, inspectStdioToml } from "./stdio_config.mjs";

/** @typedef {import("./plan.mjs").Facts} Facts */
/** @typedef {ReturnType<typeof import("./layout.mjs").layout>} Layout */

export const RC_FILES = [".zshrc", ".bashrc", ".profile"];

/**
 * JSON from a file the setup owns; a malformed one is an error naming the file.
 * @param {string} file
 * @param {string} text
 * @returns {unknown}
 */
function parseNamedJson(file, text) {
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix or delete it, then run again.`);
    }
}

/** @param {string} file */
function managedFileExists(file) {
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() !== true) return false;
    const text = readIfExists(file);
    return text !== null && text.includes(MANAGED_MARKER);
}

/** @returns {import("./model_choice.mjs").Hardware} */
function probeHardware() {
    const ramBytes = os.totalmem();
    if (process.platform === "darwin") {
        // Apple silicon GPUs share system memory; Intel Macs get no GPU embedding.
        return process.arch === "arm64" ? { ramBytes, vramBytes: ramBytes, gpu: "apple" } : { ramBytes, vramBytes: 0, gpu: "none" };
    }
    const nvidia = spawnSync("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (nvidia.error && /** @type {NodeJS.ErrnoException} */ (nvidia.error).code !== "ENOENT") {
        throw new Error(`nvidia-smi: ${nvidia.error.message}`);
    }
    if (nvidia.status === 0 && nvidia.stdout.trim()) {
        const mib = Number(nvidia.stdout.trim().split(/\s+/)[0]);
        if (!Number.isFinite(mib)) throw new Error(`nvidia-smi reported memory ${JSON.stringify(nvidia.stdout.trim())}`);
        return { ramBytes, vramBytes: mib * 1024 * 1024, gpu: "nvidia" };
    }
    if (process.platform === "linux" && fs.existsSync("/dev/dri/renderD128")) return { ramBytes, vramBytes: 0, gpu: "other" };
    return { ramBytes, vramBytes: 0, gpu: "none" };
}

/**
 * Free space on the filesystem that holds `target`, found through its nearest existing ancestor.
 * @param {string} target
 */
export function freeBytesAt(target) {
    let dir = target;
    while (!fs.existsSync(dir)) {
        const parent = path.dirname(dir);
        // path.dirname of a root ("/", "Z:\\") is the root itself: a missing drive has no ancestor.
        if (parent === dir) throw new Error(`No existing folder contains ${target}; is its drive missing?`);
        dir = parent;
    }
    const stats = fs.statfsSync(dir);
    return { path: target, freeBytes: stats.bavail * stats.bsize };
}

/** @param {Layout} L */
function ollamaBinary(L) {
    const onPath = commandPath("ollama");
    if (onPath !== null) return onPath;
    // Documented install locations, for a process whose PATH predates the install.
    const known =
        process.platform === "darwin"
            ? ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "/Applications/Ollama.app/Contents/Resources/ollama"]
            : process.platform === "win32"
              ? [L.ollamaWindowsExe]
              : ["/usr/local/bin/ollama", "/usr/bin/ollama"];
    return known.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function ollamaSystemUnit() {
    if (process.platform !== "linux" || !systemdRunning()) return { loaded: false, enabled: false, active: false };
    const shown = run("systemctl", ["show", "ollama.service", "--property=LoadState,UnitFileState,ActiveState"], { allowFail: true, timeoutMs: 15_000 });
    const props = Object.fromEntries(shown.stdout.split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    return { loaded: props.LoadState === "loaded", enabled: props.UnitFileState === "enabled", active: props.ActiveState === "active" };
}

/** systemd's own test for "booted with systemd" (sd_booted: /run/systemd/system exists). */
function systemdRunning() {
    return fs.existsSync("/run/systemd/system");
}

/** Whether polkit lets an active user enable their own linger without a password. */
function selfLingerAllowed() {
    if (commandPath("pkaction") === null) return false;
    const shown = run("pkaction", ["--action-id", "org.freedesktop.login1.set-self-linger", "--verbose"], { allowFail: true, timeoutMs: 15_000 });
    return /implicit active:\s*yes\b/.test(shown.stdout);
}

/**
 * Whether `service` is registered as the setup's own (its unit, agent, or task exists
 * and is enabled), independent of whether its runner is current.
 * @param {Layout} L
 * @param {"qmd" | "longmemory" | "ollama"} service
 */
function serviceOwn(L, service) {
    const names = SERVICE_NAMES[service];
    if (process.platform === "linux") {
        if (!managedFileExists(path.join(L.systemdUserDir, names.systemd))) return false;
        if (service !== "ollama") return true;
        if (!systemdRunning()) return false;
        const enabled = run("systemctl", ["--user", "is-enabled", names.systemd], { allowFail: true, timeoutMs: 15_000 });
        return enabled.stdout.trim() === "enabled";
    }
    if (process.platform === "darwin") {
        if (!managedFileExists(path.join(L.launchAgentsDir, `${names.launchd}.plist`))) return false;
        if (service !== "ollama") return true;
        return run("launchctl", ["print", `gui/${os.userInfo().uid}/${names.launchd}`], { allowFail: true, timeoutMs: 15_000 }).status === 0;
    }
    const task = run("schtasks", ["/Query", "/TN", names.task, "/XML"], { allowFail: true, timeoutMs: 15_000 });
    return task.status === 0 && task.stdout.includes(MANAGED_MARKER);
}

/** An unmarked registration occupies the exact service name and must never be replaced. */
function serviceForeign(L, service) {
    const names = SERVICE_NAMES[service];
    if (process.platform === "linux") {
        const unit = path.join(L.systemdUserDir, names.systemd);
        return fs.existsSync(unit) && !managedFileExists(unit);
    }
    if (process.platform === "darwin") {
        const agent = path.join(L.launchAgentsDir, `${names.launchd}.plist`);
        return fs.existsSync(agent) && !managedFileExists(agent);
    }
    const task = run("schtasks", ["/Query", "/TN", names.task, "/XML"], { allowFail: true, timeoutMs: 15_000 });
    return task.status === 0 && !task.stdout.includes(MANAGED_MARKER);
}

/**
 * The user PATH as stored, without expanding %VAR% entries (REG_EXPAND_SZ).
 * [Environment]::GetEnvironmentVariable expands them, and writing that back would flatten them.
 */
export const WINDOWS_USER_PATH_READ = "(Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')";

/**
 * The Node every generated script runs: the one apply recorded, while it still exists
 * and has the recorded ABI. Which Node runs --check does not matter; a missing or changed
 * recorded Node makes every script out of date, and apply then uses this process's Node
 * (applyNode, applyAbi), rebuilding native modules whose ABI differs (see plan rebuild-*).
 * `applyVersion` is applyNode's version, which decides whether installs and rebuilds can
 * run (plan.mjs stepsNeedingNewerNode).
 * @param {Layout} L
 * @returns {{ node: string, usable: boolean, applyNode: string, applyAbi: string, applyVersion: string }}
 */
export function setupNode(L) {
    const own = { applyNode: process.execPath, applyAbi: process.versions.modules, applyVersion: process.versions.node };
    const text = readIfExists(L.runtimePath);
    if (text === null) return { node: process.execPath, usable: true, ...own };
    const recorded = /** @type {{ node: string, modules: string }} */ (parseNamedJson(L.runtimePath, text));
    /** @type {[string, string] | null} ABI and version of the recorded Node */
    const probed =
        recorded.node === process.execPath
            ? [process.versions.modules, process.versions.node]
            : fs.existsSync(recorded.node)
              ? versionsOf(recorded.node)
              : null;
    const usable = probed !== null && probed[0] === recorded.modules;
    return {
        node: recorded.node,
        usable,
        ...(usable && probed !== null ? { applyNode: recorded.node, applyAbi: recorded.modules, applyVersion: probed[1] } : own),
    };
}

/**
 * @param {string} node
 * @returns {[string, string] | null} its process.versions.modules and .node, or null when it does not run
 */
function versionsOf(node) {
    const out = spawnSync(node, ["-p", "process.versions.modules + ' ' + process.versions.node"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    const [modules, version] = (out.stdout ?? "").trim().split(" ");
    return out.status === 0 && modules !== undefined && version !== undefined ? [modules, version] : null;
}

/**
 * Whether this Node can read SQLite without writing: official Node builds before 22.15
 * cannot open `file:...?immutable=1` URIs, and a plain read-only open would create
 * -shm/-wal files next to the database. On those versions the checks report "unknown".
 */
export function sqliteReadable() {
    return nodeAtLeast(process.versions.node, SQLITE_URI_NODE);
}

/**
 * Rows of `sql` over a SQLite database, read in a child process (node:sqlite's
 * experimental warning stays out of this process's output). Opened with
 * `immutable=1` when there is no -wal file, so nothing is created next to it; with a
 * -wal (a live writer), opened read-only so the log's rows are seen. Null when the
 * database cannot be read.
 * @param {string} dbPath
 * @param {string} sql
 * @returns {Record<string, unknown>[] | null}
 */
export function queryReadOnly(dbPath, sql) {
    if (!sqliteReadable()) return null;
    const location = fs.existsSync(`${dbPath}-wal`) ? dbPath : `${pathToFileURL(dbPath).href}?immutable=1`;
    const code = [
        'import { DatabaseSync } from "node:sqlite";',
        "const db = new DatabaseSync(process.argv[1], { readOnly: true });",
        "process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all()));",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code, location, sql], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    return result.status === 0 ? JSON.parse(result.stdout) : null;
}

/**
 * Stored LongMemory memories (rows of hydro_nodes, src/stores/sqlite/schema.sql),
 * counted read-only in a child process so node:sqlite's experimental
 * warning stays out of this process's output. Null when the database could not be read.
 * @param {string} dbPath
 * @returns {number | null}
 */
export function countMemories(dbPath) {
    const rows = queryReadOnly(dbPath, "SELECT COUNT(*) AS n FROM hydro_nodes");
    return rows === null ? null : Number(rows[0].n);
}

/**
 * QMD collections with documents that have no complete set of vectors (QMD's own test,
 * dist/store.js getHashesNeedingEmbedding, without its per-model fingerprint: a collection
 * whose embed was interrupted has documents with no vectors at all). Without an index
 * database nothing is embedded yet, so every configured collection is listed. Null when
 * the index cannot be read: the caller treats that as unknown, never as fully embedded.
 * @param {string} indexDb
 * @param {readonly string[]} names collections configured in index.yml
 * @returns {string[] | null}
 */
export function collectionsNeedingEmbedding(indexDb, names) {
    if (!fs.existsSync(indexDb)) return [...names];
    // QMD adds content_vectors.total_chunks lazily (INTEGER NOT NULL DEFAULT 1, dist/store.js);
    // an index from before that migration counts every vector row as a complete document.
    const columns = queryReadOnly(indexDb, "PRAGMA table_info(content_vectors)");
    if (columns === null) return null;
    const expected = columns.some((column) => column.name === "total_chunks") ? "MAX(total_chunks)" : "1";
    const rows = queryReadOnly(
        indexDb,
        [
            "SELECT d.collection AS collection FROM documents d",
            `LEFT JOIN (SELECT hash, COUNT(*) AS chunk_count, ${expected} AS expected FROM content_vectors GROUP BY hash) v ON d.hash = v.hash`,
            "WHERE d.active = 1 AND (v.hash IS NULL OR v.chunk_count < v.expected) GROUP BY d.collection",
        ].join(" "),
    );
    return rows === null ? null : rows.map((row) => String(row.collection));
}

/**
 * Whether each agent already loads the current instructions, from the files each agent
 * reads (see agent_instructions.mjs and agent_config_files.mjs).
 * @param {Layout} L
 * @param {NodeJS.ProcessEnv} env Grok reads GROK_CLAUDE_RULES_ENABLED from it
 * @param {Set<AgentId>} [relevant] agents whose files are parsed (installed or chosen)
 * @param {Partial<Record<AgentId, string>>} [problems] malformed files, by agent
 */
export function detectInstructions(L, env, relevant = new Set(AGENT_IDS), problems = {}) {
    const text = instructionsText();
    const noGrok = { toml: "", compatRules: /** @type {boolean | "unsupported"} */ (true), importsClaudeRules: false, ourDirListed: false, claudeRulesExists: false, editable: true };
    const grok = relevant.has("grok") ? readAgentConfig("grok", L.grokConfig, () => grokState(L, env), noGrok, problems) : noGrok;
    const override = readIfExists(L.codexAgentsOverride);
    const codexFile = readIfExists(codexInstructionsTarget({ override }, L)) ?? "";
    // OpenCode concatenates `instructions` across its two directories: listed in either works.
    const opencodeDirs = [...new Set([L.opencodeMcpDir, L.opencodeInstructionsDir])];
    return {
        shared: readIfExists(L.instructionsFile) === text,
        claudeRules: readIfExists(L.claudeRulesFile) === text,
        claudeRulesExists: grok.claudeRulesExists,
        claudeRulesSeenByGrok: L.claudeRulesSeenByGrok,
        grokCompatRules: grok.compatRules,
        grokImportsClaudeRules: grok.importsClaudeRules,
        grokExtraDir: grok.ourDirListed,
        grokEditable: grok.editable,
        codexBlock: instructionsBlockCurrent(codexFile, text),
        opencodeListed:
            relevant.has("opencode") &&
            readAgentConfig("opencode", L.opencodeInstructionsDir, () => opencodeDirs.some((dir) => opencodeEffectiveInstructions(L, dir).includes(L.instructionsFile)), false, problems),
    };
}

/** @param {Layout} L */
function pathConfigured(L) {
    if (process.platform === "win32") {
        const user = run("powershell", ["-NoProfile", "-Command", WINDOWS_USER_PATH_READ], { timeoutMs: 30_000 });
        return user.stdout.trim().split(";").some((entry) => entry.toLowerCase() === L.dispatchDir.toLowerCase());
    }
    const line = rcPathLine(L);
    return RC_FILES.every((file) => managedPathBlockState(readIfExists(path.join(L.home, file)) ?? "", MARKER, line) === "current");
}

/**
 * A `qmd` first on PATH that this setup did not put there. The first skill version's
 * wrapper path counts as the skill's only while an rc file still carries its marker.
 * @param {Layout} L
 */
function foreignQmdCommand(L) {
    const onPath = commandPath("qmd");
    if (onPath === null) return null;
    const legacyMarked = process.platform !== "win32" && RC_FILES.some((file) => (readIfExists(path.join(L.home, file)) ?? "").includes(`# ${MARKER}`));
    const ours = [L.dispatcher, L.qmdShim, ...(legacyMarked ? [L.legacyDispatcher] : [])];
    const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
    return ours.some((candidate) => same(candidate, onPath)) ? null : onPath;
}


/** @typedef {import("./plan.mjs").AgentId} AgentId */

/**
 * Parse one agent's config; a malformed file becomes a problem naming it instead of
 * stopping detection.
 * @template T
 * @param {AgentId} agent
 * @param {string} file for the message
 * @param {() => T} read
 * @param {T} fallback what the facts use when the file cannot be read
 * @param {Partial<Record<AgentId, string>>} problems
 * @returns {T}
 */
function readAgentConfig(agent, file, read, fallback, problems) {
    try {
        return read();
    } catch (error) {
        problems[agent] = `${file} could not be read (${error instanceof Error ? error.message : String(error)}); fix or remove it, then plan again.`;
        return fallback;
    }
}

/**
 * Which agents are installed and wired. Config files are parsed only for `relevant`
 * agents (installed or chosen); a malformed one is recorded in `problems`.
 * @param {Layout} L
 * @param {string} node the absolute Node path used in desired native stdio entries
 * @param {(installed: Record<AgentId, boolean>) => Set<AgentId>} relevantFor
 * @returns {{ agents: Facts["agents"], problems: Partial<Record<AgentId, string>> }}
 */
function detectAgents(L, node, relevantFor) {
    const installed = {
        claude: commandPath("claude") !== null,
        codex: commandPath("codex") !== null || fs.existsSync(path.dirname(L.codexConfig)),
        grok: commandPath("grok") !== null || fs.existsSync(path.dirname(L.grokConfig)),
        opencode: commandPath("opencode") !== null,
    };
    const relevant = relevantFor(installed);
    /** @type {Partial<Record<AgentId, string>>} */
    const problems = {};
    const specs = memoryClientSpecs(L, node);
    const missing = /** @type {ReturnType<typeof inspectStdioJson>} */ ([]);
    const claudeChecks = relevant.has("claude")
        ? readAgentConfig("claude", L.claudeJson, () => inspectStdioJson(readIfExists(L.claudeJson) ?? "", "claude", specs), missing, problems)
        : missing;
    const codexToml = relevant.has("codex") ? readIfExists(L.codexConfig) ?? "" : "";
    const grokToml = relevant.has("grok") ? readIfExists(L.grokConfig) ?? "" : "";
    const codexChecks = relevant.has("codex") ? inspectStdioToml(codexToml, specs) : missing;
    const grokChecks = relevant.has("grok") ? inspectStdioToml(grokToml, specs) : missing;
    const opencodeChecks = relevant.has("opencode")
        ? readAgentConfig("opencode", L.opencodeMcpDir, () => inspectOpenCodeMemoryConfig(L, specs), missing, problems)
        : missing;
    const checks = { claude: claudeChecks, codex: codexChecks, grok: grokChecks, opencode: opencodeChecks };
    for (const id of AGENT_IDS) {
        const conflict = checks[id].find((entry) => entry.state === "foreign" || entry.state === "blocked");
        if (conflict !== undefined && problems[id] === undefined) {
            problems[id] = `${conflict.name} has a ${conflict.state} MCP configuration${conflict.reason === undefined ? "" : ` (${conflict.reason})`}; resolve it before migrating memory connections.`;
        }
    }
    const agents = /** @type {Facts["agents"]} */ (
        Object.fromEntries(
            AGENT_IDS.map((id) => [
                id,
                {
                    installed: installed[id],
                    qmd: checks[id].some((entry) => entry.name === "qmd" && entry.state === "ready"),
                    longmemory: checks[id].some((entry) => entry.name === "longmemory" && entry.state === "ready"),
                },
            ]),
        )
    );
    return { agents, problems };
}

/** OpenCode's MCP command target is the sole existing JSON/JSONC file with memory servers;
 * without one, it follows the loader's JSON-first preference.
 * @param {Layout} L
 */
export function opencodeMcpConfigFile(L) {
    const files = opencodeFilesIn(L, L.opencodeMcpDir).filter((entry) => ["opencode.json", "opencode.jsonc"].includes(path.basename(entry.file)));
    const withMemoryServers = files.filter((entry) => jsonServerNames(entry.config, "mcp").some((name) => name === "qmd" || name === "longmemory"));
    if (withMemoryServers.length === 1) return withMemoryServers[0].file;
    return files.find((entry) => path.basename(entry.file) === "opencode.json")?.file ?? files.find((entry) => path.basename(entry.file) === "opencode.jsonc")?.file ?? path.join(L.opencodeMcpDir, "opencode.json");
}

/** @param {Layout} L @param {ReturnType<typeof memoryClientSpecs>} specs */
function inspectOpenCodeMemoryConfig(L, specs) {
    const target = opencodeMcpConfigFile(L);
    const files = [...new Set([L.opencodeMcpDir, L.opencodeInstructionsDir])].flatMap((directory) => opencodeFilesIn(L, directory));
    const targetChecks = inspectStdioJson(readIfExists(target) ?? "", "opencode", specs);
    return targetChecks.map((check) => {
        const definitions = files.filter((entry) => typeof entry.config.mcp === "object" && entry.config.mcp !== null && Object.hasOwn(entry.config.mcp, check.name));
        if (definitions.length > 1) {
            return { name: check.name, state: "foreign", reason: "The same server is defined more than once across OpenCode configs; only a single owned entry can be migrated." };
        }
        if (definitions.length === 1 && definitions[0].file !== target) {
            return { name: check.name, state: "foreign", reason: `The server is defined in ${definitions[0].file}, outside the setup's MCP config target.` };
        }
        return check;
    });
}

/**
 * @param {string} packageDir
 * @returns {string | null} QMD's bin/qmd launcher in `packageDir`, or null when QMD is not there
 */
export function qmdEntryIn(packageDir) {
    const pkg = readIfExists(path.join(packageDir, "package.json"));
    return pkg === null ? null : path.join(packageDir, binEntry(JSON.parse(pkg).bin, "qmd"));
}

/** @param {string} dir */
function isQmdPackage(dir) {
    const pkg = readIfExists(path.join(dir, "package.json"));
    return pkg !== null && JSON.parse(pkg).name === "@tobilu/qmd";
}

/**
 * Where an installed QMD package lives: ~/.local (this setup's prefix), else the package
 * behind the `qmd` on PATH (npm links <prefix>/bin/qmd to the package's bin/qmd), else
 * npm's global folder (`npm root -g`), where QMD's README installs it.
 * @param {Layout} L
 * @returns {string | null}
 */
export function locateQmdPackage(L) {
    if (isQmdPackage(L.reviewedQmdPackage)) return L.reviewedQmdPackage;
    if (isQmdPackage(L.qmdPackage)) return L.qmdPackage;
    const onPath = commandPath("qmd");
    if (onPath !== null && process.platform !== "win32") {
        const beside = path.dirname(path.dirname(fs.realpathSync(onPath)));
        if (isQmdPackage(beside)) return beside;
    }
    if (commandPath("npm") === null) return null;
    const root = run("npm", ["root", "-g"], { allowFail: true, timeoutMs: 30_000 });
    const global = path.join(root.stdout.trim(), "@tobilu", "qmd");
    return root.status === 0 && isQmdPackage(global) ? global : null;
}

/**
 * Whether the setup installed the QMD found in `packageDir`, and so may rebuild it: only
 * in its own prefix, with its install stamp naming the version that is there. A QMD
 * found anywhere else (npm's global folder, say) is the user's and is never rebuilt.
 * @param {string | null} packageDir
 * @param {{ qmdPackage: string }} L
 * @param {string | null} stampText the setup's QMD install stamp
 * @param {string | null} packageJsonText the found package's package.json
 */
export function qmdInstalledBySetup(packageDir, L, stampText, packageJsonText) {
    if (packageDir !== L.qmdPackage || stampText === null || packageJsonText === null) return false;
    const stamp = JSON.parse(stampText);
    return stamp.installedBy === MARKER && stamp.dependencyFingerprint === undefined && stamp.version === JSON.parse(packageJsonText).version;
}

/** @param {string | null} packageDir @param {Layout} L @param {string | null} stampText @param {string | null} packageJsonText */
function qmdReviewedCurrent(packageDir, L, stampText, packageJsonText) {
    if (packageDir !== L.reviewedQmdPackage || stampText === null || packageJsonText === null) return false;
    const stamp = JSON.parse(stampText);
    return stamp.installedBy === MARKER && stamp.version === JSON.parse(packageJsonText).version && stamp.version === QMD_VERSION && stamp.dependencyFingerprint === reviewedDependencyFingerprint("qmd");
}

/**
 * @param {Layout} L
 * `resolveMain` asks LONGMEMORY_REPO for refs/heads/main (git ls-remote, network); the offline --check leaves it false.
 * @param {{ probeAdmin: boolean, resolveMain: boolean }} options
 * @returns {Promise<Facts>}
 */
export async function detectFacts(L, options) {
    const platform = /** @type {Facts["platform"]} */ (process.platform);
    const username = os.userInfo().username;
    const { node, usable: nodeUsable, applyAbi } = setupNode(L);
    const hardware = probeHardware();
    const [qmdBody, longMemoryBody, tagsBody] = await Promise.all([probeJson(QMD_HEALTH_URL), probeJson(LONGMEMORY_HEALTH_URL), probeJson(OLLAMA_TAGS_URL)]);
    const ollamaNames = ollamaModelNames(tagsBody);
    const qmdPackageDir = locateQmdPackage(L);
    const qmdPackageJson = qmdPackageDir === null ? null : readIfExists(path.join(qmdPackageDir, "package.json"));
    const qmdEntry = qmdPackageDir === null ? null : qmdEntryIn(qmdPackageDir);
    const indexYaml = readIfExists(L.qmdIndexConfig);
    const configModels = indexYaml === null ? null : qmdConfiguredModels(indexYaml);
    const savedText = readIfExists(L.choicesPath);
    const saved = savedText === null ? null : parseNamedJson(L.choicesPath, savedText);
    const savedAgents = new Set(typeof saved === "object" && saved !== null && Array.isArray(/** @type {{ agents?: unknown }} */ (saved).agents) ? /** @type {{ agents: AgentId[] }} */ (saved).agents : []);
    const detectedAgents = detectAgents(L, node, (installed) => new Set(AGENT_IDS.filter((id) => installed[id] || savedAgents.has(id))));
    const relevantAgents = new Set(AGENT_IDS.filter((id) => detectedAgents.agents[id].installed || savedAgents.has(id)));
    /** @type {Partial<Record<AgentId, string>>} */
    const agentProblems = { ...detectedAgents.problems };
    const instructions = detectInstructions(L, process.env, relevantAgents, agentProblems);
    const envText = readIfExists(L.envPath);
    const env = envText === null ? {} : parseEnvFile(envText);
    const binary = ollamaBinary(L);
    const foreignCommand = foreignQmdCommand(L);
    const dispatcherOk = nodeUsable && qmdEntry !== null && readIfExists(L.dispatcher) === dispatcherText({ node, qmdEntry, gpu: hardware.gpu, platform });
    const collections = indexYaml === null ? [] : qmdCollections(indexYaml);
    const pendingCollections = sqliteReadable() ? collectionsNeedingEmbedding(L.qmdIndexDb, collections.map((collection) => collection.name)) : null;
    const unembeddedFolders = collections.filter((collection) => (pendingCollections ?? []).includes(collection.name)).map((collection) => collection.path);
    // Read-only existence check of QMD's cache for the size note; it never feeds a download.
    const modelUris = [...new Set(Object.values({ ...QMD_DEFAULT_MODELS, ...(configModels ?? {}) }))];
    const cacheFiles = modelUris.map((uri) => /** @type {const} */ ([uri, qmdModelCacheFile(uri)]));
    const qmdInstallStamp = readIfExists(L.qmdInstallStamp);
    const running = runningLongMemory(L, process.platform);
    const main = options.resolveMain ? resolveLongMemoryMain(LONGMEMORY_REPO) : undefined;
    const privateStorage = memoryStoragePrivate(L, platform);
    const nativeRuntime = nodeUsable && memoryRuntimeCurrent(L, node);
    const reviewedQmd = qmdReviewedCurrent(qmdPackageDir, L, qmdInstallStamp, qmdPackageJson);
    const abiOf = (component) => {
        const sourceDir = running === null ? path.join(L.buildsDir, "absent") : running.dir;
        const file = nativeModuleFile(component, {
            qmdPackage: qmdPackageDir ?? L.reviewedQmdPackage,
            ...(qmdPackageDir === L.reviewedQmdPackage ? { qmdRoot: L.qmdRoot } : {}),
            sourceDir,
        });
        return fs.existsSync(file) ? nativeModuleAbi(fs.readFileSync(file)) : null;
    };
    const [qmdAbi, longMemoryAbi] = [abiOf("qmd"), abiOf("longmemory")];
    const own = { qmd: serviceOwn(L, "qmd"), longmemory: serviceOwn(L, "longmemory"), ollama: serviceOwn(L, "ollama") };
    const foreignServices = /** @type {("qmd" | "longmemory")[]} */ (["qmd", "longmemory"]).filter((service) => serviceForeign(L, service));
    const expectedOllamaRunner = binary === null ? null : ollamaRunnerText({ binary, platform });
    const staleServices = own.ollama && (expectedOllamaRunner === null || readIfExists(runnerFile(L, platform, "ollama")) !== expectedOllamaRunner) ? ["ollama"] : [];
    const dbExists = fs.existsSync(L.dbPath);
    const storedMemories = dbExists ? countMemories(L.dbPath) : 0;
    const withoutSystemd = platform === "linux" && !systemdRunning();
    const selfLinger = platform === "linux" && options.probeAdmin && selfLingerAllowed();
    return {
        platform,
        arch: process.arch,
        nodeVersion: process.versions.node,
        username,
        hardware,
        disk: [L.share, L.qmdModelCache].map(freeBytesAt),
        sudoNonInteractive:
            options.probeAdmin && platform === "linux" && commandPath("sudo") !== null && run("sudo", ["-n", "true"], { allowFail: true, timeoutMs: 15_000 }).status === 0,
        lingerEnabled: platform === "linux" && fs.existsSync(path.posix.join("/var/lib/systemd/linger", username)),
        ...(selfLinger ? { selfLingerAllowed: true } : {}),
        ...(withoutSystemd ? { withoutSystemd: true } : {}),
        ...(staleServices.length > 0 ? { staleServices } : {}),
        nodeAbi: applyAbi,
        instructions,
        ...(Object.keys(agentProblems).length > 0 ? { agentProblems } : {}),
        brewAvailable: platform === "darwin" && commandPath("brew") !== null,
        agents: detectedAgents.agents,
        qmd: {
            version: qmdPackageJson === null ? null : JSON.parse(qmdPackageJson).version,
            healthy: qmdHealthy(qmdBody),
            collectionPaths: collections.map((collection) => collection.path),
            ...(configModels === null ? {} : { configModels }),
            ...(foreignCommand === null ? {} : { foreignCommand }),
            ...(unembeddedFolders.length > 0 ? { unembeddedFolders } : {}),
            ...(pendingCollections === null ? (sqliteReadable() ? { embeddingUnknown: true } : { embeddingUnchecked: true }) : {}),
            modelCache: {
                cached: cacheFiles.flatMap(([uri, name]) => (name !== null && fs.existsSync(path.join(L.qmdModelCache, name)) ? [uri] : [])),
                unknown: cacheFiles.flatMap(([uri, name]) => (name === null ? [uri] : [])),
            },
            installedBySetup: qmdInstalledBySetup(qmdPackageDir, L, qmdInstallStamp, qmdPackageJson),
            reviewed: reviewedQmd,
            reviewedOwned: qmdPackageDir === L.reviewedQmdPackage,
            ...(qmdPackageDir === null ? {} : { packageDir: qmdPackageDir }),
            ...(qmdAbi === null ? {} : { nativeAbi: qmdAbi }),
        },
        longmemory: {
            built: running !== null,
            ...(running === null ? {} : { current: running.commit }),
            ...(main === undefined ? {} : { main }),
            healthy: longMemoryHealthy(longMemoryBody),
            envFile: envText !== null,
            ...(env.LONGMEMORY_OLLAMA_EMBEDDING_MODEL === undefined ? {} : { envModel: env.LONGMEMORY_OLLAMA_EMBEDDING_MODEL }),
            dbExists,
            ...(storedMemories === null ? { memoryCountUnknown: true } : { storedMemories }),
            ...(longMemoryAbi === null ? {} : { nativeAbi: longMemoryAbi }),
        },
        ollama: {
            installed: binary !== null,
            healthy: ollamaNames !== null,
            models: ollamaNames ?? [],
            systemUnit: ollamaSystemUnit(),
            ollamaApp:
                platform === "darwin"
                    ? ["/Applications/Ollama.app", path.join(L.home, "Applications", "Ollama.app")].some((app) => fs.existsSync(app))
                    : platform === "win32" && fs.existsSync(L.ollamaWindowsApp),
            brewService: platform === "darwin" && fs.existsSync(path.join(L.launchAgentsDir, "homebrew.mxcl.ollama.plist")),
        },
        services: own,
        foreignServices,
        privateStorage,
        nativeRuntime,
        settingsWritten: envText !== null && dispatcherOk && reviewedQmd && nativeRuntime && privateStorage && (foreignCommand !== null || pathConfigured(L)),
        saved,
        notesDir: fs.existsSync(L.notesDir) && fs.statSync(L.notesDir).isDirectory() ? L.notesDir : null,
        notesPath: L.notesDir,
    };
}

/** Exported for apply, which re-reads these facts after the step that changes them. */
export { detectAgents, ollamaBinary, ollamaSystemUnit, systemdRunning };
