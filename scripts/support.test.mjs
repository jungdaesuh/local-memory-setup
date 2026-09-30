import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { freeBytesAt } from "./detect.mjs";
import { longMemoryGateReady } from "./health.mjs";
import { OLLAMA_ORIGIN, layout } from "./layout.mjs";
import { LONGMEMORY_ENV_KEYS, longMemorySettings, parseEnvFile, renderEnvFile } from "./longmemory_env.mjs";
import { waitFor } from "./proc.mjs";
import { runnerScript } from "./service_files.mjs";
import { longMemoryRunnerText } from "./service_specs.mjs";

test("the LongMemory settings pin 127.0.0.1, carry no key, and hold only variables serve reads", () => {
    const settings = Object.fromEntries(longMemorySettings({ dbPath: "/d/lm.db", model: "bge-m3", dimension: 1024 }));
    assert.equal(settings.LONGMEMORY_HOST, "127.0.0.1");
    assert.equal(settings.LONGMEMORY_OLLAMA_URL, OLLAMA_ORIGIN);
    assert.equal(settings.LONGMEMORY_EMBEDDING_DIMENSION, "1024");
    assert.ok(!("LONGMEMORY_PROJECT_ID" in settings) && !("LONGMEMORY_USER_ID" in settings));
    assert.ok(!("LONGMEMORY_API_KEY" in settings) && !("OM_API_KEY" in settings));
    // The runner unsets every file variable and both key variables.
    assert.deepEqual(LONGMEMORY_ENV_KEYS, [...Object.keys(settings), "LONGMEMORY_API_KEY", "OM_API_KEY"]);
    const text = renderEnvFile(Object.entries(settings));
    assert.deepEqual(parseEnvFile(text), settings);
    assert.throws(() => renderEnvFile([["LONGMEMORY_DB_PATH", "a\nb"]]), /line break/);
});

test("the LongMemory runner unsets inherited settings, so the env file wins", { skip: process.platform === "win32" }, () => {
    const text = longMemoryRunnerText({ node: "/usr/bin/node", L: layout("linux", "/home/a"), model: "bge-m3", platform: "linux" });
    for (const key of LONGMEMORY_ENV_KEYS) assert.match(text, new RegExp(`^unset ${key}$`, "m"));
    assert.match(text, /'http:\/\/127\.0\.0\.1:11434\/api\/tags' 'bge-m3' '120' \|\| exit 1/);
    // Run the same shape: inherited settings, a host, or a key from the service manager must not reach the server.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-runner-"));
    const script = path.join(dir, "r.sh");
    fs.writeFileSync(script, runnerScript({ env: LONGMEMORY_ENV_KEYS.map((key) => [key, null]), pathPrepend: null, gate: null, argv: ["/usr/bin/env"] }, "linux"));
    const inherited = { PATH: process.env.PATH, LONGMEMORY_PORT: "9999", LONGMEMORY_HOST: "0.0.0.0", LONGMEMORY_API_KEY: "k", OM_API_KEY: "k", KEEP: "1" };
    const out = spawnSync("/bin/sh", [script], { encoding: "utf8", env: inherited });
    for (const name of ["LONGMEMORY_PORT", "LONGMEMORY_HOST", "LONGMEMORY_API_KEY", "OM_API_KEY"]) assert.doesNotMatch(out.stdout, new RegExp(`^${name}=`, "m"));
    assert.match(out.stdout, /^KEEP=1$/m);
});

test("the Ollama gate waits for the model, not only for the port", () => {
    assert.equal(longMemoryGateReady({ models: [{ name: "bge-m3:latest" }] }, "bge-m3"), true);
    assert.equal(longMemoryGateReady({ models: [] }, "bge-m3"), false);
    assert.equal(longMemoryGateReady(null, "bge-m3"), false);
});

test("freeBytesAt walks up to an existing folder and stops at the root", () => {
    const result = freeBytesAt(path.join(os.tmpdir(), "no", "such", "folder"));
    assert.ok(result.freeBytes > 0);
});

test("waitFor keeps to its deadline, probe time included", async () => {
    const started = Date.now();
    const slowProbe = async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return false;
    };
    await assert.rejects(waitFor("thing", slowProbe, 0.5, 100), /thing did not become healthy within 0\.5 s/);
    assert.ok(Date.now() - started < 1200, `took ${Date.now() - started} ms`);
    let calls = 0;
    await waitFor("thing", async () => ++calls >= 3, 5, 10);
    assert.equal(calls, 3);
});
