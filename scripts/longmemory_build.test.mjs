import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildArtifactFingerprint } from "./build_integrity.mjs";
import { LONGMEMORY_COMMIT, layout, longMemoryCli, longMemoryStamp, longMemoryStdio } from "./layout.mjs";
import { reviewedDependencyFingerprint } from "./dependency_install.mjs";
import {
    buildDirectoryName,
    buildCandidateDir,
    buildDirPlan,
    buildState,
    buildsToKeep,
    checkoutCommitArgs,
    currentBuildDir,
    directoriesToRemove,
    fetchCommitArgs,
    finishSwitch,
    gitAddRemoteArgs,
    gitInitArgs,
    pointCurrentAt,
    pruneBuilds,
    rollbackSwitch,
    runningLongMemory,
    smokeInvocation,
    switchCurrentBuild,
} from "./longmemory_build.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const DEP_A = "1".repeat(64);
const DEP_B = "2".repeat(64);
const STDIO_BOOTSTRAP = fileURLToPath(new URL("./longmemory_stdio.mjs", import.meta.url));

/** @param {string} root */
function tree(root) {
    const longmemoryRoot = path.join(root, "longmemory");
    return {
        buildsDir: path.join(longmemoryRoot, "builds"),
        longmemoryRoot,
        currentLink: path.join(longmemoryRoot, "current"),
        currentPointer: path.join(longmemoryRoot, "current.txt"),
        previousBuildFile: path.join(longmemoryRoot, "previous"),
        switchMarker: path.join(longmemoryRoot, "switch-pending"),
    };
}

/** @param {string} prefix @param {(root: string) => void} operation */
function withTemp(prefix, operation) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
        operation(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

/** @param {string} buildDir @param {string} sha @param {string} fingerprint */
function finishBuild(buildDir, sha, fingerprint) {
    fs.mkdirSync(path.dirname(longMemoryCli(buildDir)), { recursive: true });
    fs.mkdirSync(path.join(buildDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(buildDir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(buildDir, "package.json"), '{"name":"longmemory"}\n');
    fs.writeFileSync(path.join(buildDir, "package-lock.json"), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(buildDir, "tsconfig.json"), '{"compilerOptions":{}}\n');
    fs.writeFileSync(path.join(buildDir, "src", "index.ts"), "export const ready = true;\n");
    fs.writeFileSync(longMemoryCli(buildDir), "cli");
    fs.copyFileSync(STDIO_BOOTSTRAP, longMemoryStdio(buildDir));
    fs.writeFileSync(path.join(buildDir, "node_modules", ".package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
    const artifactFingerprint = buildArtifactFingerprint(buildDir);
    fs.writeFileSync(longMemoryStamp(buildDir), `${JSON.stringify({ commit: sha, dependencyFingerprint: fingerprint, artifactFingerprint })}\n`);
}

test("build identity pins the exact source and reviewed dependency bytes", () => {
    assert.equal(LONGMEMORY_COMMIT, "9ee2c8e1ed42d83eb788afb9ffc3a82b84405da5");
    assert.equal(buildDirectoryName(SHA_A, DEP_A), `${SHA_A}-${DEP_A.slice(0, 16)}`);
    assert.equal(buildDirectoryName(SHA_A, DEP_A, 1), `${SHA_A}-${DEP_A.slice(0, 16)}-r1`);
    assert.throws(() => buildDirectoryName("main", DEP_A), /not a commit sha/);
    assert.throws(() => buildDirectoryName(SHA_A, "bad"), /not SHA-256/);
    assert.throws(() => buildDirectoryName(SHA_A, DEP_A, -1), /repair index/);
    assert.match(reviewedDependencyFingerprint("longmemory"), /^[0-9a-f]{64}$/);
});

test("git fetch and checkout use only the reviewed commit, never a branch name", () => {
    const directory = "/builds/candidate";
    const repo = "https://github.com/CaviraOSS/LongMemory.git";
    assert.deepEqual(gitInitArgs(directory), ["init", "--quiet", directory]);
    assert.deepEqual(gitAddRemoteArgs(directory, repo), ["-C", directory, "remote", "add", "origin", repo]);
    assert.deepEqual(fetchCommitArgs(directory, SHA_A), ["-C", directory, "fetch", "--no-tags", "--depth", "1", "origin", SHA_A]);
    assert.deepEqual(checkoutCommitArgs(directory, "FETCH_HEAD"), ["-C", directory, "checkout", "--detach", "FETCH_HEAD"]);
});

test("build planning replaces incomplete candidates but preserves the current directory", () => {
    const current = path.resolve("/builds", buildDirectoryName(SHA_A, DEP_A));
    const candidate = path.resolve("/builds", buildDirectoryName(SHA_B, DEP_A));
    assert.equal(buildDirPlan(candidate, null, "absent"), "create");
    assert.equal(buildDirPlan(candidate, current, "partial"), "replace");
    assert.equal(buildDirPlan(candidate, current, "complete"), "reuse");
    assert.equal(buildDirPlan(current, current, "complete"), "reuse-current");
    assert.equal(buildDirPlan(current, current, "partial"), "keep-current");
});

test("build candidates are reused only when source, lock fingerprint, stamp, and CLI agree", () => {
    withTemp("lms-lm-state-", (root) => {
        const candidate = path.join(root, buildDirectoryName(SHA_A, DEP_A));
        assert.equal(buildState(candidate, SHA_A, DEP_A), "absent");
        fs.mkdirSync(candidate, { recursive: true });
        assert.equal(buildState(candidate, SHA_A, DEP_A), "partial");
        finishBuild(candidate, SHA_A, DEP_A);
        assert.equal(buildState(candidate, SHA_A, DEP_A), "complete");
        assert.equal(buildState(candidate, SHA_A, DEP_B), "partial");
        assert.equal(buildState(candidate, SHA_B, DEP_A), "partial");
        for (const [file, replacement] of [
            [path.join(candidate, "src", "index.ts"), "export const ready = false;\n"],
            [longMemoryCli(candidate), "mutated cli"],
            [path.join(candidate, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n'],
            [path.join(candidate, "node_modules", ".package-lock.json"), '{"lockfileVersion":3,"changed":true}\n'],
            [longMemoryStdio(candidate), 'import { run_mcp_stdio } from "./dist/mcp/transports/other.js";\n'],
        ]) {
            const original = fs.readFileSync(file, "utf8");
            fs.writeFileSync(file, replacement);
            assert.equal(buildState(candidate, SHA_A, DEP_A), "partial", `${path.relative(candidate, file)} tampering invalidates the receipt`);
            fs.writeFileSync(file, original);
            assert.equal(buildState(candidate, SHA_A, DEP_A), "complete");
        }
        fs.rmSync(longMemoryCli(candidate));
        assert.equal(buildState(candidate, SHA_A, DEP_A), "partial");
    });
});

test("a malformed receipt is incomplete and a current build is repaired beside it", () => {
    withTemp("lms-lm-bad-stamp-", (root) => {
        const L = tree(root);
        const canonical = path.join(L.buildsDir, buildDirectoryName(SHA_A, DEP_A));
        fs.mkdirSync(canonical, { recursive: true });
        finishBuild(canonical, SHA_A, DEP_A);
        fs.writeFileSync(longMemoryStamp(canonical), "{broken receipt\n");
        pointCurrentAt(canonical, L, "linux");
        assert.equal(buildState(canonical, SHA_A, DEP_A), "partial");
        assert.equal(buildCandidateDir(L.buildsDir, SHA_A, DEP_A, canonical), path.join(L.buildsDir, buildDirectoryName(SHA_A, DEP_A, 1)));
        assert.equal(fs.existsSync(canonical), true);
    });
});

test("a SHA-only legacy build stays available as rollback but is never reported reviewed", () => {
    withTemp("lms-lm-legacy-", (root) => {
        const L = tree(root);
        const legacy = path.join(L.buildsDir, LONGMEMORY_COMMIT);
        fs.mkdirSync(legacy, { recursive: true });
        fs.mkdirSync(path.dirname(longMemoryCli(legacy)), { recursive: true });
        fs.writeFileSync(longMemoryCli(legacy), "legacy cli");
        fs.writeFileSync(longMemoryStamp(legacy), `${LONGMEMORY_COMMIT}\n`);
        pointCurrentAt(legacy, L, "linux");
        assert.equal(runningLongMemory(L, "linux"), null);
    });
});

test("a corrupt current build remains in place while repair selects a new sibling", () => {
    withTemp("lms-lm-current-", (root) => {
        const L = tree(root);
        const canonical = path.join(L.buildsDir, buildDirectoryName(SHA_A, DEP_A));
        fs.mkdirSync(canonical, { recursive: true });
        fs.writeFileSync(path.join(canonical, "preserve"), "current data");
        pointCurrentAt(canonical, L, "linux");
        const repair = buildCandidateDir(L.buildsDir, SHA_A, DEP_A, canonical);
        assert.equal(repair, path.join(L.buildsDir, buildDirectoryName(SHA_A, DEP_A, 1)));
        assert.notEqual(path.resolve(repair), path.resolve(canonical));
        assert.equal(fs.readFileSync(path.join(canonical, "preserve"), "utf8"), "current data");
    });
});

test("pruning keeps the active and previous reviewed builds plus legacy rollback directories", () => {
    withTemp("lms-lm-prune-", (root) => {
        const L = tree(root);
        const idA = buildDirectoryName(SHA_A, DEP_A);
        const idB = buildDirectoryName(SHA_B, DEP_A);
        const idC = buildDirectoryName(SHA_C, DEP_A);
        assert.deepEqual(directoriesToRemove([idA, idB, idC, SHA_C, "notes"], [idA, idC]), [idB, SHA_C]);
        assert.deepEqual(buildsToKeep(path.join(L.buildsDir, idA), path.join(L.buildsDir, SHA_B)), [idA, SHA_B]);
        fs.mkdirSync(L.buildsDir, { recursive: true });
        for (const name of [idA, idB, idC, SHA_C, "notes"]) fs.mkdirSync(path.join(L.buildsDir, name));
        assert.deepEqual(pruneBuilds(L.buildsDir, [idA]), [idB, idC, SHA_C].sort());
        assert.deepEqual(fs.readdirSync(L.buildsDir).sort(), [idA, "notes"].sort());
    });
});

test("switch records its rollback target and prunes only after successful startup", () => {
    withTemp("lms-lm-switch-", (root) => {
        const L = tree(root);
        const oldDir = path.join(L.buildsDir, SHA_A);
        const currentDir = path.join(L.buildsDir, buildDirectoryName(SHA_B, DEP_A));
        const extraDir = path.join(L.buildsDir, buildDirectoryName(SHA_C, DEP_A));
        for (const dir of [oldDir, currentDir, extraDir]) fs.mkdirSync(dir, { recursive: true });
        pointCurrentAt(oldDir, L, "linux");
        assert.equal(switchCurrentBuild(currentDir, L, "linux"), oldDir);
        assert.equal(currentBuildDir(L, "linux"), currentDir);
        assert.equal(fs.readFileSync(L.previousBuildFile, "utf8").trim(), oldDir);
        assert.ok(fs.existsSync(L.switchMarker));
        assert.equal(rollbackSwitch(L, "linux"), oldDir);
        assert.equal(currentBuildDir(L, "linux"), oldDir);
        assert.equal(fs.existsSync(L.switchMarker), false);
        switchCurrentBuild(currentDir, L, "linux");
        assert.deepEqual(finishSwitch(L, "linux"), [path.basename(extraDir)]);
        assert.equal(fs.existsSync(oldDir), true);
        assert.equal(fs.existsSync(currentDir), true);
        assert.equal(fs.existsSync(extraDir), false);
    });
});

test("current uses a relative symlink on Unix and an absolute pointer on Windows", () => {
    withTemp("lms-lm-current-pointer-", (root) => {
        const L = tree(root);
        const unixBuild = path.join(L.buildsDir, buildDirectoryName(SHA_A, DEP_A));
        fs.mkdirSync(unixBuild, { recursive: true });
        assert.equal(currentBuildDir(L, "linux"), null);
        pointCurrentAt(unixBuild, L, "linux");
        assert.equal(fs.readlinkSync(L.currentLink), path.join("builds", path.basename(unixBuild)));
        assert.equal(currentBuildDir(L, "linux"), unixBuild);

        const windowsBuild = path.join(L.buildsDir, buildDirectoryName(SHA_B, DEP_A));
        fs.mkdirSync(windowsBuild, { recursive: true });
        pointCurrentAt(windowsBuild, L, "win32");
        assert.equal(fs.readFileSync(L.currentPointer, "utf8"), `${windowsBuild}\n`);
        assert.equal(currentBuildDir(L, "win32"), windowsBuild);
        fs.writeFileSync(L.currentPointer, "\n");
        assert.throws(() => currentBuildDir(L, "win32"), /empty/);
    });
});

test("native smoke launches the candidate MCP with a throwaway database and required tools", () => {
    const buildDir = "/builds/candidate";
    const invocation = smokeInvocation("/node", buildDir, "/private/smoke.db", ["longmemory_recall"]);
    assert.equal(invocation.command, "/node");
    assert.equal(invocation.cwd, buildDir);
    assert.deepEqual(invocation.args, [
        path.join(buildDir, "stdio_smoke.mjs"),
        longMemoryStdio(buildDir),
        "/private/smoke.db",
        '["longmemory_recall"]',
    ]);
    const L = layout("linux", "/home/a");
    assert.equal(path.dirname(L.dbPath), path.dirname(L.longmemoryRoot));
    assert.equal(L.dbPath.includes(`${path.sep}builds${path.sep}`), false);
});
