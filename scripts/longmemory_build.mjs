/**
 * Build the reviewed LongMemory commit from the committed npm lockfile, verify
 * its native stdio persistence with the upstream SDK, and switch current atomically.
 * The previous build remains available until the caller confirms startup.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArtifactFingerprint, buildArtifactInputsPresent } from "./build_integrity.mjs";
import { installReviewedDependencies, reviewedDependencyFingerprint, reviewedDependencyPaths } from "./dependency_install.mjs";
import { LONGMEMORY_COMMIT, longMemoryCli, longMemoryStamp, longMemoryStdio } from "./layout.mjs";
import { run } from "./proc.mjs";
import { LONGMEMORY_BUILD_BYTES, installTimeoutMs } from "./sizes.mjs";

export { LONGMEMORY_COMMIT, reviewedDependencyFingerprint };

const SMOKE_SCRIPT = fileURLToPath(new URL("./stdio_smoke.mjs", import.meta.url));
const STDIO_BOOTSTRAP = fileURLToPath(new URL("./longmemory_stdio.mjs", import.meta.url));
const BUILD_ID_PATTERN = /^[0-9a-f]{40}-[0-9a-f]{16}(?:-r[1-9][0-9]*)?$/;
const BUILD_SMOKE_TIMEOUT_MS = 60_000;

/** @param {string} sha */
export function shortSha(sha) {
    return sha.slice(0, 12);
}

/** @param {string} sha @param {string} dependencyFingerprint @param {number} [repairIndex] */
export function buildDirectoryName(sha, dependencyFingerprint, repairIndex = 0) {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`LongMemory source is not a commit sha: ${JSON.stringify(sha)}.`);
    if (!/^[0-9a-f]{64}$/.test(dependencyFingerprint)) throw new Error("LongMemory dependency fingerprint is not SHA-256.");
    if (!Number.isSafeInteger(repairIndex) || repairIndex < 0) throw new Error("LongMemory repair index must be a non-negative safe integer.");
    const identity = `${sha}-${dependencyFingerprint.slice(0, 16)}`;
    return repairIndex === 0 ? identity : `${identity}-r${repairIndex}`;
}

/** @param {string} buildDir @param {string} sha @param {string} dependencyFingerprint */
function stampMatches(buildDir, sha, dependencyFingerprint) {
    if (!buildArtifactInputsPresent(buildDir) || !fs.existsSync(longMemoryCli(buildDir)) || !fs.existsSync(longMemoryStamp(buildDir))) return false;
    if (!fs.readFileSync(longMemoryStdio(buildDir)).equals(fs.readFileSync(STDIO_BOOTSTRAP))) return false;
    const content = fs.readFileSync(longMemoryStamp(buildDir), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(content)) return false;
    let stamp;
    try {
        stamp = JSON.parse(content);
    } catch (error) {
        if (error instanceof SyntaxError) return false;
        throw error;
    }
    if (typeof stamp !== "object" || stamp === null || stamp.commit !== sha || stamp.dependencyFingerprint !== dependencyFingerprint ||
        stamp.artifactFingerprint !== buildArtifactFingerprint(buildDir) || !buildDirectoryMatches(path.basename(buildDir), sha, dependencyFingerprint)) return false;
    return true;
}

/** @param {string} name @param {string} sha @param {string} dependencyFingerprint */
function buildDirectoryMatches(name, sha, dependencyFingerprint) {
    const identity = buildDirectoryName(sha, dependencyFingerprint);
    return name === identity || new RegExp(`^${identity}-r[1-9][0-9]*$`).test(name);
}

/** @param {string} buildsDir @param {string} sha @param {string} dependencyFingerprint @param {string | null} currentDir */
export function buildCandidateDir(buildsDir, sha, dependencyFingerprint, currentDir) {
    const identity = buildDirectoryName(sha, dependencyFingerprint);
    const candidate = path.join(buildsDir, identity);
    if (currentDir === null || path.resolve(currentDir) !== path.resolve(candidate) || buildState(candidate, sha, dependencyFingerprint) === "complete") return candidate;
    return path.join(buildsDir, buildDirectoryName(sha, dependencyFingerprint, 1));
}

/**
 * Current reviewed build only. Legacy SHA-only stamps remain usable as rollback
 * targets, but never count as current after the dependency graph is pinned.
 * @param {{ currentLink: string, currentPointer: string }} L
 * @param {NodeJS.Platform} platform
 * @returns {{ dir: string, commit: string, dependencyFingerprint: string } | null}
 */
export function runningLongMemory(L, platform) {
    const dir = currentBuildDir(L, platform);
    if (dir === null) return null;
    const dependencyFingerprint = reviewedDependencyFingerprint("longmemory");
    if (!stampMatches(dir, LONGMEMORY_COMMIT, dependencyFingerprint)) return null;
    return { dir, commit: LONGMEMORY_COMMIT, dependencyFingerprint };
}

/**
 * @param {string} buildDir
 * @param {string} sha
 * @param {string} dependencyFingerprint
 * @returns {"absent" | "partial" | "complete"}
 */
export function buildState(buildDir, sha, dependencyFingerprint) {
    if (!fs.existsSync(buildDir)) return "absent";
    return stampMatches(buildDir, sha, dependencyFingerprint) ? "complete" : "partial";
}

/** @param {string} buildDir @param {string | null} currentDir @param {"absent" | "partial" | "complete"} state */
export function buildDirPlan(buildDir, currentDir, state) {
    const same = currentDir !== null && path.resolve(buildDir) === path.resolve(currentDir);
    if (same && state === "complete") return "reuse-current";
    if (same) return "keep-current";
    if (state === "complete") return "reuse";
    if (state === "partial") return "replace";
    return "create";
}

/** @param {string} buildDir */
export function gitInitArgs(buildDir) {
    return ["init", "--quiet", buildDir];
}

/** @param {string} buildDir @param {string} repo */
export function gitAddRemoteArgs(buildDir, repo) {
    return ["-C", buildDir, "remote", "add", "origin", repo];
}

/** @param {string} buildDir @param {string} sha */
export function fetchCommitArgs(buildDir, sha) {
    return ["-C", buildDir, "fetch", "--no-tags", "--depth", "1", "origin", sha];
}

/** @param {string} buildDir @param {string} sha */
export function checkoutCommitArgs(buildDir, sha) {
    return ["-C", buildDir, "checkout", "--detach", sha];
}

/** @param {readonly string[]} names @param {readonly string[]} keep */
export function directoriesToRemove(names, keep) {
    return names.filter((name) => (BUILD_ID_PATTERN.test(name) || /^[0-9a-f]{40}$/.test(name)) && !keep.includes(name));
}

/** @param {string | null} currentDir @param {string | null} previousDir */
export function buildsToKeep(currentDir, previousDir) {
    const names = [];
    for (const dir of [currentDir, previousDir]) {
        if (dir === null) continue;
        const name = path.basename(dir);
        if ((BUILD_ID_PATTERN.test(name) || /^[0-9a-f]{40}$/.test(name)) && !names.includes(name)) names.push(name);
    }
    return names;
}

/** @param {string} buildsDir @param {readonly string[]} keep */
export function pruneBuilds(buildsDir, keep) {
    if (!fs.existsSync(buildsDir)) return [];
    const removed = [];
    for (const name of directoriesToRemove(fs.readdirSync(buildsDir), keep)) {
        fs.rmSync(path.join(buildsDir, name), { recursive: true, force: true });
        removed.push(name);
    }
    return removed.sort();
}

/** @param {string} file @param {string} text */
function writeText(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
}

/** @param {string} buildDir @param {{ longmemoryRoot: string, currentLink: string, currentPointer: string }} L @param {NodeJS.Platform} platform */
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

/** @param {string} buildDir @param {{ longmemoryRoot: string, currentLink: string, currentPointer: string, previousBuildFile: string, switchMarker: string }} L @param {NodeJS.Platform} platform */
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

/** @param {{ buildsDir: string, currentLink: string, currentPointer: string, previousBuildFile: string, switchMarker: string }} L @param {NodeJS.Platform} platform */
export function finishSwitch(L, platform) {
    if (!fs.existsSync(L.switchMarker)) return [];
    const removed = pruneBuilds(L.buildsDir, buildsToKeep(currentBuildDir(L, platform), previousBuildDir(L)));
    fs.rmSync(L.switchMarker, { force: true });
    return removed;
}

/** @param {{ longmemoryRoot: string, currentLink: string, currentPointer: string, previousBuildFile: string, switchMarker: string }} L @param {NodeJS.Platform} platform */
export function rollbackSwitch(L, platform) {
    const previous = previousBuildDir(L);
    if (previous !== null) pointCurrentAt(previous, L, platform);
    if (fs.existsSync(L.switchMarker)) fs.rmSync(L.switchMarker, { force: true });
    return previous;
}

/** @param {string} buildDir @param {string} sha @param {string} dependencyFingerprint @param {string} artifactFingerprint */
function writeBuildStamp(buildDir, sha, dependencyFingerprint, artifactFingerprint) {
    writeText(longMemoryStamp(buildDir), `${JSON.stringify({ commit: sha, dependencyFingerprint, artifactFingerprint })}\n`);
}

/** @param {string} node @param {string} buildDir @param {string} dbPath @param {readonly string[]} tools */
export function smokeInvocation(node, buildDir, dbPath, tools) {
    const smokePath = path.join(buildDir, path.basename(SMOKE_SCRIPT));
    return {
        command: node,
        args: [smokePath, longMemoryStdio(buildDir), dbPath, JSON.stringify(tools)],
        cwd: buildDir,
    };
}

/** @param {{ commit: string, node: string, buildDir: string, tools: readonly string[] }} spec */
export async function smokeTestLongMemory(spec) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-lm-smoke-"));
    const dbPath = path.join(dir, "smoke.db");
    const smokePath = path.join(spec.buildDir, path.basename(SMOKE_SCRIPT));
    try {
        fs.copyFileSync(SMOKE_SCRIPT, smokePath);
        const invocation = smokeInvocation(spec.node, spec.buildDir, dbPath, spec.tools);
        run(invocation.command, invocation.args, {
            cwd: invocation.cwd,
            env: smokeEnvironment(process.env),
            timeoutMs: BUILD_SMOKE_TIMEOUT_MS,
            stream: true,
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`LongMemory ${spec.commit} failed the native stdio smoke check: ${detail}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(smokePath, { force: true });
    }
}

/** @param {NodeJS.ProcessEnv} base @returns {NodeJS.ProcessEnv} */
function smokeEnvironment(base) {
    return Object.fromEntries(Object.entries(base).filter(([key]) => !/^(?:LONGMEMORY_|OM_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
}

/**
 * Resolve `current`, or null when no build is selected. A broken pointer is an
 * integrity error; it must not be treated as an empty installation.
 * @param {{ currentLink: string, currentPointer: string }} L
 * @param {NodeJS.Platform} platform
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

/** @param {string} buildDir @param {string} fingerprint */
function assertReviewedInputs(buildDir, fingerprint) {
    const currentFingerprint = reviewedDependencyFingerprint("longmemory");
    if (currentFingerprint !== fingerprint) throw new Error(`LongMemory dependency graph changed during build ${buildDir}; candidate was not promoted.`);
    const reviewed = reviewedDependencyPaths("longmemory");
    for (const [file, reviewedPath] of [["package.json", reviewed.packageJson], ["package-lock.json", reviewed.packageLock]]) {
        const targetBytes = fs.readFileSync(path.join(buildDir, file));
        const reviewedBytes = fs.readFileSync(reviewedPath);
        if (!targetBytes.equals(reviewedBytes)) throw new Error(`LongMemory ${file} differs from the reviewed dependency graph; candidate was not promoted.`);
    }
    const head = run("git", ["-C", buildDir, "rev-parse", "HEAD"]).stdout.trim();
    if (head !== LONGMEMORY_COMMIT) throw new Error(`LongMemory checkout resolved to ${head}, not reviewed commit ${LONGMEMORY_COMMIT}.`);
    run("git", ["-C", buildDir, "diff", "--quiet", "HEAD", "--", "src", "tsconfig.json"]);
}

/**
 * Build the pinned source with the reviewed root npm graph, then prove native
 * stdio tools/list, persistence, recall, and clean shutdown before promotion.
 * @param {{ sha: string, node: string, repo: string, platform: NodeJS.Platform, tools: readonly string[], deferPrune: boolean, L: { buildsDir: string, longmemoryRoot: string, currentLink: string, currentPointer: string, previousBuildFile: string, switchMarker: string } }} spec
 */
export async function installLongMemoryCommit(spec) {
    if (spec.sha !== LONGMEMORY_COMMIT) throw new Error(`LongMemory is pinned to ${LONGMEMORY_COMMIT}, not ${spec.sha}.`);
    const dependencyFingerprint = reviewedDependencyFingerprint("longmemory");
    const currentDir = currentBuildDir(spec.L, spec.platform);
    const buildDir = buildCandidateDir(spec.L.buildsDir, spec.sha, dependencyFingerprint, currentDir);
    const state = buildState(buildDir, spec.sha, dependencyFingerprint);
    const plan = buildDirPlan(buildDir, currentDir, state);
    if (plan === "keep-current") throw new Error(`LongMemory ${spec.sha} current build is incomplete and was not deleted; a repair build could not be selected.`);
    const previousArtifactFingerprint = state === "complete" ? JSON.parse(fs.readFileSync(longMemoryStamp(buildDir), "utf8")).artifactFingerprint : null;
    if (plan === "replace") fs.rmSync(buildDir, { recursive: true, force: true });
    if (plan === "create" || plan === "replace") {
        fs.mkdirSync(spec.L.buildsDir, { recursive: true });
        const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
        run("git", gitInitArgs(buildDir), { env: gitEnv, stream: true, timeoutMs: installTimeoutMs(LONGMEMORY_BUILD_BYTES) });
        run("git", gitAddRemoteArgs(buildDir, spec.repo), { env: gitEnv });
        run("git", fetchCommitArgs(buildDir, spec.sha), { env: gitEnv, stream: true, timeoutMs: installTimeoutMs(LONGMEMORY_BUILD_BYTES) });
        run("git", checkoutCommitArgs(buildDir, "FETCH_HEAD"), { env: gitEnv, stream: true });
        const head = run("git", ["-C", buildDir, "rev-parse", "HEAD"]).stdout.trim();
        if (head !== spec.sha) throw new Error(`LongMemory ${spec.sha} checkout resolved to ${head}.`);
        const installedFingerprint = installReviewedDependencies("longmemory", buildDir, spec.node);
        if (installedFingerprint !== dependencyFingerprint) throw new Error("LongMemory dependency fingerprint changed before npm ci.");
        run("npm", ["run", "build"], {
            cwd: buildDir,
            env: { ...process.env, CI: "1", PATH: `${path.dirname(spec.node)}${path.delimiter}${process.env.PATH ?? ""}` },
            stream: true,
            timeoutMs: installTimeoutMs(0),
        });
        if (!fs.existsSync(longMemoryCli(buildDir))) throw new Error(`LongMemory ${spec.sha} build did not produce ${longMemoryCli(buildDir)}.`);
        fs.copyFileSync(STDIO_BOOTSTRAP, longMemoryStdio(buildDir));
        assertReviewedInputs(buildDir, dependencyFingerprint);
    }
    assertReviewedInputs(buildDir, dependencyFingerprint);
    await smokeTestLongMemory({ commit: spec.sha, node: spec.node, buildDir, tools: spec.tools });
    assertReviewedInputs(buildDir, dependencyFingerprint);
    const artifactFingerprint = buildArtifactFingerprint(buildDir);
    if (state === "complete" && previousArtifactFingerprint !== artifactFingerprint) {
        throw new Error(`LongMemory ${spec.sha} build output changed while its native stdio smoke check ran.`);
    }
    if (state !== "complete") writeBuildStamp(buildDir, spec.sha, dependencyFingerprint, artifactFingerprint);
    if (!stampMatches(buildDir, spec.sha, dependencyFingerprint)) throw new Error(`LongMemory ${spec.sha} artifact receipt did not match the completed build.`);
    switchCurrentBuild(buildDir, spec.L, spec.platform);
    if (!spec.deferPrune) finishSwitch(spec.L, spec.platform);
}

/** @param {{ buildsDir: string, currentLink: string, currentPointer: string, previousBuildFile: string, switchMarker: string }} L @param {NodeJS.Platform} platform */
export function pruneAfterSwitch(L, platform) {
    return finishSwitch(L, platform);
}
