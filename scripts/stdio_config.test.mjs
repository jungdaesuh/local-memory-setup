import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { isStdioConfigReady, isStdioJsonReady, isStdioTomlReady, inspectStdioJson, inspectStdioToml, upsertStdioJson, upsertStdioToml } from "./stdio_config.mjs";
import { parseJsonc } from "./mcp_config.mjs";

const specs = [
    { name: "qmd", command: "/usr/bin/node", args: ["/opt/local-memory/mcp_launch.mjs", "qmd", "/opt/local-memory/runtime.json"] },
    { name: "longmemory", command: "/usr/bin/node", args: ["/opt/local-memory/mcp_launch.mjs", "longmemory", "/opt/local-memory/runtime.json"] },
];

function parseTomlWithPython(text) {
    execFileSync("python3", ["-c", "import sys, tomllib; tomllib.loads(sys.stdin.read())"], { input: text });
}

function record(value, label) {
    assert.equal(typeof value, "object", `${label} must be an object`);
    assert.notEqual(value, null, `${label} must not be null`);
    assert.equal(Array.isArray(value), false, `${label} must not be an array`);
    return /** @type {Record<string, unknown>} */ (value);
}

test("missing Codex and Grok TOML entries become native stdio and parse as TOML", () => {
    for (const original of ["model = 'gpt-5'\n", "[mcp]\nmax_output_bytes = 40000\n"]) {
        const result = upsertStdioToml(original, specs);
        assert.equal(result.ready, true);
        assert.deepEqual(result.servers.map(({ state }) => state), ["added", "added"]);
        assert.doesNotMatch(result.text, /http:\/\//);
        parseTomlWithPython(result.text);
        assert.equal(isStdioTomlReady(result.text, specs), true);
    }
});

test("TOML migration replaces only an exact legacy URL line and preserves its comment and neighboring bytes", () => {
    const original = [
        "model = 'gpt-5' # keep this",
        "",
        "[mcp_servers.qmd]",
        'url = "http://localhost:8181/mcp"  # qmd setup endpoint',
        "",
        "[features]",
        "fast = true",
        "",
    ].join("\n");
    const result = upsertStdioToml(original, specs);
    assert.equal(result.ready, true);
    assert.deepEqual(result.servers.map(({ state }) => state), ["migrated", "added"]);
    assert.equal(result.text.includes('args = ["/opt/local-memory/mcp_launch.mjs","qmd","/opt/local-memory/runtime.json"]  # qmd setup endpoint'), true);
    assert.equal(result.text.includes("[features]\nfast = true\n"), true);
    assert.doesNotMatch(result.text, /http:\/\//);
    parseTomlWithPython(result.text);
});

test("TOML upsert is idempotent and the ready predicate accepts only the exact launch tuple", () => {
    const once = upsertStdioToml("", specs);
    const twice = upsertStdioToml(once.text, specs);
    assert.equal(twice.changed, false);
    assert.deepEqual(twice.servers.map(({ state }) => state), ["already-ready", "already-ready"]);
    assert.equal(isStdioTomlReady(once.text, specs), true);
    assert.equal(isStdioConfigReady("codex", once.text, specs), true);
    const wrongPath = once.text.replace("/opt/local-memory/mcp_launch.mjs", "mcp_launch.mjs");
    assert.equal(isStdioTomlReady(wrongPath, specs), false);
});

test("same-named TOML with custom fields is preserved and blocks readiness", () => {
    const original = [
        "[mcp_servers.qmd]",
        'url = "http://localhost:8181/mcp"',
        'headers = { Authorization = "user-owned" }',
        "",
    ].join("\n");
    const result = upsertStdioToml(original, specs);
    assert.equal(result.ready, false);
    assert.equal(result.servers[0].state, "foreign");
    assert.equal(result.servers[0].ready, false);
    assert.equal(result.text.startsWith(original), true);
    assert.equal(isStdioTomlReady(result.text, specs), false);
    parseTomlWithPython(result.text);
});

test("complex TOML server definitions are blocked with an actionable reason", () => {
    const original = 'mcp_servers = { qmd = { url = "http://localhost:8181/mcp" } }\n';
    const result = upsertStdioToml(original, specs);
    assert.equal(result.changed, false);
    assert.equal(result.ready, false);
    assert.equal(result.servers[0].state, "foreign");
    assert.equal(result.servers[1].state, "blocked");
    assert.match(result.servers[1].reason, /inline table/);
});

test("Claude JSON migration removes only exact setup-owned HTTP entries", () => {
    const original = [
        "{",
        '  "theme": "dark",',
        '  "mcpServers": {',
        '    "qmd": {"type": "http", "url": "http://localhost:8181/mcp"},',
        '    "longmemory": {"type": "http", "url": "http://127.0.0.1:7331/mcp"}',
        "  },",
        '  "otherSetting": true,',
        "}\n",
    ].join("\n");
    const result = upsertStdioJson(original, "claude", specs);
    assert.equal(result.ready, true);
    assert.deepEqual(result.servers.map(({ state }) => state), ["migrated", "migrated"]);
    assert.doesNotMatch(result.text, /http:\/\//);
    assert.equal(result.text.startsWith('{\n  "theme": "dark",\n  "mcpServers": {\n'), true);
    assert.equal(result.text.endsWith('  },\n  "otherSetting": true,\n}\n'), true);
    const parsed = record(parseJsonc(result.text), "Claude config");
    const servers = record(parsed.mcpServers, "Claude MCP servers");
    const qmd = record(servers.qmd, "Claude qmd server");
    assert.deepEqual(qmd, { type: "stdio", command: specs[0].command, args: specs[0].args });
    assert.equal(isStdioJsonReady(result.text, "claude", specs), true);
    assert.equal(isStdioConfigReady("claude", result.text, specs), true);
});

test("JSONC migration retains CRLF formatting around changed entries", () => {
    const original = [
        "{",
        '  "mcpServers": {',
        '    "qmd": {"type":"http","url":"http://localhost:8181/mcp"}',
        "  }",
        "}",
        "",
    ].join("\r\n");
    const result = upsertStdioJson(original, "claude", specs);
    assert.equal(result.ready, true);
    assert.equal(result.text.replaceAll("\r\n", "").includes("\n"), false);
    assert.equal(isStdioJsonReady(result.text, "claude", specs), true);
});

test("OpenCode adds local command arrays while retaining JSONC comments and existing settings", () => {
    const original = [
        "{",
        '  // user note stays byte-for-byte',
        '  "theme": "system",',
        '  "mcp": {',
        '    "other": { "type": "local", "command": ["echo"] }',
        "  }",
        "}\n",
    ].join("\n");
    const result = upsertStdioJson(original, "opencode", specs);
    assert.equal(result.ready, true);
    assert.deepEqual(result.servers.map(({ state }) => state), ["added", "added"]);
    assert.equal(result.text.startsWith('{\n  // user note stays byte-for-byte\n  "theme": "system",'), true);
    const parsed = record(parseJsonc(result.text), "OpenCode config");
    const servers = record(parsed.mcp, "OpenCode MCP servers");
    for (const spec of specs) {
        assert.deepEqual(record(servers[spec.name], `${spec.name} OpenCode server`), {
            type: "local",
            command: [spec.command, ...spec.args],
            enabled: true,
        });
    }
    assert.equal(isStdioJsonReady(result.text, "opencode", specs), true);
    assert.equal(isStdioConfigReady("opencode", result.text, specs), true);
});

test("foreign JSON HTTP entries are preserved and never satisfy readiness", () => {
    const original = '{"mcpServers":{"qmd":{"type":"http","url":"http://localhost:8181/mcp","headers":{"Authorization":"owned"}}}}';
    const result = upsertStdioJson(original, "claude", specs);
    assert.equal(result.ready, false);
    assert.equal(result.servers[0].state, "foreign");
    assert.equal(result.servers[0].ready, false);
    assert.equal(result.text.includes('"url":"http://localhost:8181/mcp"'), true);
    assert.equal(isStdioJsonReady(result.text, "claude", specs), false);
    const inspected = inspectStdioJson(original, "claude", specs);
    assert.equal(inspected[0].state, "foreign");
});

test("OpenCode migrates only the exact remote URL shape and preserves disabled entries", () => {
    const legacy = '{"mcp":{"qmd":{"type":"remote","url":"http://localhost:8181/mcp"},"longmemory":{"type":"remote","url":"http://127.0.0.1:7331/mcp"}}}';
    const migrated = upsertStdioJson(legacy, "opencode", specs);
    assert.equal(migrated.ready, true);
    assert.deepEqual(migrated.servers.map(({ state }) => state), ["migrated", "migrated"]);
    assert.doesNotMatch(migrated.text, /http:\/\//);
    const disabled = '{"mcp":{"qmd":{"type":"remote","url":"http://localhost:8181/mcp","enabled":false}}}';
    const result = upsertStdioJson(disabled, "opencode", specs);
    assert.equal(result.ready, false);
    assert.equal(result.servers[0].state, "foreign");
    assert.equal(result.text.includes('"enabled":false'), true);
});

test("JSONC comments inside a legacy server entry prevent destructive migration", () => {
    const original = '{"mcpServers":{"qmd":{"type":"http", /* keep this note */ "url":"http://localhost:8181/mcp"}}}';
    const result = upsertStdioJson(original, "claude", specs);
    assert.equal(result.ready, false);
    assert.equal(result.servers[0].state, "foreign");
    assert.equal(result.text.includes("/* keep this note */"), true);
    assert.equal(result.text.includes("http://localhost:8181/mcp"), true);
});

test("invalid or incomplete launch specs fail before producing a candidate config", () => {
    const relative = [
        { name: "qmd", command: "node", args: ["/opt/local-memory/mcp_launch.mjs", "qmd"] },
        specs[1],
    ];
    assert.throws(() => upsertStdioToml("", relative), /absolute Node/);
    assert.throws(() => upsertStdioJson("", "claude", relative), /absolute Node/);
    const incomplete = [
        { name: "qmd", command: "/usr/bin/node", args: ["/opt/local-memory/mcp_launch.mjs", "qmd"] },
        specs[1],
    ];
    assert.throws(() => upsertStdioToml("", incomplete), /absolute runtimePath/);
});

test("an explicitly disabled owned stdio entry is preserved and never ready", () => {
    const ready = upsertStdioToml("", specs).text;
    const disabled = ready.replace("[mcp_servers.qmd]", "[mcp_servers.qmd]\nenabled = false");
    const result = upsertStdioToml(disabled, specs);
    assert.equal(result.ready, false);
    assert.equal(result.text, disabled);
    assert.equal(result.servers.find(server => server.name === "qmd").ready, false);
});
