import assert from "node:assert/strict";
import test from "node:test";
import { UsageError, parseArgs } from "./cli_args.mjs";
import { longMemoryHealthy, ollamaModelNames, qmdHealthy } from "./health.mjs";
import { ollamaHasModel, ollamaServicePlan } from "./ollama_plan.mjs";
import { qmdEnvironment, withEnv } from "./qmd_env.mjs";
import { nodeAtLeast } from "./platform.mjs";
import { collectionNameFor, qmdCollections } from "./qmd_state.mjs";
import { LONGMEMORY_BUILD_BYTES, MCP_ADD_TIMEOUT_MS, downloadTimeoutMs, installTimeoutMs, ollamaInstallerBytes } from "./sizes.mjs";

const MODEL = "hf:Qwen/Qwen3-Embedding-8B-GGUF/Qwen3-Embedding-8B-Q8_0.gguf";

test("QMD retrieval is always CPU; embed uses Metal on Apple, Vulkan elsewhere, CPU without a GPU; no model variable", () => {
    assert.deepEqual(qmdEnvironment({ gpu: "nvidia" }, "retrieval"), [["QMD_HOST", null], ["QMD_ALLOWED_ORIGINS", null], ["QMD_ALLOWED_HOSTS", null], ["QMD_FORCE_CPU", "1"], ["QMD_LLAMA_GPU", null]]);
    assert.deepEqual(qmdEnvironment({ gpu: "apple" }, "embed"), [["QMD_HOST", null], ["QMD_ALLOWED_ORIGINS", null], ["QMD_ALLOWED_HOSTS", null], ["QMD_FORCE_CPU", null], ["QMD_LLAMA_GPU", "metal"]]);
    assert.deepEqual(qmdEnvironment({ gpu: "other" }, "embed")[4], ["QMD_LLAMA_GPU", "vulkan"]);
    assert.deepEqual(qmdEnvironment({ gpu: "none" }, "embed"), qmdEnvironment({ gpu: "none" }, "retrieval"));
});

test("withEnv sets and unsets without touching the base object", () => {
    const base = { KEEP: "k", QMD_LLAMA_GPU: "cuda" };
    assert.deepEqual(withEnv(base, [["QMD_LLAMA_GPU", null], ["QMD_FORCE_CPU", "1"]]), { KEEP: "k", QMD_FORCE_CPU: "1" });
    assert.deepEqual(base, { KEEP: "k", QMD_LLAMA_GPU: "cuda" });
});

test("qmdCollections reads name and path from index.yml", () => {
    const yaml = [
        "global_context: notes",
        "collections:",
        "  research:",
        "    path: /home/a/research",
        '    pattern: "**/*.md"',
        "    context:",
        "      /: Research notes",
        "  notes:",
        '    path: "/home/a/my notes"',
        "models:",
        "  path: /not/a/collection",
        "",
    ].join("\n");
    assert.deepEqual(qmdCollections(yaml), [
        { name: "research", path: "/home/a/research" },
        { name: "notes", path: "/home/a/my notes" },
    ]);
});

test("collectionNameFor avoids names already taken", () => {
    assert.equal(collectionNameFor("/home/a/My Notes", []), "my-notes");
    assert.equal(collectionNameFor("/home/a/notes", ["notes", "notes-2"]), "notes-3");
    assert.equal(collectionNameFor("C:\\Users\\a\\Docs", []), "docs");
});

test("health predicates accept only each server's own answer", () => {
    assert.equal(qmdHealthy({ status: "ok", uptime: 3 }), true);
    assert.equal(qmdHealthy({ ok: true }), false);
    assert.equal(longMemoryHealthy({ data: { ok: true }, meta: {} }), true);
    assert.equal(longMemoryHealthy({ data: { ok: false } }), false);
    // The older HSG OpenMemory server on :8080 answers {"ok":true,...}; it is not LongMemory.
    assert.equal(longMemoryHealthy({ ok: true, version: "2.0-hsg-tiered" }), false);
    assert.deepEqual(ollamaModelNames({ models: [{ name: "bge-m3:latest" }, { size: 1 }] }), ["bge-m3:latest"]);
    assert.equal(ollamaModelNames({ status: "ok" }), null);
    assert.equal(ollamaModelNames(null), null);
});

test("Ollama has one owner; brew services wins over the app, and the system unit wins on Linux", () => {
    assert.deepEqual(ollamaServicePlan({ platform: "linux", systemUnitLoaded: true }), { owner: "system-unit" });
    assert.deepEqual(ollamaServicePlan({ platform: "linux", systemUnitLoaded: false }), { owner: "skill" });
    assert.equal(ollamaServicePlan({ platform: "darwin", ollamaApp: true, brewService: true }).owner, "external");
    assert.match(/** @type {{ by: string }} */ (ollamaServicePlan({ platform: "darwin", ollamaApp: true, brewService: true })).by, /brew services/);
    assert.deepEqual(ollamaServicePlan({ platform: "darwin", ollamaApp: false, brewService: false }), { owner: "skill" });
    assert.equal(ollamaServicePlan({ platform: "win32", ollamaApp: true }).owner, "external");
    assert.deepEqual(ollamaServicePlan({ platform: "win32", ollamaApp: false }), { owner: "skill" });
});

test("ollamaHasModel matches untagged names against :latest", () => {
    assert.equal(ollamaHasModel(["bge-m3:latest"], "bge-m3"), true);
    assert.equal(ollamaHasModel(["bge-m3:567m"], "bge-m3"), false);
    assert.equal(ollamaHasModel(["bge-m3:567m"], "bge-m3:567m"), true);
});



test("command line: one mode, apply needs exactly one input", () => {
    assert.deepEqual(parseArgs([]), { mode: "--check", yes: false, choicesFile: undefined });
    assert.deepEqual(parseArgs(["--plan"]), { mode: "--plan", yes: false, choicesFile: undefined });
    assert.deepEqual(parseArgs(["--apply", "--yes"]), { mode: "--apply", yes: true, choicesFile: undefined });
    assert.deepEqual(parseArgs(["--apply", "--choices", "c.json"]), { mode: "--apply", yes: false, choicesFile: "c.json" });
    assert.deepEqual(parseArgs(["--update"]), { mode: "--update", yes: false, choicesFile: undefined });
    for (const bad of [["--apply"], ["--apply", "--yes", "--choices", "c.json"], ["--plan", "--apply"], ["--plan", "--yes"], ["--apply", "--choices"], ["--apply", "--choices", "--yes"], ["--frobnicate"], ["--check", "--update"], ["--update", "--yes"], ["--update", "--choices", "c.json"]]) {
        assert.throws(() => parseArgs(bad), UsageError, bad.join(" "));
    }
    assert.throws(() => parseArgs(["--plan", "--update"]), /Use one of --plan, --apply, --check, --update/);
    assert.throws(() => parseArgs(["--update", "--yes"]), /--yes and --choices only go with --apply/);
});

test("install time limits grow with the download and leave room to build", () => {
    // 10 minutes plus one second per MB, then twenty minutes more for builds.
    assert.equal(downloadTimeoutMs(0), 600_000);
    assert.equal(installTimeoutMs(0), 1_800_000);
    assert.equal(installTimeoutMs(LONGMEMORY_BUILD_BYTES), 1_800_000 + Math.ceil(LONGMEMORY_BUILD_BYTES / 1_000_000) * 1000);
    // Ollama's Linux release (1.4 GB) gets over half an hour of download time.
    assert.ok(downloadTimeoutMs(ollamaInstallerBytes("linux", "x64")) > 30 * 60_000);
    assert.equal(MCP_ADD_TIMEOUT_MS, 120_000);
});

test("nodeAtLeast compares major, then minor", () => {
    const min = { major: 22, minor: 15 };
    assert.equal(nodeAtLeast("22.15.0", min), true);
    assert.equal(nodeAtLeast("22.14.9", min), false);
    assert.equal(nodeAtLeast("22.22.1", min), true);
    assert.equal(nodeAtLeast("23.0.0", min), true);
    assert.equal(nodeAtLeast("20.19.0", min), false);
});
