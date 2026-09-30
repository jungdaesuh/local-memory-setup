/**
 * Build LongMemory's latest `main` commit, verify its native stdio persistence with the
 * upstream SDK, and switch current atomically. The reviewed baseline commit installs from
 * the committed npm lockfile; any other commit gets a freshly derived root-only lockfile
 * that must pass the production audit gate first (longmemory_dependencies.mjs).
 * The previous build remains available until the caller confirms startup, and the
 * memory database lives outside every build directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArtifactFingerprint, buildArtifactInputsPresent } from "./build_integrity.mjs";
import { installLockedDependencies, installReviewedDependencies, installedDependencyFingerprint, reviewedDependencyFingerprint, reviewedDependencyPaths } from "./dependency_install.mjs";
import { LONGMEMORY_COMMIT, fileSha256, longMemoryCli, longMemoryStamp, longMemoryStdio } from "./layout.mjs";
import { auditSummaryPasses, generateAuditedDependencyGraph } from "./longmemory_dependencies.mjs";
import { run } from "./proc.mjs";
import { LONGMEMORY_BUILD_BYTES, installTimeoutMs } from "./sizes.mjs";

export { LONGMEMORY_COMMIT, reviewedDependencyFingerprint };

/**
 * The dependency graph a build was installed from. `reviewed` is the committed lockfile of
 * the baseline commit; `generated` was derived for a newer commit and passed the audit gate.
 * @typedef {{ source: "reviewed" | "generated", dependencyFingerprint: string, packageLockSha256: string, audit: import("./longmemory_dependencies.mjs").AuditSummary | null }} DependencyGraph
 */

/** git ls-remote budget. A hung remote fails the plan instead of waiting out the apply limit. */
export const LS_REMOTE_TIMEOUT_MS = 30_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SMOKE_SCRIPT = fileURLToPath(new URL("./stdio_smoke.mjs", import.meta.url));
const STDIO_BOOTSTRAP = fileURLToPath(new URL("./longmemory_stdio.mjs", import.meta.url));
const BUILD_ID_PATTERN = /^[0-9a-f]{40}-[0-9a-f]{16}(?:-r[1-9][0-9]*)?$/;
const BUILD_SMOKE_TIMEOUT_MS = 60_000;

/** Twelve hex digits: what the plan prints after "LongMemory main @ ". @param {string} sha */
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
    if (!SHA_PATTERN.test(sha)) throw new Error(`git ls-remote main is not a commit sha: ${JSON.stringify(matches[0])}`);
    return sha;
}

/**
 * Resolve `repo`'s refs/heads/main. Network, so the offline --check never calls it.
 * @param {string} repo
 */
export function resolveLongMemoryMain(repo) {
    const result = run("git", ["ls-remote", repo, "refs/heads/main"], {
        timeoutMs: LS_REMOTE_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return parseLsRemoteMain(result.stdout);
}

/** @param {string} sha @param {string} dependencyFingerprint @param {number} [repairIndex] */
export function buildDirectoryName(sha, dependencyFingerprint, repairIndex = 0) {
    if (!SHA_PATTERN.test(sha)) throw new Error(`LongMemory source is not a commit sha: ${JSON.stringify(sha)}.`);
    if (!/^[0-9a-f]{64}$/.test(dependencyFingerprint)) throw new Error("LongMemory dependency fingerprint is not SHA-256.");
    if (!Number.isSafeInteger(repairIndex) || repairIndex < 0) throw new Error("LongMemory repair index must be a non-negative safe integer.");
    const identity = `${sha}-${dependencyFingerprint.slice(0, 16)}`;
    return repairIndex === 0 ? identity : `${identity}-r${repairIndex}`;
}

/**
 * The parsed build receipt, or null when it is missing, SHA-only (legacy) or malformed.
 * @param {string} buildDir
 * @returns {Record<string, unknown> | null}
 */
function readStamp(buildDir) {
    if (!fs.existsSync(longMemoryStamp(buildDir))) return null;
    const content = fs.readFileSync(longMemoryStamp(buildDir), "utf8").trim();
    if (SHA_PATTERN.test(content)) return null;
    let stamp;
    try {
        stamp = JSON.parse(content);
    } catch (error) {
        if (error instanceof SyntaxError) return null;
        throw error;
    }
    return typeof stamp === "object" && stamp !== null && !Array.isArray(stamp) ? stamp : null;
}

/** @param {string} buildDir @param {string} sha @param {string} dependencyFingerprint */
function stampMatches(buildDir, sha, dependencyFingerprint) {
    if (!buildArtifactInputsPresent(buildDir) || !fs.existsSync(longMemoryCli(buildDir))) return false;
    if (!fs.readFileSync(longMemoryStdio(buildDir)).equals(fs.readFileSync(STDIO_BOOTSTRAP))) return false;
    const stamp = readStamp(buildDir);
    if (stamp === null || stamp.commit !== sha || stamp.dependencyFingerprint !== dependencyFingerprint ||
        stamp.artifactFingerprint !== buildArtifactFingerprint(buildDir) || !buildDirectoryMatches(path.basename(buildDir), sha, dependencyFingerprint)) return false;
    return dependencyGraphAccepted(buildDir, sha, dependencyFingerprint, stamp.dependencyGraph);
}

/**
 * The baseline commit counts only with the committed lockfile; any other commit only with
 * a generated graph whose recorded lock hash matches and whose recorded audit passed the gate.
 * @param {string} buildDir @param {string} sha @param {string} dependencyFingerprint @param {unknown} graph
 */
function dependencyGraphAccepted(buildDir, sha, dependencyFingerprint, graph) {
    if (sha === LONGMEMORY_COMMIT) return dependencyFingerprint === reviewedDependencyFingerprint("longmemory");
    if (typeof graph !== "object" || graph === null) return false;
    const recorded = /** @type {{ source?: unknown, packageLockSha256?: unknown, audit?: unknown }} */ (graph);
    return recorded.source === "generated" && recorded.packageLockSha256 === fileSha256(path.join(buildDir, "package-lock.json")) && auditSummaryPasses(recorded.audit);
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
 * The current build when its receipt verifies: the commit it names, its own manifest and
 * lockfile, output, bootstrap and accepted dependency graph. Legacy SHA-only stamps remain
 * usable as rollback targets, but never count as current.
 * @param {{ currentLink: string, currentPointer: string }} L
 * @param {NodeJS.Platform} platform
 * @returns {{ dir: string, commit: string, dependencyFingerprint: string } | null}
 */
export function runningLongMemory(L, platform) {
    const dir = currentBuildDir(L, platform);
    if (dir === null || !buildArtifactInputsPresent(dir)) return null;
    const commit = readStamp(dir)?.commit;
    if (typeof commit !== "string" || !SHA_PATTERN.test(commit)) return null;
    const dependencyFingerprint = installedDependencyFingerprint("longmemory", dir);
    if (!stampMatches(dir, commit, dependencyFingerprint)) return null;
    return { dir, commit, dependencyFingerprint };
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

/**
 * The build receipt: commit, manifest/lock identity, artifact hash, and which graph was
 * installed (source, plain SHA-256 of package-lock.json, production audit counts or null
 * for the committed reviewed lock).
 * @param {string} buildDir @param {string} sha @param {DependencyGraph} graph @param {string} artifactFingerprint
 */
function writeBuildStamp(buildDir, sha, graph, artifactFingerprint) {
    const dependencyGraph = { source: graph.source, packageLockSha256: graph.packageLockSha256, audit: graph.audit };
    writeText(longMemoryStamp(buildDir), `${JSON.stringify({ commit: sha, dependencyFingerprint: graph.dependencyFingerprint, artifactFingerprint, dependencyGraph })}\n`);
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

/**
 * The candidate's manifest and lockfile are the graph it was prepared with (for the
 * reviewed graph, still the committed bytes), its checkout is `sha`, and its tracked
 * source is unmodified.
 * @param {string} buildDir @param {string} sha @param {DependencyGraph} graph
 */
function assertBuildInputs(buildDir, sha, graph) {
    if (graph.source === "reviewed" && reviewedDependencyFingerprint("longmemory") !== graph.dependencyFingerprint) {
        throw new Error(`LongMemory dependency graph changed during build ${buildDir}; candidate was not promoted.`);
    }
    if (installedDependencyFingerprint("longmemory", buildDir) !== graph.dependencyFingerprint) {
        throw new Error(`LongMemory package.json or package-lock.json in ${buildDir} differs from its ${graph.source} dependency graph; candidate was not promoted.`);
    }
    const head = run("git", ["-C", buildDir, "rev-parse", "HEAD"]).stdout.trim();
    if (head !== sha) throw new Error(`LongMemory checkout resolved to ${head}, not ${sha}.`);
    run("git", ["-C", buildDir, "diff", "--quiet", "HEAD", "--", "src", "tsconfig.json"]);
}

/** Fetch exactly `sha` into a fresh repository at `dir`. @param {string} dir @param {string} sha @param {string} repo */
function checkoutCommit(dir, sha, repo) {
    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    run("git", gitInitArgs(dir), { env: gitEnv, stream: true, timeoutMs: installTimeoutMs(LONGMEMORY_BUILD_BYTES) });
    run("git", gitAddRemoteArgs(dir, repo), { env: gitEnv });
    run("git", fetchCommitArgs(dir, sha), { env: gitEnv, stream: true, timeoutMs: installTimeoutMs(LONGMEMORY_BUILD_BYTES) });
    run("git", checkoutCommitArgs(dir, "FETCH_HEAD"), { env: gitEnv, stream: true });
    const head = run("git", ["-C", dir, "rev-parse", "HEAD"]).stdout.trim();
    if (head !== sha) throw new Error(`LongMemory ${sha} checkout resolved to ${head}.`);
}

/** Compile a checkout whose dependencies are installed, then add the stdio bootstrap. @param {string} buildDir @param {string} sha @param {string} node */
function compileCheckout(buildDir, sha, node) {
    run("npm", ["run", "build"], {
        cwd: buildDir,
        env: { ...process.env, CI: "1", PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}` },
        stream: true,
        timeoutMs: installTimeoutMs(0),
    });
    if (!fs.existsSync(longMemoryCli(buildDir))) throw new Error(`LongMemory ${sha} build did not produce ${longMemoryCli(buildDir)}.`);
    fs.copyFileSync(STDIO_BOOTSTRAP, longMemoryStdio(buildDir));
}

/**
 * @typedef {{ sha: string, node: string, repo: string, L: { buildsDir: string } }} CandidateSpec
 * @typedef {{ buildDir: string, state: "absent" | "partial" | "complete", graph: DependencyGraph }} Candidate
 */

/**
 * The reviewed baseline: the committed manifest and lockfile name the build directory up front.
 * @param {CandidateSpec} spec @param {string | null} currentDir @returns {Candidate}
 */
function prepareReviewedCandidate(spec, currentDir) {
    const dependencyFingerprint = reviewedDependencyFingerprint("longmemory");
    /** @type {DependencyGraph} */
    const graph = { source: "reviewed", dependencyFingerprint, packageLockSha256: fileSha256(reviewedDependencyPaths("longmemory").packageLock), audit: null };
    const buildDir = buildCandidateDir(spec.L.buildsDir, spec.sha, dependencyFingerprint, currentDir);
    const state = buildState(buildDir, spec.sha, dependencyFingerprint);
    const plan = buildDirPlan(buildDir, currentDir, state);
    if (plan === "keep-current") throw new Error(`LongMemory ${spec.sha} current build is incomplete and was not deleted; a repair build could not be selected.`);
    if (plan === "replace") fs.rmSync(buildDir, { recursive: true, force: true });
    if (plan === "create" || plan === "replace") {
        fs.mkdirSync(spec.L.buildsDir, { recursive: true });
        checkoutCommit(buildDir, spec.sha, spec.repo);
        const installedFingerprint = installReviewedDependencies("longmemory", buildDir, spec.node);
        if (installedFingerprint !== dependencyFingerprint) throw new Error("LongMemory dependency fingerprint changed before npm ci.");
        compileCheckout(buildDir, spec.sha, spec.node);
    }
    return { buildDir, state, graph };
}

/**
 * A newer commit: its lockfile exists only once generated inside a checkout, so the checkout
 * starts in a staging directory, is audited there, and moves to the build directory its
 * graph names before `npm ci`. A blocked audit removes the staging checkout and leaves every
 * existing build, the current pointer and the database as they were.
 * @param {CandidateSpec} spec @param {string | null} currentDir @returns {Candidate}
 */
function prepareGeneratedCandidate(spec, currentDir) {
    const staging = stagingCheckoutDir(spec.L.buildsDir, spec.sha);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(spec.L.buildsDir, { recursive: true });
    try {
        checkoutCommit(staging, spec.sha, spec.repo);
        const graph = generateAuditedDependencyGraph({ checkoutDir: staging, sha: spec.sha, node: spec.node });
        const buildDir = buildCandidateDir(spec.L.buildsDir, spec.sha, graph.dependencyFingerprint, currentDir);
        const state = buildState(buildDir, spec.sha, graph.dependencyFingerprint);
        const plan = buildDirPlan(buildDir, currentDir, state);
        if (plan === "keep-current") throw new Error(`LongMemory ${spec.sha} current build is incomplete and was not deleted; a repair build could not be selected.`);
        if (plan === "replace") fs.rmSync(buildDir, { recursive: true, force: true });
        if (plan === "create" || plan === "replace") {
            fs.renameSync(staging, buildDir);
            installLockedDependencies("longmemory", buildDir, spec.node);
            compileCheckout(buildDir, spec.sha, spec.node);
        }
        return { buildDir, state, graph };
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

/**
 * Where a newer commit is checked out and audited before its build directory is known.
 * Hidden, so pruning (which matches build ids only) never mistakes it for a build.
 * @param {string} buildsDir @param {string} sha
 */
export function stagingCheckoutDir(buildsDir, sha) {
    if (!SHA_PATTERN.test(sha)) throw new Error(`LongMemory source is not a commit sha: ${JSON.stringify(sha)}.`);
    return path.join(buildsDir, `.candidate-${sha}`);
}

/**
 * Build `sha` (the resolved main) with its dependency graph: the committed lockfile for the
 * reviewed baseline commit, otherwise a generated lockfile that passed the audit gate. Then
 * prove native stdio tools/list, persistence, recall, and clean shutdown before promotion.
 * @param {{ sha: string, node: string, repo: string, platform: NodeJS.Platform, tools: readonly string[], deferPrune: boolean, L: { buildsDir: string, longmemoryRoot: string, currentLink: string, currentPointer: string, previousBuildFile: string, switchMarker: string } }} spec
 */
export async function installLongMemoryCommit(spec) {
    if (!SHA_PATTERN.test(spec.sha)) throw new Error(`LongMemory source is not a commit sha: ${JSON.stringify(spec.sha)}.`);
    const currentDir = currentBuildDir(spec.L, spec.platform);
    const { buildDir, state, graph } = spec.sha === LONGMEMORY_COMMIT ? prepareReviewedCandidate(spec, currentDir) : prepareGeneratedCandidate(spec, currentDir);
    const previousArtifactFingerprint = state === "complete" ? readStamp(buildDir)?.artifactFingerprint : null;
    assertBuildInputs(buildDir, spec.sha, graph);
    await smokeTestLongMemory({ commit: spec.sha, node: spec.node, buildDir, tools: spec.tools });
    assertBuildInputs(buildDir, spec.sha, graph);
    const artifactFingerprint = buildArtifactFingerprint(buildDir);
    if (state === "complete" && previousArtifactFingerprint !== artifactFingerprint) {
        throw new Error(`LongMemory ${spec.sha} build output changed while its native stdio smoke check ran.`);
    }
    if (state !== "complete") writeBuildStamp(buildDir, spec.sha, graph, artifactFingerprint);
    if (!stampMatches(buildDir, spec.sha, graph.dependencyFingerprint)) throw new Error(`LongMemory ${spec.sha} artifact receipt did not match the completed build.`);
    switchCurrentBuild(buildDir, spec.L, spec.platform);
    if (!spec.deferPrune) finishSwitch(spec.L, spec.platform);
}

/** @param {{ buildsDir: string, currentLink: string, currentPointer: string, previousBuildFile: string, switchMarker: string }} L @param {NodeJS.Platform} platform */
export function pruneAfterSwitch(L, platform) {
    return finishSwitch(L, platform);
}
