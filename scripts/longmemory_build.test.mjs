import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { layout, longMemoryCli, longMemoryStamp } from "./layout.mjs";
import { LONGMEMORY_ENV_KEYS, longMemorySettings } from "./longmemory_env.mjs";
import {
    LS_REMOTE_TIMEOUT_MS,
    acceptServeReady,
    buildDirPlan,
    buildState,
    buildsToKeep,
    checkoutCommitArgs,
    cloneArgs,
    currentBuildDir,
    directoriesToRemove,
    fetchCommitArgs,
    finishSwitch,
    installLongMemoryCommit,
    jsonMessagesFromSse,
    longMemoryChildEnv,
    loopbackPort,
    mcpToolNames,
    mcpToolsListBody,
    missingToolNames,
    parseLsRemoteMain,
    pointCurrentAt,
    pruneBuilds,
    readyFromStdout,
    rollbackSwitch,
    runSmokeChecks,
    runningLongMemory,
    shortSha,
    smokeSettings,
    switchCurrentBuild,
    toolNamesFromMcpHttp,
} from "./longmemory_build.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

/** @param {string} root */
function tree(root) {
    const longmemoryRoot = path.join(root, "longmemory");
    return {
        tools: path.join(root, "tools"),
        pnpmPackage: path.join(root, "pnpm"),
        buildsDir: path.join(longmemoryRoot, "builds"),
        longmemoryRoot,
        currentLink: path.join(longmemoryRoot, "current"),
        currentPointer: path.join(longmemoryRoot, "current.txt"),
        previousBuildFile: path.join(longmemoryRoot, "previous"),
        switchMarker: path.join(longmemoryRoot, "switch-pending"),
    };
}

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lms-lm-"));

/** @param {string} buildDir @param {string} sha */
function finishBuild(buildDir, sha) {
    fs.mkdirSync(path.dirname(longMemoryCli(buildDir)), { recursive: true });
    fs.writeFileSync(longMemoryCli(buildDir), "cli");
    fs.mkdirSync(path.dirname(longMemoryStamp(buildDir)), { recursive: true });
    fs.writeFileSync(longMemoryStamp(buildDir), `${sha}\n`);
}

test("git ls-remote main is one 40-hex sha, and the plan prints twelve digits", () => {
    assert.equal(LS_REMOTE_TIMEOUT_MS, 30_000);
    assert.equal(parseLsRemoteMain(`${SHA_A}\trefs/heads/main\n`), SHA_A);
    assert.equal(parseLsRemoteMain(`${SHA_A}\trefs/heads/main\n\n`), SHA_A);
    assert.equal(shortSha(SHA_A), "a".repeat(12));
    assert.throws(() => parseLsRemoteMain(""), /exactly one/);
    assert.throws(() => parseLsRemoteMain(`${SHA_A}\trefs/heads/main\n${SHA_B}\trefs/heads/main\n`), /exactly one/);
    assert.throws(() => parseLsRemoteMain("abc\trefs/heads/main\n"), /not a commit sha/);
});

test("clone, fetch, and checkout args build one commit without moving a working tree in place", () => {
    assert.deepEqual(cloneArgs("https://github.com/CaviraOSS/LongMemory.git", "/b"), [
        "clone",
        "--depth",
        "1",
        "--branch",
        "main",
        "https://github.com/CaviraOSS/LongMemory.git",
        "/b",
    ]);
    assert.deepEqual(fetchCommitArgs("/b", SHA_A), ["-C", "/b", "fetch", "--depth", "1", "origin", SHA_A]);
    assert.deepEqual(checkoutCommitArgs("/b", SHA_A), ["-C", "/b", "checkout", "--detach", SHA_A]);
});

test("a candidate directory is created, replaced, reused, or refused when it is the running build", () => {
    const current = path.resolve("/builds", SHA_A);
    const other = path.resolve("/builds", SHA_B);
    assert.equal(buildDirPlan(other, null, "absent"), "create");
    assert.equal(buildDirPlan(other, current, "partial"), "replace");
    assert.equal(buildDirPlan(other, current, "complete"), "reuse");
    assert.equal(buildDirPlan(current, current, "complete"), "reuse-current");
    assert.equal(buildDirPlan(current, current, "partial"), "keep-current");
    assert.equal(buildDirPlan(current, current, "absent"), "keep-current");
});

test("prune keeps the current and previous shas and ignores other names", () => {
    assert.deepEqual(directoriesToRemove([SHA_A, SHA_B, SHA_C, "notes", SHA_A.slice(0, 12)], [SHA_A, SHA_C]), [SHA_B]);
    assert.deepEqual(buildsToKeep(path.join("/builds", SHA_A), path.join("/builds", SHA_B)), [SHA_A, SHA_B]);
    assert.deepEqual(buildsToKeep(path.join("/builds", SHA_A), path.join("/builds", SHA_A)), [SHA_A]);
    assert.deepEqual(buildsToKeep("/builds/not-a-sha", null), []);
    const root = temp();
    const L = tree(root);
    fs.mkdirSync(L.buildsDir, { recursive: true });
    for (const name of [SHA_A, SHA_B, SHA_C, "notes"]) fs.mkdirSync(path.join(L.buildsDir, name));
    assert.deepEqual(pruneBuilds(L.buildsDir, [SHA_A, SHA_B]), [SHA_C]);
    assert.deepEqual(fs.readdirSync(L.buildsDir).sort(), [SHA_A, SHA_B, "notes"].sort());
    fs.rmSync(root, { recursive: true, force: true });
});

test("current is a relative symlink on Linux and a pointer file on Windows", () => {
    const root = temp();
    const L = tree(root);
    const buildDir = path.join(L.buildsDir, SHA_A);
    fs.mkdirSync(buildDir, { recursive: true });
    assert.equal(currentBuildDir(L, "linux"), null);
    pointCurrentAt(buildDir, L, "linux");
    assert.equal(fs.readlinkSync(L.currentLink), path.join("builds", SHA_A));
    assert.equal(currentBuildDir(L, "linux"), buildDir);
    const win = temp();
    const W = tree(win);
    const winBuild = path.join(W.buildsDir, SHA_B);
    fs.mkdirSync(winBuild, { recursive: true });
    pointCurrentAt(winBuild, W, "win32");
    assert.equal(fs.readFileSync(W.currentPointer, "utf8"), `${winBuild}\n`);
    assert.equal(currentBuildDir(W, "win32"), winBuild);
    fs.writeFileSync(W.currentPointer, "\n");
    assert.throws(() => currentBuildDir(W, "win32"), /empty/);
    fs.unlinkSync(L.currentLink);
    fs.writeFileSync(L.currentLink, "not a link");
    assert.throws(() => currentBuildDir(L, "linux"));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(win, { recursive: true, force: true });
});

test("a stamp must name its directory, and an incomplete running build is not deleted", async () => {
    const root = temp();
    const L = tree(root);
    const buildDir = path.join(L.buildsDir, SHA_A);
    fs.mkdirSync(buildDir, { recursive: true });
    pointCurrentAt(buildDir, L, "linux");
    assert.equal(buildState(buildDir, SHA_A), "partial");
    assert.equal(runningLongMemory(L, "linux"), null);
    finishBuild(buildDir, SHA_B);
    assert.throws(() => runningLongMemory(L, "linux"), /stamped/);
    finishBuild(buildDir, "nope");
    assert.throws(() => runningLongMemory(L, "linux"), /commit sha/);
    finishBuild(buildDir, SHA_A);
    assert.equal(buildState(buildDir, SHA_A), "complete");
    assert.deepEqual(runningLongMemory(L, "linux"), { dir: buildDir, commit: SHA_A });
    fs.rmSync(longMemoryCli(buildDir));
    assert.equal(runningLongMemory(L, "linux"), null);
    fs.writeFileSync(path.join(buildDir, "keep"), "x");
    await assert.rejects(installLongMemoryCommit({
        sha: SHA_A,
        node: process.execPath,
        repo: "https://example.invalid/LongMemory.git",
        platform: "linux",
        settings: [],
        tools: [],
        deferPrune: false,
        L,
    }), /failed the build check: .*incomplete/);
    assert.equal(fs.readFileSync(path.join(buildDir, "keep"), "utf8"), "x");
    fs.rmSync(root, { recursive: true, force: true });
});

test("switch records the previous build, prune waits for finish, and rollback restores it", () => {
    const root = temp();
    const L = tree(root);
    const older = path.join(L.buildsDir, SHA_A);
    const newer = path.join(L.buildsDir, SHA_B);
    const extra = path.join(L.buildsDir, SHA_C);
    fs.mkdirSync(older, { recursive: true });
    fs.mkdirSync(newer, { recursive: true });
    fs.mkdirSync(extra, { recursive: true });
    pointCurrentAt(older, L, "linux");
    assert.equal(switchCurrentBuild(newer, L, "linux"), older);
    assert.equal(currentBuildDir(L, "linux"), newer);
    assert.equal(fs.readFileSync(L.previousBuildFile, "utf8").trim(), older);
    assert.ok(fs.existsSync(L.switchMarker));
    assert.equal(rollbackSwitch(L, "linux"), older);
    assert.equal(currentBuildDir(L, "linux"), older);
    assert.equal(fs.existsSync(L.switchMarker), false);
    switchCurrentBuild(newer, L, "linux");
    assert.deepEqual(finishSwitch(L, "linux"), [SHA_C]);
    assert.equal(fs.existsSync(extra), false);
    assert.equal(fs.existsSync(older), true);
    assert.equal(fs.existsSync(newer), true);
    assert.equal(fs.existsSync(L.switchMarker), false);
    assert.deepEqual(finishSwitch(L, "linux"), []);
    fs.rmSync(root, { recursive: true, force: true });
});

test("the memory database stays outside builds, and smoke uses port 0 and a throwaway database", () => {
    const L = layout("linux", "/home/a");
    assert.equal(path.dirname(L.dbPath), path.dirname(L.longmemoryRoot));
    assert.equal(L.dbPath.includes(`${path.sep}builds${path.sep}`), false);
    const settings = longMemorySettings({ dbPath: L.dbPath, model: "bge-m3", dimension: 1024 });
    const smoked = smokeSettings(settings, "/tmp/throwaway.db");
    assert.equal(Object.fromEntries(smoked).LONGMEMORY_PORT, "0");
    assert.equal(Object.fromEntries(smoked).LONGMEMORY_DB_PATH, "/tmp/throwaway.db");
    assert.equal(Object.fromEntries(smoked).LONGMEMORY_HOST, "127.0.0.1");
    assert.equal(Object.fromEntries(smoked).LONGMEMORY_MCP_HTTP, "true");
    const env = longMemoryChildEnv({ PATH: "/bin", LONGMEMORY_PORT: "1", LONGMEMORY_API_KEY: "k", KEEP: "1" });
    assert.equal(env.KEEP, "1");
    assert.equal(env.PATH, "/bin");
    for (const key of LONGMEMORY_ENV_KEYS) assert.equal(Object.hasOwn(env, key), false);
});

test("serve ready must be loopback /mcp, and tools/list is read from SSE or JSON", () => {
    const ready = { ok: true, command: "serve", ready: true, url: "http://127.0.0.1:43123/", mcp_url: "http://127.0.0.1:43123/mcp" };
    assert.deepEqual(acceptServeReady(ready), { port: 43123, mcpUrl: ready.mcp_url });
    assert.equal(loopbackPort(ready.url), 43123);
    assert.throws(() => acceptServeReady({ ...ready, url: "http://0.0.0.0:43123/" }), /127\.0\.0\.1/);
    assert.throws(() => acceptServeReady({ ...ready, mcp_url: "http://127.0.0.1:43123/health" }), /\/mcp/);
    assert.equal(readyFromStdout('noise\n{"ok":true}\n'), null);
    assert.equal(readyFromStdout(`${JSON.stringify(ready)}`), null);
    assert.deepEqual(readyFromStdout(`${JSON.stringify(ready)}\n`), ready);
    const message = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "longmemory_recall" }, { name: "longmemory_ingest" }] } };
    const sse = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    assert.deepEqual(jsonMessagesFromSse(sse), [message]);
    assert.deepEqual(toolNamesFromMcpHttp("text/event-stream", sse).names, ["longmemory_recall", "longmemory_ingest"]);
    assert.deepEqual(toolNamesFromMcpHttp("application/json", JSON.stringify(message)).names, ["longmemory_recall", "longmemory_ingest"]);
    const failed = toolNamesFromMcpHttp("application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "nope" } }));
    assert.deepEqual(failed.errors, ["nope"]);
    assert.deepEqual(missingToolNames(["longmemory_recall", "longmemory_ingest"], ["longmemory_recall"]), ["longmemory_ingest"]);
    assert.equal(JSON.parse(mcpToolsListBody()).method, "tools/list");
});

test("smoke checks stop the server when a check fails and name the commit", async () => {
    const commit = SHA_A;
    let stopped = 0;
    let second = 0;
    await assert.rejects(
        runSmokeChecks({
            commit,
            stop: async () => {
                stopped += 1;
            },
            checks: [
                {
                    name: "health",
                    run: async () => {
                        throw new Error("HTTP 500");
                    },
                },
                {
                    name: "tools/list",
                    run: async () => {
                        second += 1;
                    },
                },
            ],
        }),
        new RegExp(`LongMemory ${commit} failed the health check: HTTP 500`),
    );
    assert.equal(stopped, 1);
    assert.equal(second, 0);
    await runSmokeChecks({
        commit,
        stop: async () => {
            stopped += 1;
        },
        checks: [{ name: "serve", run: async () => {} }],
    });
    assert.equal(stopped, 2);
});

test("mcp tool names come from the result list only", () => {
    const parsed = mcpToolNames([{ result: { tools: [{ name: "longmemory_recall" }, { title: "x" }, "nope"] } }, { error: { message: "bad" } }]);
    assert.deepEqual(parsed.names, ["longmemory_recall"]);
    assert.deepEqual(parsed.errors, ["bad"]);
});
