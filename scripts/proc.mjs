/**
 * Process and HTTP helpers shared by detection and apply. On Windows every
 * command goes through cmd.exe, because npm shims (`npm`, `claude`, `opencode`)
 * are .cmd files that Node will not spawn without a shell (see platform.mjs).
 */
import { spawnSync } from "node:child_process";
import { windowsCommandLine } from "./platform.mjs";

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, allowFail?: boolean, stream?: boolean }} [options]
 *   `stream` sends the child's output to this process's stderr instead of
 *   buffering it: long installs print progress for minutes, and spawnSync kills a
 *   child whose buffered output passes maxBuffer (1 MiB). stdout stays reserved
 *   for the one JSON document this script prints.
 *   `allowFail` returns a non-zero exit instead of throwing; spawn errors and
 *   timeouts always throw.
 */
export function run(command, args, options = {}) {
    const [file, argv, verbatim] =
        process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", windowsCommandLine(command, args)], true] : [command, [...args], false];
    const result = spawnSync(file, argv, {
        encoding: "utf8",
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        stdio: options.stream ? ["ignore", 2, 2] : ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: verbatim,
        windowsHide: true,
    });
    if (result.error) {
        const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
        if (code === "ETIMEDOUT") {
            throw new Error(`${command} ${args.join(" ")} did not finish within ${duration(/** @type {number} */ (options.timeoutMs))} and was stopped.`);
        }
        throw new Error(`${command} ${args.join(" ")}: ${result.error.message}`);
    }
    if (result.status !== 0 && !options.allowFail) {
        const detail = options.stream ? "see the output above" : `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
        throw new Error(`${command} ${args.join(" ")} exited with ${result.status}: ${detail}`);
    }
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** @param {number} ms */
function duration(ms) {
    return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

/**
 * Absolute path of `name` on PATH, or null when it is not installed.
 * @param {string} name
 */
export function commandPath(name) {
    if (process.platform === "win32") {
        const found = run("where", [name], { allowFail: true, timeoutMs: 10_000 });
        return found.status === 0 ? found.stdout.split(/\r?\n/)[0].trim() : null;
    }
    const found = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", name], { encoding: "utf8", timeout: 10_000 });
    if (found.error) throw new Error(`command -v ${name}: ${found.error.message}`);
    const resolved = found.stdout.trim();
    return found.status === 0 && resolved.startsWith("/") ? resolved : null;
}

/**
 * GET `url`; the parsed JSON body when it answers 2xx within the timeout, else null.
 * A listener that is down or slow is a detected fact, not an error.
 * @param {string} url
 * @param {number} [timeoutMs]
 */
export async function probeJson(url, timeoutMs = 3000) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) return null;
        return /** @type {unknown} */ (await response.json());
    } catch {
        return null;
    }
}

/**
 * @param {number} ms
 */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `probe` until it answers true, for at most `seconds` of wall-clock time
 * (probe time included), with one last probe at the deadline.
 * @param {string} label
 * @param {() => Promise<boolean>} probe
 * @param {number} seconds
 * @param {number} [intervalMs]
 */
export async function waitFor(label, probe, seconds, intervalMs = 2000) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
        if (await probe()) return;
        await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
    if (await probe()) return;
    throw new Error(`${label} did not become healthy within ${seconds} s.`);
}
