/**
 * Executor steps and state reads: Ollama start decisions and the API pull against a local
 * server, native-module rebuilds and ABI, QMD's run environment and model cache names,
 * the index.yml writer, the recorded-Node rule, and read-only SQLite (memory count, QMD
 * index). Nothing here touches ~/.cache/qmd, the user's index.yml, or a live service.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectionsNeedingEmbedding, countMemories, setupNode } from "./detect.mjs";
import { nativeModuleAbi, nativeModuleFile, ollamaStartStep, rebuildCommand } from "./executor_steps.mjs";
import { layout } from "./layout.mjs";
import { pullModelViaApi } from "./ollama_api.mjs";
import { QMD_GLOBAL_INDEX_ARGS, qmdProcessEnv } from "./qmd_env.mjs";
import { qmdConfiguredModels, qmdModelCacheFile, writeQmdModelsIfAbsent } from "./qmd_state.mjs";

const GEMMA = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const RERANK = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A local stand-in for Ollama's POST /api/pull. */
async function withServer(handler, body) {
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => handler(JSON.parse(raw), res));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const address = /** @type {import("node:net").AddressInfo} */ (server.address());
    try {
        return await body(`http://127.0.0.1:${address.port}/api/pull`);
    } finally {
        server.closeAllConnections();
        server.close();
    }
}

test("the Ollama API pull streams, reports progress, and finishes on success", async () => {
    const seen = [];
    let request = null;
    await withServer(
        (payload, res) => {
            request = payload;
            res.writeHead(200, { "content-type": "application/x-ndjson" });
            res.write('{"status":"pulling manifest"}\n{"status":"pulling abc","total":10,"completed":5}\n');
            setTimeout(() => res.end('{"status":"verifying sha256 digest"}\n{"status":"success"}\n'), 50);
        },
        (url) => pullModelViaApi(url, "bge-m3", { timeoutMs: 10_000, onStatus: (status) => seen.push(status) }),
    );
    assert.deepEqual(request, { model: "bge-m3", stream: true });
    assert.deepEqual(seen, ["pulling manifest", "pulling abc", "verifying sha256 digest", "success"]);
});

test("the Ollama API pull fails on an error line, a non-OK status, and a stream that stops early", async () => {
    await withServer(
        (_payload, res) => {
            res.writeHead(200);
            res.end('{"status":"pulling manifest"}\n{"error":"pull model manifest: file does not exist"}\n');
        },
        (url) => assert.rejects(pullModelViaApi(url, "nope", { timeoutMs: 10_000 }), /could not pull nope: pull model manifest/),
    );
    await withServer(
        (_payload, res) => {
            res.writeHead(500);
            res.end("internal error, not JSON");
        },
        (url) => assert.rejects(pullModelViaApi(url, "bge-m3", { timeoutMs: 10_000 }), /HTTP 500\): internal error, not JSON/),
    );
    await withServer(
        (_payload, res) => {
            res.writeHead(200);
            res.end('{"status":"pulling manifest"}');
        },
        (url) => assert.rejects(pullModelViaApi(url, "bge-m3", { timeoutMs: 10_000 }), /ended without success \(last status: pulling manifest\)/),
    );
});

test("set-search-model writes the models block only into an index.yml that has none", () => {
    const dir = tempDir("lms-idx-");
    const file = path.join(dir, "qmd", "index.yml");
    const models = { embed: GEMMA, generate: "g", rerank: RERANK };
    assert.equal(writeQmdModelsIfAbsent(file, models), true);
    assert.deepEqual(qmdConfiguredModels(fs.readFileSync(file, "utf8")), models);
    fs.writeFileSync(file, "collections: {}\nmodels:\n  embed: hf:someone/else/x.gguf\n");
    assert.equal(writeQmdModelsIfAbsent(file, models), false);
    assert.equal(fs.readFileSync(file, "utf8"), "collections: {}\nmodels:\n  embed: hf:someone/else/x.gguf\n");
    fs.rmSync(dir, { recursive: true });
});

test("the recorded Node decides whether scripts are current, not the Node running --check", { skip: process.platform === "win32" }, () => {
    const home = tempDir("lms-node-");
    const L = layout(process.platform, home);
    const self = { applyNode: process.execPath, applyAbi: process.versions.modules, applyVersion: process.versions.node };
    assert.deepEqual(setupNode(L), { node: process.execPath, usable: true, ...self });
    fs.mkdirSync(path.dirname(L.runtimePath), { recursive: true });
    // A different Node binary with the same ABI (a wrapper around this one) is usable, and apply keeps using it.
    const other = path.join(home, "other-node");
    fs.writeFileSync(other, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(L.runtimePath, JSON.stringify({ node: other, modules: process.versions.modules }));
    assert.deepEqual(setupNode(L), { node: other, usable: true, applyNode: other, applyAbi: process.versions.modules, applyVersion: process.versions.node });
    // The recorded Node's own version decides whether it can build, not this process's.
    const older = path.join(home, "older-node");
    fs.writeFileSync(older, `#!/bin/sh\necho "${process.versions.modules} 22.12.0"\n`, { mode: 0o755 });
    fs.writeFileSync(L.runtimePath, JSON.stringify({ node: older, modules: process.versions.modules }));
    assert.equal(setupNode(L).applyVersion, "22.12.0");
    // The ABI changed under the same path, or the Node is gone: every script is out of date, and apply uses this Node.
    fs.writeFileSync(L.runtimePath, JSON.stringify({ node: other, modules: "1" }));
    assert.deepEqual(setupNode(L), { node: other, usable: false, ...self });
    fs.writeFileSync(L.runtimePath, JSON.stringify({ node: path.join(home, "gone"), modules: process.versions.modules }));
    assert.equal(setupNode(L).usable, false);
    fs.rmSync(home, { recursive: true });
});

test("stored memories are counted read-only from LongMemory's hydro_nodes table", () => {
    const dir = tempDir("lms-db-");
    const db = path.join(dir, "longmemory.db");
    const make = [
        'import { DatabaseSync } from "node:sqlite";',
        "const db = new DatabaseSync(process.argv[1]);",
        'db.exec("CREATE TABLE hydro_nodes (node_id TEXT); INSERT INTO hydro_nodes VALUES (\'a\'), (\'b\');");',
    ].join("\n");
    assert.equal(spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", make, db]).status, 0);
    assert.equal(countMemories(db), 2);
    fs.writeFileSync(path.join(dir, "not-a-db"), "text");
    assert.equal(countMemories(path.join(dir, "not-a-db")), null);
    fs.rmSync(dir, { recursive: true });
});

/* ------------------------------------------------------------ executor decisions */

test("start-ollama leaves a foreign server alone and re-registers the setup's own, stale or not", () => {
    const base = { platform: /** @type {const} */ ("darwin"), unit: { enabled: false, active: false }, brewService: false };
    assert.equal(ollamaStartStep({ ...base, owner: "skill", up: true, own: false }), "leave");
    assert.equal(ollamaStartStep({ ...base, owner: "skill", up: true, own: true }), "register-own");
    assert.equal(ollamaStartStep({ ...base, owner: "skill", up: false, own: false }), "register-own");
    assert.equal(ollamaStartStep({ ...base, owner: "external", up: false, own: false, brewService: true }), "brew-services-start");
    assert.equal(ollamaStartStep({ ...base, owner: "external", up: false, own: false }), "open-app");
    assert.equal(ollamaStartStep({ ...base, platform: "win32", owner: "external", up: false, own: false }), "launch-windows-app");
    assert.equal(ollamaStartStep({ ...base, platform: "linux", owner: "system-unit", up: true, own: false, unit: { enabled: false, active: false } }), "leave");
    assert.equal(ollamaStartStep({ ...base, platform: "linux", owner: "system-unit", up: false, own: false, unit: { enabled: false, active: false } }), "enable-system-unit");
    assert.equal(ollamaStartStep({ ...base, platform: "linux", owner: "system-unit", up: true, own: false, unit: { enabled: true, active: true } }), "leave");
});

test("native modules are rebuilt for the setup's Node, with its directory first on PATH", () => {
    const L = { qmdPackage: "/h/.local/lib/node_modules/@tobilu/qmd", sourceDir: "/h/.local/share/local-memory-setup/LongMemory" };
    const spec = { L, nodeBin: "/opt/node22/bin/node", npm: "/opt/node22/bin/npm", pathEnv: "/usr/bin:/bin", delimiter: ":" };
    assert.deepEqual(rebuildCommand("qmd", spec), { command: "/opt/node22/bin/npm", args: ["rebuild"], cwd: L.qmdPackage, pathEnv: "/opt/node22/bin:/usr/bin:/bin" });
    assert.deepEqual(rebuildCommand("longmemory", spec), { command: "/opt/node22/bin/npm", args: ["rebuild"], cwd: L.sourceDir, pathEnv: "/opt/node22/bin:/usr/bin:/bin" });
    assert.equal(nativeModuleFile("qmd", { ...L, qmdRoot: "/reviewed" }), path.join("/reviewed", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"));
    assert.equal(nativeModuleFile("qmd", L), path.join(L.qmdPackage, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"));
});

test("the native ABI is read from a module's node_register_module export", () => {
    assert.equal(nativeModuleAbi(Buffer.from("\0junk node_register_module_v127\0more")), "127");
    assert.equal(nativeModuleAbi(Buffer.from("\0node_register_module_v137\0")), "137");
    assert.equal(nativeModuleAbi(Buffer.from("napi_register_module_v1")), null);
});

test("QMD commands run with the setup's Node first on PATH and pinned to the global index", { skip: process.platform === "win32" }, () => {
    const root = tempDir("lms-qmdenv-");
    const other = path.join(root, "other-bin");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "node"), "#!/bin/sh\necho other\n", { mode: 0o755 });
    const setupNodeDir = path.join(root, "setup-node", "bin");
    fs.mkdirSync(setupNodeDir, { recursive: true });
    fs.writeFileSync(path.join(setupNodeDir, "node"), "#!/bin/sh\necho setup\n", { mode: 0o755 });
    // The shell's PATH puts another node first (an nvm switch, say); the launcher re-spawns `node` from PATH.
    const env = qmdProcessEnv({ PATH: `${other}:/usr/bin:/bin` }, { node: path.join(setupNodeDir, "node"), gpu: "none", mode: "retrieval", delimiter: ":" });
    assert.equal(execFileSync("/bin/sh", ["-c", "node"], { env, encoding: "utf8" }).trim(), "setup");
    assert.equal(env.QMD_FORCE_CPU, "1");
    assert.deepEqual([...QMD_GLOBAL_INDEX_ARGS], ["--index", "index"]);
});

/* ------------------------------------------------------------ QMD model cache names */

test("the cache file name matches node-llama-cpp's parseModelUri for plain hf: URIs, and unknown forms are null", () => {
    assert.equal(qmdModelCacheFile("hf:Qwen/Qwen3-Embedding-8B-GGUF/Qwen3-Embedding-8B-Q8_0.gguf"), "hf_Qwen_Qwen3-Embedding-8B-Q8_0.gguf");
    assert.equal(qmdModelCacheFile("hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf"), "hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf");
    assert.equal(qmdModelCacheFile("hf:second-state/All-MiniLM-L6-v2-Embedding-GGUF/all-MiniLM-L6-v2-Q8_0.gguf"), "hf_second-state_All-MiniLM-L6-v2-Embedding-GGUF_all-MiniLM-L6-v2-Q8_0.gguf");
    assert.equal(qmdModelCacheFile("hf:ggml-org/embeddinggemma-300M-GGUF:Q8_0"), null);
    assert.equal(qmdModelCacheFile("hf:u/r-GGUF/sub/file.gguf"), null);
    assert.equal(qmdModelCacheFile("/local/model.gguf"), null);
});

const PARSE_MODEL_URI = path.join(layout().qmdPackage, "node_modules", "node-llama-cpp", "dist", "utils", "parseModelUri.js");
test("the cache names agree with the installed node-llama-cpp", { skip: !fs.existsSync(PARSE_MODEL_URI) && "node-llama-cpp is not installed with QMD" }, () => {
    const uris = [
        "hf:Qwen/Qwen3-Embedding-8B-GGUF/Qwen3-Embedding-8B-Q8_0.gguf",
        "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
        "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf",
        "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
        "hf:second-state/All-MiniLM-L6-v2-Embedding-GGUF/all-MiniLM-L6-v2-Q8_0.gguf",
    ];
    const code = `import { parseModelUri } from ${JSON.stringify(PARSE_MODEL_URI)}; process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map((uri) => parseModelUri(uri).fullFilename)));`;
    const upstream = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(uris)], { encoding: "utf8" }));
    assert.deepEqual(uris.map(qmdModelCacheFile), upstream);
});

/* ------------------------------------------------------------ read-only SQLite */

/** @param {string} db @param {string} sql */
function makeWalDb(db, sql) {
    const script = ['import { DatabaseSync } from "node:sqlite";', "const db = new DatabaseSync(process.argv[1]);", "db.exec(process.argv[2]);", "db.close();"].join("\n");
    assert.equal(spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script, db, `PRAGMA journal_mode=WAL; ${sql}`]).status, 0);
}

const QMD_TABLES = "CREATE TABLE documents (id INTEGER PRIMARY KEY, collection TEXT, path TEXT, title TEXT, hash TEXT, created_at TEXT, modified_at TEXT, active INTEGER DEFAULT 1);";
const DOCS =
    "INSERT INTO documents (collection, path, title, hash, created_at, modified_at) VALUES ('notes','a.md','a','h1','',''), ('notes','b.md','b','h2','',''), ('docs','c.md','c','h3','',''), ('old','d.md','d','h4','','');";

test("reading a closed WAL database works on this Node and creates no -shm or -wal file", () => {
    const dir = tempDir("lms-wal-");
    const db = path.join(dir, "longmemory.db");
    makeWalDb(db, "CREATE TABLE hydro_nodes (node_id TEXT); INSERT INTO hydro_nodes VALUES ('a'), ('b'), ('c');");
    assert.deepEqual(fs.readdirSync(dir), ["longmemory.db"]);
    // Non-null proves the immutable URI open works on the executing Node (22.15+ official builds).
    assert.equal(countMemories(db), 3);
    assert.deepEqual(fs.readdirSync(dir), ["longmemory.db"]);
});

test("collections with documents lacking vectors are found from QMD's index, read-only", () => {
    const dir = tempDir("lms-qmdidx-");
    const db = path.join(dir, "index.sqlite");
    makeWalDb(
        db,
        [
            QMD_TABLES,
            "CREATE TABLE content_vectors (hash TEXT, seq INTEGER, pos INTEGER, model TEXT, embed_fingerprint TEXT DEFAULT '', total_chunks INTEGER DEFAULT 1, embedded_at TEXT, PRIMARY KEY (hash, seq));",
            DOCS,
            "INSERT INTO content_vectors VALUES ('h1',0,0,'m','',1,''), ('h3',0,0,'m','',2,''), ('h4',0,0,'m','',1,'');",
        ].join(" "),
    );
    assert.deepEqual(collectionsNeedingEmbedding(db, ["notes", "docs", "old"])?.sort(), ["docs", "notes"]);
    assert.deepEqual(fs.readdirSync(dir), ["index.sqlite"]);
    assert.deepEqual(collectionsNeedingEmbedding(path.join(dir, "missing.sqlite"), ["notes"]), ["notes"]);
});

test("a legacy index without total_chunks is read, and an unreadable index is unknown, not complete", () => {
    const dir = tempDir("lms-qmdlegacy-");
    const db = path.join(dir, "index.sqlite");
    makeWalDb(
        db,
        [QMD_TABLES, "CREATE TABLE content_vectors (hash TEXT, seq INTEGER, pos INTEGER, model TEXT, embedded_at TEXT, PRIMARY KEY (hash, seq));", DOCS, "INSERT INTO content_vectors VALUES ('h1',0,0,'m',''), ('h3',0,0,'m',''), ('h4',0,0,'m','');"].join(" "),
    );
    assert.deepEqual(collectionsNeedingEmbedding(db, ["notes", "docs", "old"]), ["notes"]);
    const broken = path.join(dir, "broken.sqlite");
    fs.writeFileSync(broken, "not a database");
    assert.equal(collectionsNeedingEmbedding(broken, ["notes"]), null);
});
