/**
 * Append MCP server tables without rewriting an existing config.
 * A present section is left untouched, including a colleague's own URL or key.
 */

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sectionExists(text, header) {
    return new RegExp(`^\\[${escapeRegExp(header)}\\]\\s*$`, "m").test(text);
}

/**
 * @param {string} text
 * @param {{ header: string, body: string }[]} blocks
 */
export function appendSections(text, blocks) {
    let out = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
    for (const block of blocks) {
        if (sectionExists(out, block.header)) continue;
        if (out.length > 0 && !out.endsWith("\n\n")) out += "\n";
        out += `[${block.header}]\n${block.body}\n`;
    }
    return out;
}

export function codexBlocks(apiKey) {
    return [
        { header: "mcp_servers.qmd", body: 'url = "http://127.0.0.1:8181/mcp"\n' },
        { header: "mcp_servers.longmemory", body: 'url = "http://127.0.0.1:7331/mcp"\n' },
        {
            header: "mcp_servers.longmemory.http_headers",
            body: `X-API-Key = "${apiKey}"\n`,
        },
    ];
}

export function grokBlocks(apiKey) {
    return [
        {
            header: "mcp_servers.qmd",
            body: 'url = "http://127.0.0.1:8181/mcp"\nenabled = true\n',
        },
        {
            header: "mcp_servers.longmemory",
            body: 'url = "http://127.0.0.1:7331/mcp"\nenabled = true\n',
        },
        {
            header: "mcp_servers.longmemory.headers",
            body: `X-API-Key = "${apiKey}"\n`,
        },
    ];
}
