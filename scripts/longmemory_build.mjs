/**
 * Build and switch LongMemory from the current `main` of LONGMEMORY_REPO.
 *
 * A candidate commit is cloned into its own directory, built, and smoke-tested
 * on a free loopback port with a throwaway database. The running build is
 * replaced only after those checks pass: `current` becomes a symlink (Linux
 * and macOS) or current.txt (Windows, which the runner reads). Older builds
 * are deleted only after that switch succeeds, and only down to the current
 * and previous directories. The memory database stays outside builds/.
 *
 * Health is GET /health (src/server/routes/health.ts, src/server/app.ts). MCP
 * is POST /mcp. The server builds a new stateless Streamable HTTP transport
 * per request (src/mcp/transports/http.ts, sessionIdGenerator unset), so
 * tools/list is one POST: Accept must list both application/json and
 * text/event-stream, and no session is required.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { longMemoryHealthy } from "./health.mjs";
import { longMemoryCli, longMemoryServeArgv, longMemoryStamp } from "./layout.mjs";
import { LONGMEMORY_ENV_KEYS, renderEnvFile } from "./longmemory_env.mjs";
import { binEntry } from "./platform.mjs";
import { run } from "./proc.mjs";
import { LONGMEMORY_BUILD_BYTES, downloadTimeoutMs, installTimeoutMs } from "./sizes.mjs";

/** git ls-remote budget. A hung remote fails the plan instead of waiting out the apply limit. */
export const LS_REMOTE_TIMEOUT_MS = 30_000;
/** How long a smoke-tested `serve` may take to print its ready line. */
export const SMOKE_READY_MS = 60_000;
/** Twelve hex digits: what the plan prints after "LongMemory main @ ". */
export function shortSha(sha) {
    return sha.slice(0, 12);
}

/**
 * The commit `git ls-remote <repo> refs/heads/main` printed. Anything else is an error.
 * @param {string} stdout
 */
export function parseLsRemoteMain(stdout) {
    const matches = stdout.split(/\r?\n/).filter((line) => line.endsWith("\trefs/heads/main"));
    if (matches.length !== 1) throw new Error(`git ls-remote did not report exactly one refs/heads/main (${matches.length} lines).`);
    const sha = matches[0].split("\t")[0];
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`git ls-remote main is not a commit sha: ${JSON.stringify(matches[0])}`);
    return sha;
}

/**
 * Resolve LONGMEMORY_REPO's main. Network, so --check does not call it.
 * @param {string} repo
 */
export function resolveLongMemoryMain(repo) {
    const result = run("git", ["ls-remote", repo, "refs/heads/main"], {
        timeoutMs: LS_REMOTE_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return parseLsRemoteMain(result.stdout);
}

/**
 * @param {string} packageJsonText contents of the checkout's package.json
 * @returns {string} exact pnpm version
 */
export function pinnedPnpmVersion(packageJsonText) {
    const manager = JSON.parse(packageJsonText).packageManager;
    const match = typeof manager === "string" ? /^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(manager) : null;
    if (!match) throw new Error(`LongMemory package.json packageManager is ${JSON.stringify(manager)}, not an exact pnpm version.`);
    return match[1];
}

/**
 * Where `current` points, or null when nothing is current. A pointer that exists
 * but does not name a directory is an error, not "no build".
 * @param {{ currentLink: string, currentPointer: string }} L
 * @param {NodeJS.Platform} platform
 * @returns {string | null}
 */
export function currentBuildDir(L, platform) {
    if (platform === "win32") {
        const text = fs.existsSync(L.currentPointer) ? fs.readFileSync(L.currentPointer, "utf8") : null;
        if (text === null) return null;
        const target = text.trim();
        if (target === "") throw new Error(`${L.currentPointer} is empty.`);
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`LongMemory current points at ${target}, which is not a directory.`);
        return target;
    }
    let linked;
    try {
        linked = fs.readlinkSync(L.currentLink);
    } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
        throw error;
    }
    const target = path.resolve(path.dirname(L.currentLink), linked);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`LongMemory current points at ${target}, which is not a directory.`);
    return target;
}

/**
 * The running build when its stamp, directory name, and CLI agree. Null when
 * current is unset or the directory is not a finished build. A stamp that names
 * a different commit is an error.
 * @param {{ currentLink: string, currentPointer: string }} L
 * @param {NodeJS.Platform} platform
 * @returns {{ dir: string, commit: string } | null}
 */
export function runningLongMemory(L, platform) {
    const dir = currentBuildDir(L, platform);
    if (dir === null) return null;
    const stampPath = longMemoryStamp(dir);
    const stamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, "utf8") : null;
    if (stamp === null || !fs.existsSync(longMemoryCli(dir))) return null;
    const commit = stamp.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${stampPath} does not contain a commit sha.`);
    if (path.basename(dir) !== commit) throw new Error(`LongMemory build ${dir} is stamped ${commit}.`);
    return { dir, commit };
}

/**
 * @param {string} buildDir
 * @param {string} sha
 * @returns {"absent" | "partial" | "complete"}
 */
export function buildState(buildDir, sha) {
    if (!fs.existsSync(buildDir)) return "absent";
    const stampPath = longMemoryStamp(buildDir);
    const stamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, "utf8").trim() : null;
    return stamp === sha && fs.existsSync(longMemoryCli(buildDir)) ? "complete" : "partial";
}

/**
 * What to do with a candidate directory. The running build is never deleted.
 * @param {string} buildDir
 * @param {string | null} currentDir
 * @param {"absent" | "partial" | "complete"} state
 * @returns {"create" | "replace" | "reuse" | "reuse-current" | "keep-current"}
 */
export function buildDirPlan(buildDir, currentDir, state) {
    const same = currentDir !== null && path.resolve(buildDir) === path.resolve(currentDir);
    if (same && state === "complete") return "reuse-current";
    if (same) return "keep-current";
    if (state === "complete") return "reuse";
    if (state === "partial") return "replace";
    return "create";
}

/** @param {string} repo @param {string} buildDir */
export function cloneArgs(repo, buildDir) {
    return ["clone", "--depth", "1", "--branch", "main", repo, buildDir];
}

/** @param {string} buildDir @param {string} sha */
export function fetchCommitArgs(buildDir, sha) {
    return ["-C", buildDir, "fetch", "--depth", "1", "origin", sha];
}

/** @param {string} buildDir @param {string} sha */
export function checkoutCommitArgs(buildDir, sha) {
    return ["-C", buildDir, "checkout", "--detach", sha];
}

/**
 * Directories under builds/ that are safe to delete: full shas other than the ones to keep.
 * @param {readonly string[]} names
 * @param {readonly string[]} keep
 */
export function directoriesToRemove(names, keep) {
    return names.filter((name) => /^[0-9a-f]{40}$/.test(name) && !keep.includes(name));
}

/**
 * @param {string | null} currentDir
 * @param {string | null} previousDir
 */
export function buildsToKeep(currentDir, previousDir) {
    /** @type {string[]} */
    const names = [];
    for (const dir of [currentDir, previousDir]) {
        if (dir === null) continue;
        const name = path.basename(dir);
        if (/^[0-9a-f]{40}$/.test(name) && !names.includes(name)) names.push(name);
    }
    return names;
}

/**
 * @param {string} buildsDir
 * @param {readonly string[]} keep directory names (shas)
 */
export function pruneBuilds(buildsDir, keep) {
    if (!fs.existsSync(buildsDir)) return [];
    /** @type {string[]} */
    const removed = [];
    for (const name of directoriesToRemove(fs.readdirSync(buildsDir), keep)) {
        fs.rmSync(path.join(buildsDir, name), { recursive: true, force: true });
        removed.push(name);
    }
    return removed.sort();
}

/**
 * @param {string} file
 * @param {string} text
 */
function writeText(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
}

/**
 * Point `current` at `buildDir`. On Windows the runner reads current.txt; elsewhere current is a relative symlink.
 * @param {string} buildDir
 * @param {{ longmemoryRoot: string, currentLink: string, currentPointer: string }} L
 * @param {NodeJS.Platform} platform
 */
export function pointCurrentAt(buildDir, L, platform) {
    fs.mkdirSync(L.longmemoryRoot, { recursive: true });
    if (platform === "win32") {
        writeText(L.currentPointer, `${buildDir}\n`);
        return;
    }
    const relative = path.relative(L.longmemoryRoot, buildDir);
    const tmp = path.join(L.longmemoryRoot, `.current.${process.pid}.tmp`);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    fs.symlinkSync(relative, tmp);
    fs.renameSync(tmp, L.currentLink);
}

/**
 * Record the build that is current now, then point current at `buildDir`.
 * The previous path is what a failed restart switches back to.
 * @param {string} buildDir
 * @param {{ longmemoryRoot: string, currentLink: string, currentPointer: string, previousBuildFile: string, switchMarker: string }} L
 * @param {NodeJS.Platform} platform
 */
export function switchCurrentBuild(buildDir, L, platform) {
    const previous = currentBuildDir(L, platform);
    writeText(L.previousBuildFile, previous === null ? "" : `${previous}\n`);
    writeText(L.switchMarker, "pending\n");
    pointCurrentAt(buildDir, L, platform);
    return previous;
}

/** @param {{ previousBuildFile: string }} L */
export function previousBuildDir(L) {
    if (!fs.existsSync(L.previousBuildFile)) return null;
    const dir = fs.readFileSync(L.previousBuildFile, "utf8").trim();
    return dir === "" ? null : dir;
}

/**
 * Delete builds other than current and previous, once a switch has stuck.
 * No marker means no switch is waiting, so nothing is deleted.
 * @param {{ buildsDir: string, currentLink: string, currentPointer: string, previousBuildFile: string, switchMarker: string }} L
 * @param {NodeJS.Platform} platform
 */
export function finishSwitch(L, platform) {
    if (!fs.existsSync(L.switchMarker)) return [];
    const removed = pruneBuilds(L.buildsDir, buildsToKeep(currentBuildDir(L, platform), previousBuildDir(L)));
    fs.rmSync(L.switchMarker, { force: true });
    return removed;
}

/**
 * Point current back at the pre-switch build and drop the prune marker.
 * Returns that directory, or null when there was none.
 * @param {{ longmemoryRoot: string, currentLink: string, currentPointer: string, previousBuildFile: string, switchMarker: string }} L
 * @param {NodeJS.Platform} platform
 */
export function rollbackSwitch(L, platform) {
    const previous = previousBuildDir(L);
    if (previous !== null) pointCurrentAt(previous, L, platform);
    if (fs.existsSync(L.switchMarker)) fs.rmSync(L.switchMarker, { force: true });
    return previous;
}

/**
 * The real service's settings, with a throwaway database and port 0 (the kernel picks a free port).
 * Every other key is unchanged, including host 127.0.0.1 and LONGMEMORY_MCP_HTTP.
 * @param {readonly (readonly [string, string])[]} settings
 * @param {string} dbPath
 */
export function smokeSettings(settings, dbPath) {
    return settings.map(([key, value]) => {
        if (key === "LONGMEMORY_DB_PATH") return /** @type {const} */ ([key, dbPath]);
        if (key === "LONGMEMORY_PORT") return /** @type {const} */ ([key, "0"]);
        return /** @type {const} */ ([key, value]);
    });
}

/**
 * The child environment the runner builds: inherited variables, with the file's
 * keys removed so `node --env-file` supplies them (Node keeps an existing value).
 * @param {NodeJS.ProcessEnv} base
 */
export function longMemoryChildEnv(base) {
    const env = { ...base };
    for (const key of LONGMEMORY_ENV_KEYS) delete env[key];
    return env;
}

/**
 * @param {unknown} value
 * @returns {value is { ok: true, command: "serve", ready: true, url: string, mcp_url: string }}
 */
export function isServeReady(value) {
    if (typeof value !== "object" || value === null) return false;
    const doc = /** @type {Record<string, unknown>} */ (value);
    return doc.ok === true && doc.command === "serve" && doc.ready === true && typeof doc.url === "string" && typeof doc.mcp_url === "string";
}

/**
 * @param {string} urlText
 */
export function loopbackPort(urlText) {
    const url = new URL(urlText);
    if (url.hostname !== "127.0.0.1") throw new Error(`serve bound ${url.hostname}, not 127.0.0.1`);
    const port = Number(url.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`serve URL ${urlText} has no port`);
    return port;
}

/**
 * The ready line means `serve` accepted the runner's arguments and environment.
 * @param {unknown} value
 * @returns {{ port: number, mcpUrl: string }}
 */
export function acceptServeReady(value) {
    if (!isServeReady(value)) throw new Error("serve did not report ok, command serve, ready, url, and mcp_url.");
    const port = loopbackPort(value.url);
    const mcp = new URL(value.mcp_url);
    if (mcp.hostname !== "127.0.0.1" || Number(mcp.port) !== port || mcp.pathname !== "/mcp") {
        throw new Error(`serve MCP URL ${value.mcp_url} is not http://127.0.0.1:${port}/mcp.`);
    }
    return { port, mcpUrl: value.mcp_url };
}

/**
 * Parse complete stdout lines for the ready JSON. A trailing partial line is ignored.
 * @param {string} stdout
 * @returns {unknown | null}
 */
export function readyFromStdout(stdout) {
    const lines = stdout.split(/\r?\n/);
    const complete = stdout.endsWith("\n") || stdout.endsWith("\r") ? lines : lines.slice(0, -1);
    for (const line of complete) {
        if (!line.startsWith("{")) continue;
        const value = JSON.parse(line);
        if (isServeReady(value)) return value;
    }
    return null;
}

/** @param {string} body */
export function jsonMessagesFromSse(body) {
    /** @type {unknown[]} */
    const messages = [];
    /** @type {string[]} */
    let data = [];
    const flush = () => {
        if (data.length === 0) return;
        const text = data.join("\n");
        data = [];
        if (text === "") return;
        messages.push(JSON.parse(text));
    };
    for (const line of body.split(/\r?\n/)) {
        if (line === "") flush();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    flush();
    return messages;
}

/**
 * @param {readonly unknown[]} messages
 * @returns {{ names: string[], errors: string[] }}
 */
export function mcpToolNames(messages) {
    /** @type {string[]} */
    const names = [];
    /** @type {string[]} */
    const errors = [];
    for (const message of messages) {
        if (typeof message !== "object" || message === null) continue;
        const doc = /** @type {Record<string, unknown>} */ (message);
        if (typeof doc.error === "object" && doc.error !== null) {
            const err = /** @type {{ message?: unknown }} */ (doc.error);
            errors.push(typeof err.message === "string" ? err.message : JSON.stringify(doc.error));
        }
        if (typeof doc.result !== "object" || doc.result === null) continue;
        const tools = /** @type {{ tools?: unknown }} */ (doc.result).tools;
        if (!Array.isArray(tools)) continue;
        for (const tool of tools) {
            if (typeof tool === "object" && tool !== null && typeof /** @type {{ name?: unknown }} */ (tool).name === "string") {
                names.push(/** @type {{ name: string }} */ (tool).name);
            }
        }
    }
    return { names, errors };
}

/**
 * @param {string} contentType
 * @param {string} body
 */
export function toolNamesFromMcpHttp(contentType, body) {
    if (contentType.includes("text/event-stream") || body.startsWith("event:") || body.startsWith("data:")) return mcpToolNames(jsonMessagesFromSse(body));
    const parsed = JSON.parse(body);
    return mcpToolNames(Array.isArray(parsed) ? parsed : [parsed]);
}

/** JSON-RPC body for tools/list. Stateless MCP accepts it as the whole POST. */
export function mcpToolsListBody() {
    return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
}

export const MCP_TOOLS_LIST_HEADERS = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
};

/**
 * @param {readonly string[]} required
 * @param {readonly string[]} listed
 */
export function missingToolNames(required, listed) {
    return required.filter((name) => !listed.includes(name));
}

/**
 * Run checks in order. Stop always runs, including when a check throws.
 * The thrown error names the commit and the check.
 * @param {{ commit: string, checks: { name: string, run: () => Promise<void> }[], stop: () => Promise<void> }} spec
 */
export async function runSmokeChecks(spec) {
    /** @type {Error | null} */
    let failure = null;
    try {
        for (const check of spec.checks) {
            try {
                await check.run();
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                failure = new Error(`LongMemory ${spec.commit} failed the ${check.name} check: ${detail}`);
                break;
            }
        }
    } finally {
        await spec.stop();
    }
    if (failure !== null) throw failure;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 */
function stopProcess(child) {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve(undefined);
            return;
        }
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
        }, 2000);
        child.once("exit", () => {
            clearTimeout(timer);
            resolve(undefined);
        });
        child.kill("SIGTERM");
    });
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {() => string} getStdout
 * @param {() => string} getStderr
 * @param {() => Error | null} getSpawnError
 */
function waitUntilReady(child, getStdout, getStderr, getSpawnError) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + SMOKE_READY_MS;
        const timer = setInterval(() => {
            const spawnError = getSpawnError();
            if (spawnError !== null) {
                clearInterval(timer);
                reject(spawnError);
                return;
            }
            if (child.exitCode !== null || child.signalCode !== null) {
                clearInterval(timer);
                const detail = getStderr().trim().slice(-1500);
                reject(new Error(`exited ${child.exitCode ?? child.signalCode} before ready.${detail === "" ? "" : ` ${detail}`}`));
                return;
            }
            try {
                const parsed = readyFromStdout(getStdout());
                if (parsed !== null) {
                    clearInterval(timer);
                    resolve(acceptServeReady(parsed));
                    return;
                }
            } catch (error) {
                clearInterval(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            if (Date.now() >= deadline) {
                clearInterval(timer);
                const detail = getStderr().trim().slice(-1500);
                reject(new Error(`did not report ready within ${SMOKE_READY_MS} ms.${detail === "" ? "" : ` ${detail}`}`));
            }
        }, 50);
    });
}

/**
 * Start `buildDir` the way the runner starts the service, on a free port and a throwaway database.
 * The temporary server is stopped before this returns, success or not.
 * @param {{ commit: string, node: string, buildDir: string, settings: readonly (readonly [string, string])[], tools: readonly string[] }} spec
 */
export async function smokeTestLongMemory(spec) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-lm-smoke-"));
    const dbPath = path.join(dir, "smoke.db");
    const envFile = path.join(dir, "smoke.env");
    fs.writeFileSync(envFile, renderEnvFile(smokeSettings(spec.settings, dbPath)));
    const argv = longMemoryServeArgv(spec.node, envFile, longMemoryCli(spec.buildDir));
    const node = argv[0];
    if (node === undefined) throw new Error("LongMemory serve arguments have no node.");
    const child = spawn(node, argv.slice(1), {
        env: longMemoryChildEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    if (child.stdout === null || child.stderr === null) throw new Error("LongMemory smoke test could not capture serve output.");
    let stdout = "";
    let stderr = "";
    /** @type {Error | null} */
    let spawnError = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
    });
    child.once("error", (error) => {
        spawnError = error;
    });
    /** @type {{ port: number, mcpUrl: string } | null} */
    let ready = null;
    await runSmokeChecks({
        commit: spec.commit,
        stop: async () => {
            await stopProcess(child);
            fs.rmSync(dir, { recursive: true, force: true });
        },
        checks: [
            {
                name: "serve",
                run: async () => {
                    ready = await waitUntilReady(child, () => stdout, () => stderr, () => spawnError);
                },
            },
            {
                name: "health",
                run: async () => {
                    if (ready === null) throw new Error("serve did not become ready.");
                    const healthUrl = `http://127.0.0.1:${ready.port}/health`;
                    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
                    const text = await response.text();
                    if (!response.ok) throw new Error(`GET ${healthUrl} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
                    const body = /** @type {unknown} */ (JSON.parse(text));
                    if (!longMemoryHealthy(body)) throw new Error(`GET ${healthUrl} answered ${text.slice(0, 300)}`);
                },
            },
            {
                name: "tools/list",
                run: async () => {
                    if (ready === null) throw new Error("serve did not become ready.");
                    const response = await fetch(ready.mcpUrl, {
                        method: "POST",
                        headers: MCP_TOOLS_LIST_HEADERS,
                        body: mcpToolsListBody(),
                        signal: AbortSignal.timeout(10_000),
                    });
                    const text = await response.text();
                    if (!response.ok) throw new Error(`POST ${ready.mcpUrl} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
                    const found = toolNamesFromMcpHttp(response.headers.get("content-type") ?? "", text);
                    const missing = missingToolNames(spec.tools, found.names);
                    if (missing.length > 0) {
                        const extra = found.errors.length > 0 ? ` (${found.errors.join("; ")})` : "";
                        throw new Error(`missing ${missing.join(", ")}${extra}`);
                    }
                },
            },
        ],
    });
}

/**
 * @param {string} node
 * @param {string} version
 * @param {{ tools: string, pnpmPackage: string }} L
 */
function ensurePnpm(node, version, L) {
    const pnpmJson = path.join(L.pnpmPackage, "package.json");
    if (!fs.existsSync(pnpmJson) || JSON.parse(fs.readFileSync(pnpmJson, "utf8")).version !== version) {
        run("npm", ["install", "-g", "--prefix", L.tools, `pnpm@${version}`], {
            env: { ...process.env, PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}` },
            stream: true,
            timeoutMs: downloadTimeoutMs(LONGMEMORY_BUILD_BYTES),
        });
    }
    return path.join(L.pnpmPackage, binEntry(JSON.parse(fs.readFileSync(pnpmJson, "utf8")).bin, "pnpm"));
}

/**
 * Clone (or reuse) `sha`, build it, smoke-test it, and point current at it.
 * Does not restart the service and does not prune when `deferPrune` is set:
 * the service restart owns both, so a failed restart can still roll back.
 * @param {{
 *   sha: string,
 *   node: string,
 *   repo: string,
 *   platform: NodeJS.Platform,
 *   settings: readonly (readonly [string, string])[],
 *   tools: readonly string[],
 *   deferPrune: boolean,
 *   L: {
 *     tools: string, pnpmPackage: string, buildsDir: string, longmemoryRoot: string,
 *     currentLink: string, currentPointer: string, previousBuildFile: string, switchMarker: string,
 *   },
 * }} spec
 */
export async function installLongMemoryCommit(spec) {
    const buildDir = path.join(spec.L.buildsDir, spec.sha);
    const currentDir = currentBuildDir(spec.L, spec.platform);
    const plan = buildDirPlan(buildDir, currentDir, buildState(buildDir, spec.sha));
    if (plan === "keep-current") {
        throw new Error(`LongMemory ${spec.sha} failed the build check: ${buildDir} is the running build and it is incomplete. It was not deleted.`);
    }
    if (plan === "replace") fs.rmSync(buildDir, { recursive: true, force: true });
    if (plan === "create" || plan === "replace") {
        fs.mkdirSync(spec.L.buildsDir, { recursive: true });
        const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
        const fetchLimit = downloadTimeoutMs(LONGMEMORY_BUILD_BYTES);
        run("git", cloneArgs(spec.repo, buildDir), { env: gitEnv, stream: true, timeoutMs: fetchLimit });
        let head = run("git", ["-C", buildDir, "rev-parse", "HEAD"]).stdout.trim();
        if (head !== spec.sha) {
            run("git", fetchCommitArgs(buildDir, spec.sha), { env: gitEnv, stream: true, timeoutMs: fetchLimit });
            run("git", checkoutCommitArgs(buildDir, spec.sha), { env: gitEnv, stream: true });
            head = run("git", ["-C", buildDir, "rev-parse", "HEAD"]).stdout.trim();
            if (head !== spec.sha) throw new Error(`LongMemory ${spec.sha} failed the build check: checkout is ${head}.`);
        }
        const pnpmVersion = pinnedPnpmVersion(fs.readFileSync(path.join(buildDir, "package.json"), "utf8"));
        const pnpm = ensurePnpm(spec.node, pnpmVersion, spec.L);
        const env = { ...process.env, CI: "1", PATH: `${path.dirname(spec.node)}${path.delimiter}${process.env.PATH ?? ""}` };
        run(spec.node, [pnpm, "install", "--frozen-lockfile"], { cwd: buildDir, env, stream: true, timeoutMs: installTimeoutMs(LONGMEMORY_BUILD_BYTES) });
        run(spec.node, [pnpm, "build"], { cwd: buildDir, env, stream: true, timeoutMs: installTimeoutMs(0) });
        const cli = longMemoryCli(buildDir);
        if (!fs.existsSync(cli)) throw new Error(`LongMemory ${spec.sha} failed the build check: ${cli} was not produced.`);
        writeText(longMemoryStamp(buildDir), `${spec.sha}\n`);
    }
    await smokeTestLongMemory({ commit: spec.sha, node: spec.node, buildDir, settings: spec.settings, tools: spec.tools });
    switchCurrentBuild(buildDir, spec.L, spec.platform);
    if (!spec.deferPrune) finishSwitch(spec.L, spec.platform);
}

/**
 * After the service is on the new build, drop older directories. On failure the
 * caller rolls the pointer back; this is only the success path.
 * @param {{ buildsDir: string, currentLink: string, currentPointer: string, previousBuildFile: string, switchMarker: string }} L
 * @param {NodeJS.Platform} platform
 */
export function pruneAfterSwitch(L, platform) {
    return finishSwitch(L, platform);
}
