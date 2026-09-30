import assert from "node:assert/strict";
import test from "node:test";
import { NeedsAdmin, StepFailed, runApply } from "./apply_loop.mjs";
import { run } from "./proc.mjs";
import { planActions } from "./plan.mjs";

const GIB = 1024 * 1024 * 1024;

/** Installed and running, linger off, no password-free sudo; Claude not connected, a folder not indexed. */
function facts() {
    const off = { installed: false, qmd: false, longmemory: false };
    return /** @type {import("./plan.mjs").Facts} */ ({
        platform: "linux",
        arch: "x64",
        nodeVersion: "22.22.1",
        username: "ana",
        hardware: { ramBytes: 16 * GIB, vramBytes: 0, gpu: "none" },
        disk: [],
        sudoNonInteractive: false,
        lingerEnabled: false,
        brewAvailable: false,
        agents: { claude: { installed: true, qmd: false, longmemory: false }, codex: off, grok: off, opencode: off },
        qmd: {
            version: "2.5.3",
            healthy: true,
            cachedModels: [
                "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
                "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
                "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf",
            ],
            collectionPaths: [],
            configModels: { embed: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf" },
        },
        longmemory: { built: true, healthy: true, envFile: true, envModel: "bge-m3", dbExists: true },
        ollama: { installed: true, healthy: true, models: ["bge-m3:latest"], systemUnit: { loaded: true, enabled: true, active: true }, ollamaApp: false, brewService: false },
        services: { qmd: true, longmemory: true, ollama: false },
        settingsWritten: true,
        saved: null,
        notesDir: null,
    });
}
const choices = { schemaVersion: 1, modelTier: /** @type {const} */ ("medium"), agents: /** @type {"claude"[]} */ (["claude"]), bootMode: /** @type {const} */ ("boot"), qmdFolders: ["/home/ana/notes"] };

/** Fake executors: record order, and let the boot step need admin as it does without linger rights. */
function harness(overrides = {}) {
    const executed = [];
    let persisted = 0;
    const pending = planActions(facts(), choices).filter((entry) => !entry.alreadyDone);
    return {
        executed,
        persistedCount: () => persisted,
        pending,
        steps: {
            pending,
            execute: async (entry) => {
                if (overrides[entry.id]) return overrides[entry.id]();
                if (entry.id === "enable-boot-start") throw new NeedsAdmin("linger needs admin", ["sudo loginctl enable-linger ana"]);
                executed.push(entry.id);
            },
            remainingAfter: async () => [{ id: "enable-boot-start", problem: "Start-at-boot (systemd linger) is off." }],
            persist: () => {
                persisted += 1;
            },
        },
    };
}

test("an admin-only start-at-boot step does not stop connecting agents or indexing folders", async () => {
    const h = harness();
    assert.deepEqual(
        h.pending.filter((entry) => entry.needsAdmin).map((entry) => entry.id),
        ["enable-boot-start"],
    );
    const deferred = await runApply(h.steps);
    assert.deepEqual(h.executed, ["connect-claude", "instructions-claude", "index-folders"]);
    assert.equal(deferred.length, 1);
    assert.deepEqual(deferred[0].commands, ["sudo loginctl enable-linger ana"]);
    // Everything else works, so the choices are saved and --check reports only the boot step.
    assert.equal(h.persistedCount(), 1);
});

test("NeedsAdmin from any other step stops apply, and nothing is saved", async () => {
    const h = harness({
        "connect-claude": async () => {
            throw new NeedsAdmin("not deferrable", ["x"]);
        },
    });
    await assert.rejects(runApply(h.steps), (error) => error instanceof NeedsAdmin && error.message === "not deferrable");
    assert.deepEqual(h.executed, []);
    assert.equal(h.persistedCount(), 0);
});

test("a failing step stops apply before the choices are saved", async () => {
    const h = harness({
        "connect-claude": async () => {
            throw new Error("network down");
        },
    });
    await assert.rejects(runApply(h.steps), /network down/);
    assert.equal(h.persistedCount(), 0);
});

test("problems left after the run, other than a deferred step, fail apply without saving", async () => {
    const h = harness();
    const steps = { ...h.steps, remainingAfter: async () => [{ id: "start-qmd", problem: "QMD's search server is not running." }] };
    await assert.rejects(runApply(steps), /QMD's search server is not running/);
    assert.equal(h.persistedCount(), 0);
});

test("a clean run saves once and defers nothing", async () => {
    const h = harness({ "enable-boot-start": async () => {} });
    const deferred = await runApply({ ...h.steps, remainingAfter: async () => [] });
    assert.deepEqual(deferred, []);
    assert.equal(h.persistedCount(), 1);
});

test("a failed step names itself, keeps the command's own message, and says how to retry", async () => {
    const h = harness({
        "connect-claude": async () => {
            throw new Error("claude mcp add qmd did not finish within 2 min and was stopped.");
        },
    });
    await assert.rejects(runApply(h.steps), (error) => {
        assert.ok(error instanceof StepFailed);
        assert.equal(error.id, "connect-claude");
        assert.equal(
            error.message,
            "Step connect-claude failed: claude mcp add qmd did not finish within 2 min and was stopped. Fix the cause, then run the same --apply command again to retry; finished steps are skipped.",
        );
        return true;
    });
    assert.equal(h.persistedCount(), 0);
});

test("a command that runs past its time limit fails with the command and the limit, not a bare ETIMEDOUT", { skip: process.platform === "win32" }, () => {
    assert.throws(() => run("/bin/sleep", ["5"], { timeoutMs: 1000 }), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "/bin/sleep 5 did not finish within 1 s and was stopped.");
        return true;
    });
});
