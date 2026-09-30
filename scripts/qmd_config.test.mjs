/**
 * QMD's own model resolution against what this setup reads and writes in index.yml.
 * Runs QMD's real dist/collections.js loadConfig and dist/llm.js resolveModels in a
 * child process (QMD_CONFIG_DIR points it at a temporary index.yml). Skipped when QMD
 * is not installed under ~/.local.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { layout } from "./layout.mjs";
import { QMD_DEFAULT_MODELS } from "./model_choice.mjs";
import { qmdConfiguredModels, withQmdModels } from "./qmd_state.mjs";

const QMD_DIST = path.join(layout().qmdPackage, "dist");
const skip = !fs.existsSync(path.join(QMD_DIST, "llm.js")) && "QMD is not installed under ~/.local";
const QWEN06 = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
const QWEN8 = "hf:Qwen/Qwen3-Embedding-8B-GGUF/Qwen3-Embedding-8B-Q8_0.gguf";

/**
 * @param {string | null} yaml index.yml contents, or null for no file
 * @param {Record<string, string>} env
 */
function qmdResolves(yaml, env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-qmdcfg-"));
    if (yaml !== null) fs.writeFileSync(path.join(dir, "index.yml"), yaml);
    const code = [
        `import { loadConfig } from ${JSON.stringify(path.join(QMD_DIST, "collections.js"))};`,
        `import { resolveModels } from ${JSON.stringify(path.join(QMD_DIST, "llm.js"))};`,
        "process.stdout.write(JSON.stringify(resolveModels(loadConfig().models)));",
    ].join("\n");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env, QMD_CONFIG_DIR: dir }, encoding: "utf8" });
    fs.rmSync(dir, { recursive: true });
    return JSON.parse(out);
}

test("the models block this setup writes is what QMD resolves, even against a stray QMD_EMBED_MODEL", { skip }, () => {
    const models = { embed: QWEN06, generate: QMD_DEFAULT_MODELS.generate, rerank: QMD_DEFAULT_MODELS.rerank };
    const yaml = withQmdModels("collections:\n  notes:\n    path: /home/a/notes\n", models);
    assert.deepEqual(qmdResolves(yaml, { QMD_EMBED_MODEL: QWEN8 }), models);
    assert.deepEqual(qmdConfiguredModels(yaml), models);
});

test("an existing models block wins over the environment, so it is the source of truth", { skip }, () => {
    const yaml = `collections: {}\nmodels:\n  embed: ${QWEN8}\n`;
    assert.equal(qmdResolves(yaml, { QMD_EMBED_MODEL: QWEN06 }).embed, QWEN8);
    assert.deepEqual(qmdConfiguredModels(yaml), { embed: QWEN8 });
});

test("with no index.yml QMD falls back to the defaults this setup assumes", { skip }, () => {
    assert.deepEqual(qmdResolves(null), QMD_DEFAULT_MODELS);
    assert.equal(qmdConfiguredModels(""), null);
});

test("withQmdModels refuses to touch an existing models block", () => {
    assert.throws(() => withQmdModels(`models:\n  embed: ${QWEN8}\n`, { embed: QWEN06, generate: "g", rerank: "r" }), /already has a models block/);
    assert.equal(withQmdModels("", { embed: "e", generate: "g", rerank: "r" }), "models:\n  embed: e\n  generate: g\n  rerank: r\n");
    assert.equal(withQmdModels("collections: {}", { embed: "e", generate: "g", rerank: "r" }), "collections: {}\nmodels:\n  embed: e\n  generate: g\n  rerank: r\n");
});
