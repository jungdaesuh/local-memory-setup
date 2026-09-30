import assert from "node:assert/strict";
import test from "node:test";
import { appendServers, codexServers, grokServers, jsonServerNames, mcpAddArgs, parseJsonc, serverDefined } from "./mcp_config.mjs";

const endpoints = { qmdUrl: "http://localhost:8181/mcp", longMemoryUrl: "http://127.0.0.1:7331/mcp" };

test("serverDefined recognises every TOML spelling of a server", () => {
    const spellings = [
        "[mcp_servers.qmd]\nurl = 'x'\n",
        "[ mcp_servers . qmd ]  # mine\nurl = 'x'\n",
        '[mcp_servers."qmd"]\nurl = "x"\n',
        "[mcp_servers.qmd.http_headers]\nA = 'b'\n",
        "mcp_servers.qmd.url = 'x'\n",
        'mcp_servers.qmd = { url = "x" }\n',
        '[mcp_servers]\nqmd = { url = "x" }\n',
        "[mcp_servers]\nqmd.url = 'x'\n",
    ];
    for (const text of spellings) assert.equal(serverDefined(text, "qmd"), true, text);
});

test("serverDefined is not fooled by similar names or values", () => {
    const text = [
        "[mcp_servers.qmd-legacy]",
        'url = "http://localhost:8181/mcp"  # qmd',
        "[mcp_servers.other]",
        'command = "qmd"',
        "[profiles.qmd]",
        "model = 'x'",
        "",
    ].join("\n");
    assert.equal(serverDefined(text, "qmd"), false);
});

test("appendServers adds a missing server with its header table", () => {
    const out = appendServers("model = \"o3\"\n", codexServers(endpoints));
    assert.equal(
        out,
        [
            'model = "o3"',
            "",
            "[mcp_servers.qmd]",
            '"url" = "http://localhost:8181/mcp"',
            "",
            "[mcp_servers.longmemory]",
            '"url" = "http://127.0.0.1:7331/mcp"',
            "",
        ].join("\n"),
    );
});

test("a colleague's own server is left whole: no header table is added under it", () => {
    const mine = '[mcp_servers.longmemory]\ncommand = "longmemory-stdio"\n';
    const out = appendServers(mine, codexServers(endpoints));
    assert.doesNotMatch(out, /longmemory\.http_headers/);
    assert.equal(out.split("[mcp_servers.longmemory]").length, 2);
    assert.ok(out.startsWith(mine));
    assert.match(out, /\[mcp_servers\.qmd\]/);
});

test("appendServers is idempotent and never duplicates a table", () => {
    const once = appendServers("", grokServers(endpoints));
    const twice = appendServers(once, grokServers(endpoints));
    assert.equal(twice, once);
    assert.equal(once.match(/^\[mcp_servers\.longmemory\]$/gm)?.length, 1);
    assert.doesNotMatch(once, /headers\]/);
    assert.match(once, /^"enabled" = true$/m);
});

test("appendServers terminates a last line that has no newline", () => {
    assert.ok(appendServers("a = 1", codexServers(endpoints)).startsWith("a = 1\n\n[mcp_servers.qmd]\n"));
});

test("generated MCP entries are keyless: no X-API-Key in CLI arguments or TOML", () => {
    assert.deepEqual(mcpAddArgs("claude", "longmemory", endpoints.longMemoryUrl), ["mcp", "add", "--scope", "user", "--transport", "http", "longmemory", endpoints.longMemoryUrl]);
    assert.deepEqual(mcpAddArgs("opencode", "longmemory", endpoints.longMemoryUrl), ["mcp", "add", "longmemory", "--url", endpoints.longMemoryUrl]);
    for (const agent of /** @type {const} */ (["claude", "opencode"])) {
        for (const name of ["qmd", "longmemory"]) assert.ok(!mcpAddArgs(agent, name, "u").some((arg) => /X-API-Key|--header/i.test(arg)));
    }
    for (const toml of [appendServers("", codexServers(endpoints)), appendServers("", grokServers(endpoints))]) {
        assert.doesNotMatch(toml, /X-API-Key|headers\]/i);
    }
});

test("parseJsonc drops comments and trailing commas but not string contents", () => {
    const parsed = parseJsonc('{\n  // c\n  "a": "x,}//y /* z */", /* b */\n  "mcp": { "qmd": { "url": "u", }, },\n}\n');
    assert.deepEqual(parsed, { a: "x,}//y /* z */", mcp: { qmd: { url: "u" } } });
    assert.deepEqual(jsonServerNames(parsed, "mcp"), ["qmd"]);
    assert.deepEqual(jsonServerNames({ mcpServers: null }, "mcpServers"), []);
    assert.throws(() => parseJsonc('{ /* open "a": 1 }'), /Unterminated/);
});

test("a root inline mcp_servers table is refused instead of producing invalid TOML", () => {
    const inline = 'model = "o3"\nmcp_servers = { other = { url = "x" } }\n';
    assert.throws(() => appendServers(inline, codexServers(endpoints)), /inline table/);
    // Nothing to add means nothing to refuse.
    const complete = 'mcp_servers = { qmd = { url = "a" }, longmemory = { url = "b" } }\n';
    assert.equal(appendServers(complete, codexServers(endpoints)), complete);
    // A [mcp_servers] table header is a normal table and stays appendable.
    assert.doesNotThrow(() => appendServers('[mcp_servers]\nother = { url = "x" }\n', codexServers(endpoints)));
});
