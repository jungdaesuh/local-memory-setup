import assert from "node:assert/strict";
import test from "node:test";
import { layout } from "./layout.mjs";
import { memoryClientSpecs, memoryProcessSpec } from "./mcp_runtime.mjs";

const L = layout("linux", "/home/a", {});
const runtime = { node: "/usr/bin/node", modules: "127", qmdEntry: "/qmd/bin/qmd", paths: L };

test("memory transports use native stdio despite hostile inherited network settings", () => {
    const hostile = { node_options: "--require=/foreign", qmd_host: "0.0.0.0", longmemory_mcp_http: "true", QMD_HOST: "0.0.0.0", QMD_ALLOWED_ORIGINS: "*", QMD_CONFIG_DIR: "/foreign", INDEX_PATH: "/foreign.db", LONGMEMORY_HOST: "0.0.0.0", LONGMEMORY_MCP_HTTP: "true", LONGMEMORY_OLLAMA_URL: "https://foreign.invalid", OM_DB_PATH: "/foreign.db", NODE_OPTIONS: "--require=/foreign", PATH: "/bin", KEEP: "yes" };
    const qmd = memoryProcessSpec(runtime, "qmd", {}, hostile);
    assert.deepEqual(qmd.args, [runtime.qmdEntry, "--index", "index", "mcp"]);
    assert.equal(qmd.env.QMD_HOST, undefined);
    assert.equal(qmd.env.QMD_ALLOWED_ORIGINS, undefined);
    assert.equal(qmd.env.INDEX_PATH, L.qmdIndexDb);
    const memory = memoryProcessSpec(runtime, "longmemory", { LONGMEMORY_OLLAMA_EMBEDDING_MODEL: "bge-m3" }, hostile);
    assert.deepEqual(memory.args, [`${L.currentLink}/longmemory_stdio.mjs`, L.dbPath]);
    assert.equal(memory.env.LONGMEMORY_MCP_HTTP, "false");
    assert.equal(memory.env.LONGMEMORY_OLLAMA_URL, "http://127.0.0.1:11434");
    assert.equal(memory.env.OM_DB_PATH, undefined);
    for (const spec of [qmd, memory]) {
        assert.equal(spec.env.NODE_OPTIONS, undefined);
        assert.equal(spec.env.node_options, undefined);
        assert.equal(spec.env.qmd_host, undefined);
        assert.equal(spec.env.longmemory_mcp_http, undefined);
        assert.equal(spec.env.KEEP, "yes");
        assert.equal(spec.cwd, L.home);
    }
});

test("all clients use one launcher without credentials or shared URLs", () => {
    const specs = memoryClientSpecs(L, runtime.node);
    assert.deepEqual(specs.map((spec) => spec.name), ["qmd", "longmemory"]);
    for (const spec of specs) {
        assert.equal(spec.command, runtime.node);
        assert.deepEqual(spec.args, [`${L.gateDir}/mcp_launch.mjs`, spec.name, L.runtimePath]);
    }
});
