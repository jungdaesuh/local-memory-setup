import assert from "node:assert/strict";
import test from "node:test";
import { appendSections, sectionExists } from "./mcp_config.mjs";
import { chooseModels } from "./model_choice.mjs";

const GB = 1024 * 1024 * 1024;

test("small CPU machines get the smallest models", () => {
    const choice = chooseModels({ ramBytes: 7 * GB, vramBytes: 0, gpu: "none" });
    assert.equal(choice.qmd.id, "embeddinggemma-300M-Q8_0");
    assert.equal(choice.qmd.env, null);
    assert.equal(choice.longmemory.model, "nomic-embed-text");
    assert.equal(choice.longmemory.dimension, 768);
    assert.equal(choice.gpuEmbed, false);
});

test("ordinary machines get the small multilingual pair", () => {
    const choice = chooseModels({ ramBytes: 16 * GB, vramBytes: 8 * GB, gpu: "nvidia" });
    assert.equal(choice.qmd.id, "Qwen3-Embedding-0.6B-Q8_0");
    assert.equal(choice.longmemory.model, "bge-m3");
    assert.equal(choice.longmemory.dimension, 1024);
    assert.equal(choice.gpuEmbed, true);
});

test("large machines may use Qwen3-Embedding-8B for QMD", () => {
    const choice = chooseModels({ ramBytes: 64 * GB, vramBytes: 24 * GB, gpu: "nvidia" });
    assert.equal(choice.qmd.id, "Qwen3-Embedding-8B-Q8_0");
    assert.match(choice.qmd.env, /Qwen3-Embedding-8B-Q8_0/);
});

test("MCP sections append once and keep existing text", () => {
    const original = "existing = true\n\n[mcp_servers.qmd]\nurl = \"http://example\"\n";
    const once = appendSections(original, [
        { header: "mcp_servers.qmd", body: "url = \"http://127.0.0.1:8181/mcp\"\n" },
        { header: "mcp_servers.longmemory", body: "url = \"http://127.0.0.1:7331/mcp\"\n" },
    ]);
    const twice = appendSections(once, [
        { header: "mcp_servers.longmemory", body: "url = \"http://127.0.0.1:7331/mcp\"\n" },
    ]);
    assert.equal(twice, once);
    assert.match(once, /existing = true/);
    assert.match(once, /url = "http:\/\/example"/);
    assert.equal(sectionExists(once, "mcp_servers.longmemory"), true);
});
