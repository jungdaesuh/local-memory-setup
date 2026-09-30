/**
 * Pure, surgical migration of the setup-owned local MCP entries to native stdio.
 * Matching legacy endpoints are replaced only when their complete entry has the
 * exact known shape. Same-named entries with extra settings remain untouched.
 */
import path from "node:path";
import { parseJsonc, serverDefined, serversTableInline, tomlEntries, tomlStructureProblems } from "./mcp_config.mjs";

/** @typedef {"qmd" | "longmemory"} StdioServerName */
/** @typedef {{ name: StdioServerName, command: string, args: readonly [string, StdioServerName, string] }} StdioServerSpec */
/** @typedef {"missing" | "legacy" | "ready" | "foreign" | "blocked"} StdioInspectionState */
/** @typedef {"added" | "migrated" | "already-ready" | "foreign" | "blocked"} StdioMigrationState */
/** @typedef {{ name: StdioServerName, state: StdioInspectionState, reason?: string }} StdioInspection */
/** @typedef {{ name: StdioServerName, state: StdioMigrationState, ready: boolean, reason?: string }} StdioServerResult */
/** @typedef {{ text: string, changed: boolean, ready: boolean, servers: StdioServerResult[] }} StdioConfigResult */
/** @typedef {"claude" | "opencode"} JsonAgent */
/** @typedef {"claude" | "codex" | "grok" | "opencode"} StdioAgent */

const LEGACY_ENDPOINTS = Object.freeze({
    qmd: "http://localhost:8181/mcp",
    longmemory: "http://127.0.0.1:7331/mcp",
});

const REQUIRED_NAMES = Object.freeze(["qmd", "longmemory"]);
const OWNED_TOML_FIELDS = new Set(["command", "args", "enabled", "url"]);

/** @typedef {{ kind: "object", start: number, end: number, open: number, close: number, entries: JsonProperty[] }} JsonObjectNode */
/** @typedef {{ kind: "array", start: number, end: number, open: number, close: number, items: JsonNode[] }} JsonArrayNode */
/** @typedef {{ kind: "value", start: number, end: number }} JsonValueNode */
/** @typedef {JsonObjectNode | JsonArrayNode | JsonValueNode} JsonNode */
/** @typedef {{ key: string, keyStart: number, value: JsonNode, comma: number | null }} JsonProperty */
/** @typedef {{ text: string, index: number }} JsonCursor */
/** @typedef {{ start: number, end: number, text: string, eol: string }} LineRecord */
/** @typedef {{ kind: "header" | "key", path: string, table?: string, array?: boolean, rest?: string, raw: string, line: LineRecord }} PositionedTomlEntry */
/** @typedef {{ name: StdioServerName, state: "missing" | "legacy" | "ready" | "foreign", reason?: string, legacyLine?: LineRecord }} TomlAssessment */

/**
 * The launch tuple is deliberately closed: callers supply the absolute Node and
 * installed launcher paths; this module adds no URL, environment, or secret fields.
 * @param {readonly StdioServerSpec[]} specs
 */
function validateSpecs(specs) {
    if (!Array.isArray(specs) || specs.length !== REQUIRED_NAMES.length) {
        throw new Error("Expected exactly the qmd and longmemory stdio server specs.");
    }
    const byName = new Map();
    for (const spec of specs) {
        if (typeof spec !== "object" || spec === null || !REQUIRED_NAMES.includes(spec.name)) {
            throw new Error("Each stdio server spec must name qmd or longmemory.");
        }
        if (byName.has(spec.name)) throw new Error(`Duplicate stdio server spec: ${spec.name}.`);
        if (typeof spec.command !== "string" || !path.isAbsolute(spec.command) || !["node", "nodejs", "node.exe"].includes(path.basename(spec.command).toLowerCase())) {
            throw new Error(`${spec.name} must use an absolute Node executable path.`);
        }
        if (!Array.isArray(spec.args) || spec.args.length !== 3 || typeof spec.args[0] !== "string" || !path.isAbsolute(spec.args[0]) || path.basename(spec.args[0]) !== "mcp_launch.mjs" || spec.args[1] !== spec.name || typeof spec.args[2] !== "string" || !path.isAbsolute(spec.args[2])) {
            throw new Error(`${spec.name} args must be [absolute mcp_launch.mjs path, ${spec.name}, absolute runtimePath].`);
        }
        const fields = Object.keys(spec).sort();
        if (fields.join(",") !== "args,command,name") throw new Error(`${spec.name} spec has unsupported fields.`);
        byName.set(spec.name, spec);
    }
    for (const name of REQUIRED_NAMES) if (!byName.has(name)) throw new Error(`Missing stdio server spec: ${name}.`);
    return /** @type {Map<StdioServerName, StdioServerSpec>} */ (byName);
}

/** @param {string} text @param {number} from */
function skipJsonTrivia(text, from) {
    let index = from;
    while (index < text.length) {
        if (/\s/.test(text[index])) index += 1;
        else if (text.startsWith("//", index)) {
            const end = text.indexOf("\n", index + 2);
            index = end < 0 ? text.length : end + 1;
        } else if (text.startsWith("/*", index)) {
            const end = text.indexOf("*/", index + 2);
            if (end < 0) throw new Error("Unterminated block comment in JSONC.");
            index = end + 2;
        } else break;
    }
    return index;
}

/** @param {JsonCursor} cursor */
function readJsonString(cursor) {
    const start = cursor.index;
    cursor.index += 1;
    while (cursor.index < cursor.text.length) {
        const char = cursor.text[cursor.index];
        if (char === "\\") cursor.index += 2;
        else if (char === '"') {
            cursor.index += 1;
            return { value: /** @type {string} */ (JSON.parse(cursor.text.slice(start, cursor.index))), end: cursor.index };
        } else cursor.index += 1;
    }
    throw new Error("Unterminated string in JSONC.");
}

/** @param {JsonCursor} cursor */
function parseJsonNode(cursor) {
    cursor.index = skipJsonTrivia(cursor.text, cursor.index);
    const start = cursor.index;
    const char = cursor.text[cursor.index];
    if (char === "{") {
        cursor.index += 1;
        const entries = [];
        const seen = new Set();
        cursor.index = skipJsonTrivia(cursor.text, cursor.index);
        while (cursor.text[cursor.index] !== "}") {
            if (cursor.text[cursor.index] !== '"') throw new Error("JSONC object keys must be quoted strings.");
            const keyStart = cursor.index;
            const key = readJsonString(cursor).value;
            if (seen.has(key)) throw new Error(`Duplicate JSONC property ${JSON.stringify(key)} is ambiguous.`);
            seen.add(key);
            cursor.index = skipJsonTrivia(cursor.text, cursor.index);
            if (cursor.text[cursor.index] !== ":") throw new Error(`Missing colon after JSONC property ${JSON.stringify(key)}.`);
            cursor.index += 1;
            const value = parseJsonNode(cursor);
            cursor.index = skipJsonTrivia(cursor.text, cursor.index);
            if (cursor.text[cursor.index] === ",") {
                const comma = cursor.index;
                cursor.index += 1;
                entries.push({ key, keyStart, value, comma });
                cursor.index = skipJsonTrivia(cursor.text, cursor.index);
                if (cursor.text[cursor.index] === "}") break;
            } else if (cursor.text[cursor.index] === "}") entries.push({ key, keyStart, value, comma: null });
            else throw new Error(`Expected comma or closing brace after JSONC property ${JSON.stringify(key)}.`);
        }
        if (cursor.text[cursor.index] !== "}") throw new Error("Unterminated JSONC object.");
        const close = cursor.index;
        cursor.index += 1;
        return { kind: /** @type {const} */ ("object"), start, end: cursor.index, open: start, close, entries };
    }
    if (char === "[") {
        cursor.index += 1;
        const items = [];
        cursor.index = skipJsonTrivia(cursor.text, cursor.index);
        while (cursor.text[cursor.index] !== "]") {
            items.push(parseJsonNode(cursor));
            cursor.index = skipJsonTrivia(cursor.text, cursor.index);
            if (cursor.text[cursor.index] === ",") {
                cursor.index += 1;
                cursor.index = skipJsonTrivia(cursor.text, cursor.index);
                if (cursor.text[cursor.index] === "]") break;
            } else if (cursor.text[cursor.index] !== "]") throw new Error("Expected comma or closing bracket in JSONC array.");
        }
        if (cursor.text[cursor.index] !== "]") throw new Error("Unterminated JSONC array.");
        const close = cursor.index;
        cursor.index += 1;
        return { kind: /** @type {const} */ ("array"), start, end: cursor.index, open: start, close, items };
    }
    if (char === '"') {
        readJsonString(cursor);
        return { kind: /** @type {const} */ ("value"), start, end: cursor.index };
    }
    while (cursor.index < cursor.text.length && !/[\s,}\]]/.test(cursor.text[cursor.index]) && !cursor.text.startsWith("//", cursor.index) && !cursor.text.startsWith("/*", cursor.index)) cursor.index += 1;
    if (cursor.index === start) throw new Error(`Unexpected JSONC token at offset ${start}.`);
    return { kind: /** @type {const} */ ("value"), start, end: cursor.index };
}

/** @param {string} text */
function jsonRootNode(text) {
    if (text.trim() === "") return { parsed: /** @type {Record<string, unknown>} */ ({}), node: null };
    const parsed = parseJsonc(text);
    const cursor = { text, index: 0 };
    const node = parseJsonNode(cursor);
    cursor.index = skipJsonTrivia(text, cursor.index);
    if (cursor.index !== text.length) throw new Error(`Unexpected JSONC content at offset ${cursor.index}.`);
    if (node.kind !== "object" || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("MCP config must have a JSON object at its root.");
    return { parsed: /** @type {Record<string, unknown>} */ (parsed), node };
}

/** @param {JsonObjectNode} node @param {string} key */
function jsonProperty(node, key) {
    return node.entries.find((entry) => entry.key === key);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {Record<string, unknown>} record @param {readonly string[]} keys */
function hasOnlyKeys(record, keys) {
    const actual = Object.keys(record).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** @param {string} text @param {number} start @param {number} end */
function hasJsonComment(text, start, end) {
    let index = start;
    while (index < end) {
        if (text[index] === '"') {
            index += 1;
            while (index < end) {
                if (text[index] === "\\") index += 2;
                else if (text[index++] === '"') break;
            }
        } else if (text.startsWith("//", index) || text.startsWith("/*", index)) return true;
        else index += 1;
    }
    return false;
}

/** @param {StdioServerSpec} spec @param {JsonAgent} agent */
function desiredJsonEntry(spec, agent) {
    if (agent === "claude") return { type: "stdio", command: spec.command, args: [...spec.args] };
    return { type: "local", command: [spec.command, ...spec.args], enabled: true };
}

/** @param {unknown} value @param {StdioServerSpec} spec @param {JsonAgent} agent */
function isDesiredJsonEntry(value, spec, agent) {
    if (!isRecord(value)) return false;
    const expected = desiredJsonEntry(spec, agent);
    if (agent === "claude") {
        return hasOnlyKeys(value, ["type", "command", "args"]) && value.type === expected.type && value.command === expected.command && Array.isArray(value.args) && value.args.length === spec.args.length && value.args.every((arg, index) => arg === spec.args[index]);
    }
    return hasOnlyKeys(value, ["type", "command", "enabled"]) && value.type === expected.type && value.enabled === true && Array.isArray(value.command) && value.command.length === spec.args.length + 1 && value.command.every((part, index) => part === [spec.command, ...spec.args][index]);
}

/** @param {unknown} value @param {StdioServerSpec} spec @param {JsonAgent} agent */
function isLegacyJsonEntry(value, spec, agent) {
    if (!isRecord(value) || value.url !== LEGACY_ENDPOINTS[spec.name]) return false;
    if (agent === "claude") return hasOnlyKeys(value, ["type", "url"]) && value.type === "http";
    return (hasOnlyKeys(value, ["type", "url"]) || hasOnlyKeys(value, ["type", "url", "enabled"])) && value.type === "remote" && (value.enabled === undefined || value.enabled === true);
}

/** @param {string} text @param {JsonAgent} agent @param {readonly StdioServerSpec[]} specs */
function inspectJson(text, agent, specs) {
    const byName = validateSpecs(specs);
    const sectionName = agent === "claude" ? "mcpServers" : "mcp";
    if (text.trim() === "") return specs.map(({ name }) => ({ name, state: /** @type {const} */ ("missing") }));
    const { parsed, node } = jsonRootNode(text);
    if (node === null) return specs.map(({ name }) => ({ name, state: /** @type {const} */ ("missing") }));
    const sectionNodeEntry = jsonProperty(node, sectionName);
    const sectionValue = parsed[sectionName];
    if (sectionNodeEntry === undefined) return specs.map(({ name }) => ({ name, state: /** @type {const} */ ("missing") }));
    if (!isRecord(sectionValue) || sectionNodeEntry.value.kind !== "object") {
        return specs.map(({ name }) => ({ name, state: /** @type {const} */ ("blocked"), reason: `The ${sectionName} property is not an object; edit it manually before migrating MCP servers.` }));
    }
    const sectionNode = /** @type {JsonObjectNode} */ (sectionNodeEntry.value);
    return specs.map((spec) => {
        const serverProperty = jsonProperty(sectionNode, spec.name);
        if (serverProperty === undefined) return { name: spec.name, state: /** @type {const} */ ("missing") };
        const value = sectionValue[spec.name];
        if (isDesiredJsonEntry(value, byName.get(spec.name), agent)) return { name: spec.name, state: /** @type {const} */ ("ready") };
        if (hasJsonComment(text, serverProperty.value.start, serverProperty.value.end)) {
            return { name: spec.name, state: /** @type {const} */ ("foreign"), reason: "The same-named server contains JSONC comments inside its entry; it was preserved for manual review." };
        }
        if (isLegacyJsonEntry(value, spec, agent)) return { name: spec.name, state: /** @type {const} */ ("legacy") };
        return { name: spec.name, state: /** @type {const} */ ("foreign"), reason: "A same-named server exists with a different transport or custom fields; it was preserved and does not count as stdio-ready." };
    });
}

/** @param {string} text @param {JsonObjectNode} node */
function jsonObjectIndent(text, node) {
    for (const entry of node.entries) {
        const lineStart = text.lastIndexOf("\n", entry.keyStart - 1) + 1;
        const prefix = text.slice(lineStart, entry.keyStart);
        if (/^[ \t]*$/.test(prefix)) return prefix;
    }
    return "  ";
}

/** @param {string} text @param {JsonProperty} property @param {unknown} value */
function renderJsonValueAtProperty(text, property, value) {
    const lineStart = text.lastIndexOf("\n", property.keyStart - 1) + 1;
    const prefix = text.slice(lineStart, property.keyStart);
    const indentation = /^[ \t]*/.exec(prefix)?.[0] ?? "";
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    return JSON.stringify(value, null, 2).replace(/\n/g, `${newline}${indentation}`);
}

/** @param {string} text @param {JsonObjectNode} node @param {readonly { key: string, value: unknown }[]} additions */
function jsonObjectInsertion(text, node, additions) {
    if (additions.length === 0) return null;
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const closeLineStart = text.lastIndexOf("\n", node.close - 1) + 1;
    const closeIndent = text.slice(closeLineStart, node.close);
    const block = closeLineStart > node.open && /^[ \t]*$/.test(closeIndent);
    if (block) {
        const propertyIndent = node.entries.length > 0 ? jsonObjectIndent(text, node) : `${closeIndent}  `;
        const members = additions.map(({ key, value }) => {
            const rendered = JSON.stringify(value, null, 2).replace(/\n/g, `${newline}${propertyIndent}`);
            return `${propertyIndent}${JSON.stringify(key)}: ${rendered}`;
        });
        const patches = [{ start: closeLineStart, end: closeLineStart, text: `${members.join(`,${newline}`)}${newline}` }];
        const last = node.entries.at(-1);
        if (last !== undefined && last.comma === null) patches.push({ start: last.value.end, end: last.value.end, text: "," });
        return patches;
    }
    const members = additions.map(({ key, value }) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
    const last = node.entries.at(-1);
    const patches = [{ start: node.close, end: node.close, text: `${node.entries.length > 0 ? " " : ""}${members.join(", ")}` }];
    if (last !== undefined && last.comma === null) patches.push({ start: last.value.end, end: last.value.end, text: "," });
    return patches;
}

/** @param {string} text @param {readonly { start: number, end: number, text: string }[]} patches */
function applyPatches(text, patches) {
    let output = text;
    for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
        output = `${output.slice(0, patch.start)}${patch.text}${output.slice(patch.end)}`;
    }
    return output;
}

/** @param {string} text @param {JsonAgent} agent @param {readonly StdioServerSpec[]} specs */
export function upsertStdioJson(text, agent, specs) {
    if (agent !== "claude" && agent !== "opencode") throw new Error(`JSON stdio config is not supported for ${agent}.`);
    const byName = validateSpecs(specs);
    const inspections = inspectJson(text, agent, specs);
    const resultByName = new Map(inspections.map((inspection) => [inspection.name, inspection]));
    if (text.trim() === "") {
        const entries = Object.fromEntries(specs.map((spec) => [spec.name, desiredJsonEntry(spec, agent)]));
        const sectionName = agent === "claude" ? "mcpServers" : "mcp";
        const output = `${JSON.stringify({ [sectionName]: entries }, null, 2)}\n`;
        return { text: output, changed: true, ready: true, servers: specs.map(({ name }) => ({ name, state: "added", ready: true })) };
    }

    const { parsed, node } = jsonRootNode(text);
    if (node === null) throw new Error("Unexpected empty JSON config after inspection.");
    const sectionName = agent === "claude" ? "mcpServers" : "mcp";
    const sectionEntry = jsonProperty(node, sectionName);
    const patches = [];
    const missing = [];
    const statuses = [];

    for (const spec of specs) {
        const inspection = resultByName.get(spec.name);
        if (inspection?.state === "ready") {
            statuses.push({ name: spec.name, state: "already-ready", ready: true });
        } else if (inspection?.state === "legacy") {
            const sectionNode = /** @type {JsonObjectNode} */ (/** @type {JsonProperty} */ (sectionEntry).value);
            const serverProperty = /** @type {JsonProperty} */ (jsonProperty(sectionNode, spec.name));
            patches.push({ start: serverProperty.value.start, end: serverProperty.value.end, text: renderJsonValueAtProperty(text, serverProperty, desiredJsonEntry(spec, agent)) });
            statuses.push({ name: spec.name, state: "migrated", ready: true });
        } else if (inspection?.state === "missing") {
            missing.push({ key: spec.name, value: desiredJsonEntry(byName.get(spec.name), agent) });
            statuses.push({ name: spec.name, state: "added", ready: true });
        } else {
            statuses.push({ name: spec.name, state: inspection?.state === "blocked" ? "blocked" : "foreign", ready: false, reason: inspection?.reason ?? "The same-named server could not be classified safely." });
        }
    }

    if (missing.length > 0) {
        if (sectionEntry === undefined) {
            patches.push(.../** @type {{ start: number, end: number, text: string }[]} */ (jsonObjectInsertion(text, node, [{ key: sectionName, value: Object.fromEntries(missing.map(({ key, value }) => [key, value])) }])));
        } else {
            if (sectionEntry.value.kind !== "object" || !isRecord(parsed[sectionName])) throw new Error(`Cannot safely add servers because ${sectionName} is not a JSON object.`);
            const mapPatches = jsonObjectInsertion(text, /** @type {JsonObjectNode} */ (sectionEntry.value), missing);
            if (mapPatches === null) throw new Error(`Cannot safely add servers under ${sectionName}.`);
            patches.push(...mapPatches);
        }
    }

    const output = applyPatches(text, patches);
    const ready = statuses.every((status) => status.ready);
    return { text: output, changed: output !== text, ready, servers: statuses };
}

/** @param {string} text @param {number} index */
function splitTomlComment(text, index) {
    let quote = "";
    let escaped = false;
    for (let cursor = index; cursor < text.length; cursor += 1) {
        const char = text[cursor];
        if (quote === '"') {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quote = "";
        } else if (quote === "'") {
            if (char === "'") quote = "";
        } else if (char === '"' || char === "'") quote = char;
        else if (char === "#") {
            let valueEnd = cursor;
            while (valueEnd > index && /\s/.test(text[valueEnd - 1])) valueEnd -= 1;
            return { value: text.slice(index, valueEnd).trim(), suffix: text.slice(valueEnd) };
        }
    }
    let valueEnd = text.length;
    while (valueEnd > index && /\s/.test(text[valueEnd - 1])) valueEnd -= 1;
    return { value: text.slice(index, valueEnd).trim(), suffix: text.slice(valueEnd) };
}

/** @param {string} raw */
function decodeTomlString(raw) {
    if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
        const value = JSON.parse(raw);
        return typeof value === "string" ? value : null;
    }
    const literal = /^'((?:[^']|'')*)'$/.exec(raw);
    return literal === null ? null : literal[1].replaceAll("''", "'");
}

/** @param {string} raw */
function decodeTomlStringArray(raw) {
    if (!/^\[\s*(?:"(?:[^"\\]|\\.)*"\s*(?:,\s*"(?:[^"\\]|\\.)*"\s*)*)?\]$/.test(raw)) return null;
    const value = JSON.parse(raw);
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

/** @param {string} raw @param {"string" | "boolean" | "string-array"} kind */
function tomlValue(raw, kind) {
    const value = splitTomlComment(raw, 0).value;
    if (kind === "string") return decodeTomlString(value);
    if (kind === "string-array") return decodeTomlStringArray(value);
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
}

/** @param {string} text */
function lineRecords(text) {
    const lines = [];
    let start = 0;
    while (start < text.length) {
        const newlineIndex = text.indexOf("\n", start);
        if (newlineIndex < 0) {
            lines.push({ start, end: text.length, text: text.slice(start), eol: "" });
            break;
        }
        const crlf = newlineIndex > start && text[newlineIndex - 1] === "\r";
        const end = crlf ? newlineIndex - 1 : newlineIndex;
        lines.push({ start, end, text: text.slice(start, end), eol: crlf ? "\r\n" : "\n" });
        start = newlineIndex + 1;
    }
    return lines;
}

/** @param {string} text */
function positionedTomlEntries(text) {
    const lines = lineRecords(text);
    const parsed = tomlEntries(text);
    const positioned = [];
    let lineIndex = 0;
    for (const entry of parsed) {
        while (lineIndex < lines.length && lines[lineIndex].text !== entry.raw) lineIndex += 1;
        const line = lines[lineIndex];
        if (line === undefined) continue;
        positioned.push({ ...entry, line });
        lineIndex += 1;
    }
    return positioned;
}

/** @param {StdioServerName} name @param {StdioServerSpec} spec @param {readonly PositionedTomlEntry[]} entries */
function assessTomlServer(name, spec, entries) {
    const serverPath = `mcp_servers.${name}`;
    const directHeaders = entries.filter((entry) => entry.kind === "header" && entry.path === serverPath && entry.array === false);
    if (!serverDefined(entries.map(({ raw }) => raw).join("\n"), name)) return { name, state: "missing" };
    if (directHeaders.length !== 1 || entries.some((entry) => entry.kind === "header" && entry.path.startsWith(`${serverPath}.`))) {
        return { name, state: "foreign", reason: "The server uses a dotted, inline, nested, or repeated TOML form that this surgical migrator cannot safely edit; edit it by hand." };
    }
    const direct = entries.filter((entry) => entry.kind === "key" && entry.table === serverPath);
    const otherDefinition = entries.some((entry) => entry.kind === "key" && entry.path.startsWith(`${serverPath}.`) && entry.table !== serverPath);
    if (otherDefinition) return { name, state: "foreign", reason: "The server has another TOML definition outside its own table; it was preserved for manual review." };
    const fields = new Map();
    for (const entry of direct) {
        const local = entry.path.slice(`${serverPath}.`.length);
        if (!OWNED_TOML_FIELDS.has(local) || fields.has(local)) {
            return { name, state: "foreign", reason: "The server has custom or duplicate TOML fields; it was preserved and does not count as stdio-ready." };
        }
        fields.set(local, entry);
    }
    if (fields.has("command") || fields.has("args")) {
        if (!fields.has("command") || !fields.has("args") || fields.has("url")) return { name, state: "foreign", reason: "The TOML server mixes transports or has an incomplete stdio command; it was preserved." };
        const commandEntry = fields.get("command");
        const argsEntry = fields.get("args");
        const command = tomlValue(/** @type {string} */ (commandEntry.rest), "string");
        const args = tomlValue(/** @type {string} */ (argsEntry.rest), "string-array");
        const enabledEntry = fields.get("enabled");
        const enabled = enabledEntry === undefined ? undefined : tomlValue(/** @type {string} */ (enabledEntry.rest), "boolean");
        const exact = command === spec.command && Array.isArray(args) && args.length === spec.args.length && args.every((arg, index) => arg === spec.args[index]) && (enabledEntry === undefined || enabled === true);
        return exact ? { name, state: "ready" } : { name, state: "foreign", reason: "The TOML command is not the expected absolute Node plus installed launcher tuple; it was preserved." };
    }
    const urlEntry = fields.get("url");
    if (urlEntry === undefined || fields.has("command") || fields.has("args")) return { name, state: "foreign", reason: "The same-named TOML server has a different transport or custom fields; it was preserved and does not count as stdio-ready." };
    const url = tomlValue(urlEntry.rest, "string");
    const enabledEntry = fields.get("enabled");
    const enabled = enabledEntry === undefined ? undefined : tomlValue(/** @type {string} */ (enabledEntry.rest), "boolean");
    if (url !== LEGACY_ENDPOINTS[name] || (enabledEntry !== undefined && typeof enabled !== "boolean")) {
        return { name, state: "foreign", reason: "The URL or enabled value is not the exact supported legacy config; it was preserved." };
    }
    if (enabledEntry !== undefined && enabled === false) {
        return { name, state: "foreign", reason: "The legacy server is explicitly disabled; it was preserved so migration does not change that choice." };
    }
    return { name, state: "legacy", legacyLine: urlEntry.line };
}

/** @param {StdioServerSpec} spec @param {string} newline */
function renderTomlServer(spec, newline) {
    return `[mcp_servers.${spec.name}]${newline}command = ${JSON.stringify(spec.command)}${newline}args = ${JSON.stringify(spec.args)}${newline}`;
}

/** @param {string} text @param {readonly StdioServerSpec[]} specs */
export function inspectStdioToml(text, specs) {
    const byName = validateSpecs(specs);
    const problems = tomlStructureProblems(text);
    if (problems.length > 0) return specs.map(({ name }) => ({ name, state: "blocked", reason: `TOML structure is ambiguous (${problems.join("; ")}); repair it before migration.` }));
    const entries = positionedTomlEntries(text);
    return specs.map((spec) => assessTomlServer(spec.name, byName.get(spec.name), entries));
}

/**
 * Add missing entries and replace only exact setup-owned legacy URL entries.
 * Unsupported or foreign same-named entries are preserved and keep `ready` false.
 * @param {string} text
 * @param {readonly StdioServerSpec[]} specs
 * @returns {StdioConfigResult}
 */
export function upsertStdioToml(text, specs) {
    const byName = validateSpecs(specs);
    const inspections = inspectStdioToml(text, specs);
    const structuralBlock = inspections.some((inspection) => inspection.state === "blocked");
    if (structuralBlock) return { text, changed: false, ready: false, servers: inspections.map(({ name, reason }) => ({ name, state: "blocked", ready: false, reason })) };
    const entries = positionedTomlEntries(text);
    const assessments = new Map(specs.map((spec) => [spec.name, assessTomlServer(spec.name, byName.get(spec.name), entries)]));
    const missing = [];
    const patches = [];
    const statuses = [];
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    for (const spec of specs) {
        const assessment = assessments.get(spec.name);
        if (assessment?.state === "ready") statuses.push({ name: spec.name, state: "already-ready", ready: true });
        else if (assessment?.state === "legacy" && assessment.legacyLine !== undefined) {
            const line = assessment.legacyLine;
            const equal = line.text.indexOf("=");
            const indent = line.text.slice(0, line.text.length - line.text.trimStart().length);
            const suffix = splitTomlComment(line.text, equal + 1).suffix;
            const replacement = `${indent}command = ${JSON.stringify(spec.command)}${line.eol}${indent}args = ${JSON.stringify(spec.args)}${suffix}`;
            patches.push({ start: line.start, end: line.end, text: replacement });
            statuses.push({ name: spec.name, state: "migrated", ready: true });
        } else if (assessment?.state === "missing") {
            missing.push(spec);
            statuses.push({ name: spec.name, state: "added", ready: true });
        } else {
            statuses.push({ name: spec.name, state: "foreign", ready: false, reason: assessment?.reason ?? "The same-named server could not be classified safely." });
        }
    }
    if (missing.length > 0 && serversTableInline(text)) {
        const reason = "mcp_servers is defined as an inline table; adding child tables would be invalid, so edit these missing servers by hand.";
        for (const status of statuses) {
            if (status.state === "added") {
                status.state = "blocked";
                status.ready = false;
                status.reason = reason;
            }
        }
    } else if (missing.length > 0) {
        let addition = text.length === 0 || text.endsWith("\n") ? "" : newline;
        if (text.length > 0 && !text.endsWith(`${newline}${newline}`)) addition += newline;
        addition += missing.map((spec) => renderTomlServer(spec, newline)).join(newline);
        patches.push({ start: text.length, end: text.length, text: addition });
    }
    const output = applyPatches(text, patches);
    const ready = statuses.every((status) => status.ready);
    return { text: output, changed: output !== text, ready, servers: statuses };
}

/** @param {string} text @param {readonly StdioServerSpec[]} specs */
export function isStdioTomlReady(text, specs) {
    const inspections = inspectStdioToml(text, specs);
    return inspections.length === REQUIRED_NAMES.length && inspections.every((inspection) => inspection.state === "ready");
}

/** @param {string} text @param {JsonAgent} agent @param {readonly StdioServerSpec[]} specs */
export function inspectStdioJson(text, agent, specs) {
    return inspectJson(text, agent, specs);
}

/** @param {string} text @param {JsonAgent} agent @param {readonly StdioServerSpec[]} specs */
export function isStdioJsonReady(text, agent, specs) {
    const inspections = inspectJson(text, agent, specs);
    return inspections.length === REQUIRED_NAMES.length && inspections.every((inspection) => inspection.state === "ready");
}

/** @param {StdioAgent} agent @param {string} text @param {readonly StdioServerSpec[]} specs */
export function isStdioConfigReady(agent, text, specs) {
    if (agent === "claude" || agent === "opencode") return isStdioJsonReady(text, agent, specs);
    return isStdioTomlReady(text, specs);
}
