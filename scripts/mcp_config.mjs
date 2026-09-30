/**
 * Agent MCP configuration: read which servers a client already has, and add
 * servers to a TOML client config (Codex, Grok) without rewriting it.
 *
 * A server the file already defines, in any TOML spelling (table header, child
 * table, dotted key, inline table under [mcp_servers]), is left untouched,
 * including its children: the header table of a colleague's own server is never
 * added or changed. Only whole servers that are absent are appended.
 */

const KEY_SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|"[^"\r\n]*"|'[^'\r\n]*')`;
const KEY_PATH = String.raw`${KEY_SEGMENT}(?:\s*\.\s*${KEY_SEGMENT})*`;
const TABLE_HEADER = new RegExp(String.raw`^\s*\[\[?\s*(${KEY_PATH})\s*\]\]?\s*(?:#.*)?$`);
const KEY_VALUE = new RegExp(String.raw`^\s*(${KEY_PATH})\s*=`);
const SEGMENT = new RegExp(KEY_SEGMENT, "g");

/** @param {string} raw dotted TOML key path */
function normalizeKeyPath(raw) {
    return (raw.match(SEGMENT) ?? []).map((segment) => segment.replace(/^"(.*)"$|^'(.*)'$/, "$1$2")).join(".");
}

/**
 * The table headers and key assignments of a TOML document, line by line, with every
 * key resolved to its full dotted path (quoted segments unquoted). Lines inside
 * multi-line arrays or strings are not assignments and are skipped by the patterns.
 * @param {string} text
 * @returns {({ kind: "header", path: string, array: boolean, raw: string } | { kind: "key", path: string, table: string, raw: string, rest: string, bare: boolean })[]}
 */
export function tomlEntries(text) {
    const entries = [];
    let table = "";
    for (const line of text.split(/\r?\n/)) {
        const header = TABLE_HEADER.exec(line);
        if (header) {
            table = normalizeKeyPath(header[1]);
            entries.push({ kind: /** @type {const} */ ("header"), path: table, array: /^\s*\[\[/.test(line), raw: line });
            continue;
        }
        const assignment = KEY_VALUE.exec(line);
        if (assignment) {
            const key = normalizeKeyPath(assignment[1]);
            entries.push({
                kind: /** @type {const} */ ("key"),
                path: table ? `${table}.${key}` : key,
                table,
                raw: line,
                rest: line.slice(assignment[0].length).trim(),
                bare: /^[A-Za-z0-9_-]+$/.test(assignment[1].trim()),
            });
        }
    }
    return entries;
}

/**
 * Structural errors TOML parsers reject, checked before any edited config is written:
 * a table declared twice, a key assigned twice, or a [table] header for a table that
 * a dotted key or a value already defined.
 * @param {string} text
 * @returns {string[]}
 */
export function tomlStructureProblems(text) {
    const problems = [];
    const headers = new Set();
    const keys = new Set();
    const dottedTables = new Set();
    for (const entry of tomlEntries(text)) {
        if (entry.kind === "header") {
            if (entry.array) continue;
            if (headers.has(entry.path)) problems.push(`table [${entry.path}] is declared twice`);
            if (keys.has(entry.path) || dottedTables.has(entry.path)) problems.push(`table [${entry.path}] is already defined by a key`);
            headers.add(entry.path);
            continue;
        }
        if (keys.has(entry.path)) problems.push(`key ${entry.path} is assigned twice`);
        keys.add(entry.path);
        const local = entry.table ? entry.path.slice(entry.table.length + 1) : entry.path;
        const parts = local.split(".");
        for (let i = 1; i < parts.length; i += 1) dottedTables.add([entry.table, ...parts.slice(0, i)].filter(Boolean).join("."));
    }
    return problems;
}

/**
 * Refuse a TOML edit that adds a structure error the original did not have.
 * @param {string} file for the message
 * @param {string} before the original document
 * @param {string} after the edited document
 */
export function assertTomlWritable(file, before, after) {
    const existing = new Set(tomlStructureProblems(before));
    const added = tomlStructureProblems(after).filter((problem) => !existing.has(problem));
    if (added.length > 0) throw new Error(`Editing ${file} would make it invalid (${added.join("; ")}); edit it by hand.`);
}

/** @param {string} value */
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withinServer(keyPath, server) {
    return keyPath === server || keyPath.startsWith(`${server}.`);
}

/**
 * @param {string} text TOML document
 * @param {string} name server name under `mcp_servers`
 */
export function serverDefined(text, name) {
    const server = `mcp_servers.${name}`;
    let table = "";
    for (const line of text.split(/\r?\n/)) {
        const header = TABLE_HEADER.exec(line);
        if (header) {
            table = normalizeKeyPath(header[1]);
            if (withinServer(table, server)) return true;
            continue;
        }
        const assignment = KEY_VALUE.exec(line);
        if (assignment) {
            const key = normalizeKeyPath(assignment[1]);
            const full = table ? `${table}.${key}` : key;
            if (withinServer(full, server)) return true;
            // One-line inline table: mcp_servers = { qmd = { ... }, ... }
            if (full === "mcp_servers" && new RegExp(String.raw`[{,]\s*(?:${escapeRegExp(name)}|"${escapeRegExp(name)}"|'${escapeRegExp(name)}')\s*=`).test(line.slice(assignment[0].length))) return true;
        }
    }
    return false;
}

/**
 * @typedef {{ name: string, fields: Readonly<Record<string, string | boolean>> }} TomlServer
 */

/** @param {string | boolean} value */
function tomlValue(value) {
    // A JSON string literal is a valid TOML basic string.
    return typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

/** @param {Readonly<Record<string, string | boolean>>} entries */
function tomlBody(entries) {
    return Object.entries(entries)
        .map(([key, value]) => `${JSON.stringify(key)} = ${tomlValue(value)}\n`)
        .join("");
}

/**
 * @param {TomlServer} server
 */
function renderServer(server) {
    return `[mcp_servers.${server.name}]\n${tomlBody(server.fields)}`;
}

/**
 * True when the document assigns `mcp_servers` itself as a value (an inline table at
 * the root, `mcp_servers = { ... }`). TOML forbids adding `[mcp_servers.x]` tables to
 * a table defined inline, so such a file cannot be extended by appending.
 * @param {string} text
 */
export function serversTableInline(text) {
    let table = "";
    for (const line of text.split(/\r?\n/)) {
        const header = TABLE_HEADER.exec(line);
        if (header) {
            table = normalizeKeyPath(header[1]);
            continue;
        }
        const assignment = KEY_VALUE.exec(line);
        if (assignment && (table ? `${table}.${normalizeKeyPath(assignment[1])}` : normalizeKeyPath(assignment[1])) === "mcp_servers") return true;
    }
    return false;
}

/**
 * @param {string} text
 * @param {readonly TomlServer[]} servers
 * @throws when `mcp_servers` is an inline table and a server is missing
 */
export function appendServers(text, servers) {
    if (servers.some((server) => !serverDefined(text, server.name)) && serversTableInline(text)) {
        throw new Error("This config defines mcp_servers as an inline table (mcp_servers = { ... }); add the qmd and longmemory servers to it by hand.");
    }
    let out = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
    for (const server of servers) {
        if (serverDefined(out, server.name)) continue;
        if (out.length > 0 && !out.endsWith("\n\n")) out += "\n";
        out += renderServer(server);
    }
    assertTomlWritable("the MCP config", text, out);
    return out;
}

/**
 * Codex: `[mcp_servers.<name>]` with `url` for streamable HTTP (~/.codex/config.toml).
 * Both servers are local-only and keyless, so no header table is written.
 * @param {{ qmdUrl: string, longMemoryUrl: string }} endpoints
 * @returns {TomlServer[]}
 */
export function codexServers(endpoints) {
    return [
        { name: "qmd", fields: { url: endpoints.qmdUrl } },
        { name: "longmemory", fields: { url: endpoints.longMemoryUrl } },
    ];
}

/**
 * Grok: `[mcp_servers.<name>]` with `url` and `enabled`
 * (~/.grok/docs/user-guide/07-mcp-servers.md).
 * @param {{ qmdUrl: string, longMemoryUrl: string }} endpoints
 * @returns {TomlServer[]}
 */
export function grokServers(endpoints) {
    return [
        { name: "qmd", fields: { url: endpoints.qmdUrl, enabled: true } },
        { name: "longmemory", fields: { url: endpoints.longMemoryUrl, enabled: true } },
    ];
}

/**
 * Arguments that add one keyless HTTP MCP server with the agent's own CLI, user scope.
 * OpenCode writes to its global folder (see agent_config_files.mjs).
 * @param {"claude" | "opencode"} agent
 * @param {string} name
 * @param {string} url
 */
export function mcpAddArgs(agent, name, url) {
    if (agent === "claude") return ["mcp", "add", "--scope", "user", "--transport", "http", name, url];
    return ["mcp", "add", name, "--url", url];
}

/**
 * Index just past the whitespace and comments starting at `from`.
 * @param {string} text
 * @param {number} from
 */
function skipTrivia(text, from) {
    let i = from;
    while (i < text.length) {
        if (/\s/.test(text[i])) i += 1;
        else if (text.startsWith("//", i)) i = text.includes("\n", i) ? text.indexOf("\n", i) : text.length;
        else if (text.startsWith("/*", i)) {
            const end = text.indexOf("*/", i + 2);
            if (end < 0) throw new Error("Unterminated block comment in JSONC.");
            i = end + 2;
        } else break;
    }
    return i;
}

/**
 * Parse JSON with comments and trailing commas (OpenCode's opencode.jsonc).
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
    let out = "";
    let i = 0;
    while (i < text.length) {
        const next = skipTrivia(text, i);
        if (next > i) {
            out += " ";
            i = next;
            continue;
        }
        const char = text[i];
        if (char === '"') {
            let end = i + 1;
            while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
            out += text.slice(i, end + 1);
            i = end + 1;
        } else if (char === "," && "}]".includes(text[skipTrivia(text, i + 1)] ?? "")) {
            i += 1;
        } else {
            out += char;
            i += 1;
        }
    }
    return JSON.parse(out);
}

/**
 * Server names under `key` of a parsed JSON config (`mcpServers` in ~/.claude.json,
 * `mcp` in OpenCode's config).
 * @param {unknown} config
 * @param {string} key
 * @returns {string[]}
 */
export function jsonServerNames(config, key) {
    if (typeof config !== "object" || config === null) return [];
    const servers = /** @type {Record<string, unknown>} */ (config)[key];
    return typeof servers === "object" && servers !== null ? Object.keys(servers) : [];
}
