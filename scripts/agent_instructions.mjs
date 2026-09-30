/**
 * Global memory-usage instructions for each connected agent: one text, and the edits
 * that make each agent load it (research: scratchpad global-instructions-research.md).
 *
 * - Claude Code loads every ${CLAUDE_CONFIG_DIR:-~/.claude}/rules/*.md: the skill owns a
 *   whole rules file holding the text.
 * - Grok reads ~/.claude/rules/*.md through its Claude compatibility (compat.claude.rules,
 *   on by default). When that already delivers the Claude rules file, nothing else is
 *   written; otherwise the instructions directory goes into [paths] extra_rule_dirs, which
 *   loads every *.md in it. Never both, or Grok reads the text twice.
 * - OpenCode has no includes in AGENTS.md; its config's "instructions" array takes
 *   absolute paths. Creating ~/.config/opencode/AGENTS.md is avoided: the first existing
 *   of [that file, ~/.claude/CLAUDE.md] wins, so it would hide the user's CLAUDE.md.
 * - Codex has no includes: the text goes inline, between markers, in the global file Codex
 *   reads ($CODEX_HOME/AGENTS.override.md when non-empty, else AGENTS.md).
 *
 * Tool names are LongMemory's MCP tools (src/mcp/tools, docs/mcp.md) and QMD 2.5.3's
 * (dist/mcp/server.js), under the server names this setup registers: qmd, longmemory.
 */
import { MARKER } from "./layout.mjs";
import { assertTomlWritable, parseJsonc, tomlEntries } from "./mcp_config.mjs";

export const BLOCK_BEGIN = `<!-- ${MARKER}:begin -->`;
export const BLOCK_END = `<!-- ${MARKER}:end -->`;

/**
 * How agents name the project in every LongMemory call. The same normalization as
 * LongMemory's own default (src/mcp/runtime.ts current_project: basename, lowercased,
 * runs outside [a-z0-9._-] replaced by "-"), applied to the git repository root, so every
 * session in a repository reads and writes the same project. Without an explicit id the
 * server would use its own working directory, which is the same for every repository.
 */
export const PROJECT_ID_RULE =
    "the name of the git repository's root folder (or of the current folder outside a repository), lowercased, with every run of characters other than a-z, 0-9, `.`, `_`, and `-` replaced by a single `-`";

/** The instructions, as every agent receives them. */
export function instructionsText() {
    return [
        "# Local memory (QMD and LongMemory)",
        "",
        `<!-- Managed by ${MARKER}; changes here are replaced on the next setup run. -->`,
        "",
        "This machine runs two local MCP servers: `qmd` (search over the user's notes) and `longmemory` (memory that persists between sessions). Both stay on this computer.",
        "",
        "## Project id",
        "",
        `Every LongMemory call below passes \`project_id\`: ${PROJECT_ID_RULE}. Use the same value for the whole session, so what one session stores the next one finds.`,
        "",
        "## At session start",
        "",
        "- Call `longmemory_project_context` with `project_id`, the current `task`, and a `mode` (`coding`, `debugging`, `planning`, or `review`), or `longmemory_recall` with `project_id`, a `query`, and `mode: \"strict\"`, to load what earlier sessions learned about this project and task.",
        "",
        "## Evidence order",
        "",
        "1. The live repository, its git history, and its tests.",
        "2. QMD: `query` with `searches` of type `lex` (exact words) and `vec` (meaning), then `get` for the full text of a hit.",
        "3. LongMemory: what earlier sessions remembered. Treat it as a lead to verify, not as proof.",
        "",
        "## What to store",
        "",
        "- Decisions: `longmemory_remember_decision` with `project_id`, `decision`, and `reason` (and `alternatives_rejected` when there were any).",
        "- Preferences and gotchas: `longmemory_ingest` with `text` and `source: \"agent\"`, plus `project_id` when the note is about this project. Phrase preferences as \"User prefers …\".",
        "- Durable facts worth searching later: a markdown note in a folder QMD indexes. After editing indexed notes, run `qmd update`, then `qmd embed`.",
        "- Never store secrets, credentials, or the contents of .env files, in either server.",
        "",
    ].join("\n");
}

/** Tool names the instructions tell agents to call, in the order the text names them. */
export function instructedLongMemoryTools() {
    const named = instructionsText().match(/`longmemory_[a-z0-9_]+`/g) ?? [];
    return [...new Set(named.map((token) => token.slice(1, -1)))];
}

/* ------------------------------------------------------------ Codex marker block */

/**
 * `text` with exactly one instructions block. An existing block is replaced where it
 * stands; everything outside the markers is kept byte for byte; a file without a block
 * gets it appended. Unbalanced markers are refused rather than guessed at.
 * @param {string} text current file contents ("" when absent)
 * @param {string} body
 */
export function withInstructionsBlock(text, body) {
    const block = `${BLOCK_BEGIN}\n${body.endsWith("\n") ? body : `${body}\n`}${BLOCK_END}`;
    const begins = text.split(BLOCK_BEGIN).length - 1;
    const ends = text.split(BLOCK_END).length - 1;
    if (begins !== ends) throw new Error(`The file has ${begins} "${BLOCK_BEGIN}" and ${ends} "${BLOCK_END}" markers; fix them by hand.`);
    if (begins === 0) {
        if (text.length === 0) return `${block}\n`;
        return `${text}${text.endsWith("\n") ? "" : "\n"}\n${block}\n`;
    }
    // Replace the first block in place and drop any later duplicate (markers included).
    let out = "";
    let rest = text;
    let placed = false;
    for (let start = rest.indexOf(BLOCK_BEGIN); start >= 0; start = rest.indexOf(BLOCK_BEGIN)) {
        const end = rest.indexOf(BLOCK_END, start);
        if (end < 0) throw new Error(`"${BLOCK_BEGIN}" without a following "${BLOCK_END}"; fix it by hand.`);
        out += rest.slice(0, start) + (placed ? "" : block);
        placed = true;
        rest = rest.slice(end + BLOCK_END.length);
    }
    return out + rest;
}

/**
 * Whether `text` holds exactly one instructions block, current with `body`.
 * @param {string} text
 * @param {string} body
 */
export function instructionsBlockCurrent(text, body) {
    const count = (marker) => text.split(marker).length - 1;
    return count(BLOCK_BEGIN) === 1 && count(BLOCK_END) === 1 && text.indexOf(BLOCK_BEGIN) < text.indexOf(BLOCK_END) && withInstructionsBlock(text, body) === text;
}

/**
 * The global instructions file Codex reads: AGENTS.override.md when it exists and is
 * non-empty, else AGENTS.md (codex-rs codex-home/src/instructions load_from_codex_home).
 * @param {{ override: string | null }} files override file contents, or null when absent
 * @param {{ codexAgents: string, codexAgentsOverride: string }} paths
 */
export function codexInstructionsTarget(files, paths) {
    return files.override !== null && files.override.trim().length > 0 ? paths.codexAgentsOverride : paths.codexAgents;
}

/* ------------------------------------------------------------ Grok */

/**
 * Whether Grok's Claude compatibility loads ~/.claude/rules/*.md. Grok resolves settings
 * as environment variable, then config.toml, then default (05-configuration.md):
 * GROK_CLAUDE_RULES_ENABLED, then `compat.claude.rules` (26-config-reference.md), default
 * on. A form this reader cannot model safely (an inline table holding the setting, an
 * array-of-tables header, a non-boolean value) is "unsupported" rather than a guess.
 * @param {string} toml
 * @param {string | undefined} envValue GROK_CLAUDE_RULES_ENABLED
 * @returns {boolean | "unsupported"}
 */
export function grokClaudeRulesOn(toml, envValue) {
    const fromEnv = envValue?.trim().toLowerCase();
    if (fromEnv !== undefined && fromEnv !== "") {
        if (["1", "true", "yes", "on"].includes(fromEnv)) return true;
        if (["0", "false", "no", "off"].includes(fromEnv)) return false;
        return "unsupported";
    }
    for (const entry of tomlEntries(toml)) {
        if (entry.kind === "header") {
            if (entry.array && (entry.path === "compat" || entry.path.startsWith("compat."))) return "unsupported";
            continue;
        }
        if (entry.path === "compat.claude.rules") {
            if (/^true\b/.test(entry.rest)) return true;
            if (/^false\b/.test(entry.rest)) return false;
            return "unsupported";
        }
        if ((entry.path === "compat" || entry.path === "compat.claude") && entry.rest.startsWith("{")) return "unsupported";
    }
    return true;
}

/**
 * Whether an extra_rule_dirs entry is ~/.claude/rules, which /import-claude writes
 * there so Claude's rules keep loading with the compatibility scan off
 * (12-project-rules.md). Entries are absolute or start with `~/`.
 * @param {string} entry
 * @param {string} home
 */
export function isClaudeRulesDir(entry, home) {
    const trimmed = entry.replace(/[\\/]+$/, "");
    return trimmed === "~/.claude/rules" || trimmed === `${home}/.claude/rules` || trimmed === `${home}\\.claude\\rules`;
}

/**
 * How Grok gets the instructions, decided by what Grok will actually read:
 * - "claude-rules": the setup's Claude rules file exists (or is being written) in the
 *   ~/.claude/rules Grok reads, and Grok loads that folder, through its compatibility
 *   scan or an extra_rule_dirs entry for it (after /import-claude). Nothing else is added.
 * - "extra-rule-dir": otherwise; the setup's own folder goes into extra_rule_dirs.
 * - "unsupported": Grok's setting cannot be read safely; the user edits by hand.
 * Never both routes, or Grok reads the text twice.
 * @param {{ compatRules: boolean | "unsupported", claudeRulesAvailable: boolean, claudeRulesSeenByGrok: boolean, importsClaudeRules: boolean }} state
 * @returns {"claude-rules" | "extra-rule-dir" | "unsupported"}
 */
export function grokInstructionMode(state) {
    const claudeFileReachable = state.claudeRulesAvailable && state.claudeRulesSeenByGrok;
    if (claudeFileReachable && state.importsClaudeRules) return "claude-rules";
    if (state.compatRules === "unsupported") return "unsupported";
    return claudeFileReachable && state.compatRules ? "claude-rules" : "extra-rule-dir";
}

/**
 * Whether the setup can edit `[paths] extra_rule_dirs` safely: the key, if present, is a
 * bare key under a `[paths]` header, and nothing defines `paths` another way (inline
 * table, root dotted `paths.*` keys, array-of-tables headers).
 * @param {string} toml
 */
export function grokPathsEditable(toml) {
    for (const entry of tomlEntries(toml)) {
        if (entry.kind === "header") {
            if (entry.array && (entry.path === "paths" || entry.path.startsWith("paths."))) return false;
            continue;
        }
        if (entry.path === "paths") return false;
        if (entry.table === "" && entry.path.startsWith("paths.")) return false;
        if (entry.path === "paths.extra_rule_dirs" && (!entry.bare || entry.table !== "paths" || !entry.rest.startsWith("["))) return false;
    }
    return true;
}

/**
 * The strings in `[paths] extra_rule_dirs`, or null when the key is absent.
 * @param {string} toml
 * @returns {string[] | null}
 */
export function grokExtraRuleDirs(toml) {
    const found = findExtraRuleDirs(toml);
    if (found === null) return null;
    return JSON.parse(`[${stripTomlArray(found.inner)}]`);
}

/**
 * @param {string} toml
 * @returns {{ start: number, end: number, inner: string } | null} offsets of the array's brackets
 */
function findExtraRuleDirs(toml) {
    let table = "";
    let offset = 0;
    for (const line of toml.split("\n")) {
        const header = /^\s*\[\s*([A-Za-z0-9_.-]+)\s*\]\s*(?:#.*)?$/.exec(line);
        if (header) table = header[1];
        else {
            const entry = /^(\s*)([A-Za-z0-9_-]+)\s*=\s*\[/.exec(line);
            if (entry && table === "paths" && entry[2] === "extra_rule_dirs") {
                const start = offset + entry[0].length - 1;
                const end = matchingBracket(toml, start);
                return { start, end, inner: toml.slice(start + 1, end) };
            }
        }
        offset += line.length + 1;
    }
    return null;
}

/** @param {string} text @param {number} open index of "[" */
function matchingBracket(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
        const char = text[i];
        if (char === '"' || char === "'") {
            const close = text.indexOf(char, i + 1);
            if (close < 0) break;
            i = close;
        } else if (char === "#") {
            const newline = text.indexOf("\n", i);
            i = newline < 0 ? text.length : newline;
        } else if (char === "[") depth += 1;
        else if (char === "]" && --depth === 0) return i;
    }
    throw new Error("Unterminated extra_rule_dirs array in Grok's config.toml; fix it by hand.");
}

/**
 * A TOML basic string's escapes resolved (\b \t \n \f \r \" \\ \uXXXX \UXXXXXXXX,
 * TOML 1.0 "Strings"). An invalid escape is an error, as in any TOML parser.
 * @param {string} body the characters between the quotes
 */
export function tomlBasicString(body) {
    const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    return body.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_match, code) => {
        if (code.length > 1) return String.fromCodePoint(Number.parseInt(code.slice(1), 16));
        if (Object.hasOwn(simple, code)) return simple[/** @type {keyof typeof simple} */ (code)];
        throw new Error(`Invalid TOML escape \\${code}`);
    });
}

/**
 * Array body as JSON: comments dropped, TOML basic and literal strings decoded and
 * re-encoded as JSON strings, trailing comma removed.
 * @param {string} inner
 */
function stripTomlArray(inner) {
    const items = [];
    for (const match of inner.matchAll(/"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|#[^\n]*/g)) {
        if (match[0].startsWith("#")) continue;
        items.push(JSON.stringify(match[1] !== undefined ? tomlBasicString(match[1]) : match[2]));
    }
    return items.join(",");
}

/**
 * Grok's config.toml with `dir` present or absent in `[paths] extra_rule_dirs`, leaving
 * every other entry and line as it is. Forms that cannot be edited safely are refused,
 * and the result is checked for TOML structure errors before it is returned.
 * @param {string} toml
 * @param {string} dir
 * @param {boolean} present
 */
export function withGrokExtraRuleDir(toml, dir, present) {
    const found = findExtraRuleDirs(toml);
    const current = found === null ? [] : grokExtraRuleDirs(toml) ?? [];
    // Nothing to change: return before judging whether the file could be edited.
    if (current.includes(dir) === present) return toml;
    if (!grokPathsEditable(toml)) throw new Error("Grok's config.toml defines [paths] in a form this setup does not edit (inline table, dotted or quoted keys); edit extra_rule_dirs by hand.");
    let next;
    if (found === null) {
        const headerMatch = /^\s*\[\s*paths\s*\]\s*(?:#.*)?$/m.exec(toml);
        const line = `extra_rule_dirs = [${JSON.stringify(dir)}]`;
        if (headerMatch) {
            const at = headerMatch.index + headerMatch[0].length;
            next = `${toml.slice(0, at)}\n${line}${toml.slice(at)}`;
        } else {
            const base = toml.length === 0 || toml.endsWith("\n") ? toml : `${toml}\n`;
            next = `${base}${base.length === 0 ? "" : "\n"}[paths]\n${line}\n`;
        }
    } else {
        const entries = present ? [...current, dir] : current.filter((entry) => entry !== dir);
        next = `${toml.slice(0, found.start)}[${entries.map((entry) => JSON.stringify(entry)).join(", ")}]${toml.slice(found.end + 1)}`;
    }
    assertTomlWritable("Grok's config.toml", toml, next);
    return next;
}

/* ------------------------------------------------------------ OpenCode */

/**
 * OpenCode's config text with `file` in its top-level "instructions" array, comments and
 * formatting elsewhere kept. The result is parsed back and checked.
 * @param {string} text opencode.json or opencode.jsonc contents ("" when absent)
 * @param {string} file absolute path
 */
export function withOpencodeInstruction(text, file) {
    const source = text.trim().length === 0 ? "{}\n" : text;
    const config = /** @type {Record<string, unknown>} */ (parseJsonc(source));
    const existing = config.instructions;
    if (existing !== undefined && !Array.isArray(existing)) throw new Error('OpenCode\'s "instructions" is not an array; edit it by hand.');
    if (Array.isArray(existing) && existing.includes(file)) return text;
    const value = JSON.stringify(file);
    const key = findTopLevelKey(source, "instructions");
    let next;
    if (key === null) {
        const open = source.indexOf("{");
        const hasMembers = Object.keys(config).length > 0;
        next = `${source.slice(0, open + 1)}\n  "instructions": [${value}]${hasMembers ? "," : ""}${source.slice(open + 1)}`;
    } else {
        const close = matchingJsonBracket(source, key.valueStart);
        const inner = source.slice(key.valueStart + 1, close);
        const empty = (Array.isArray(existing) ? existing : []).length === 0;
        const trailingComma = /,\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*$/.test(inner);
        const separator = empty || trailingComma ? "" : ", ";
        next = `${source.slice(0, close)}${separator}${value}${source.slice(close)}`;
    }
    const check = /** @type {Record<string, unknown>} */ (parseJsonc(next)).instructions;
    if (!Array.isArray(check) || !check.includes(file)) throw new Error("Could not add the instructions file to OpenCode's config safely; add it by hand.");
    return next;
}

/**
 * Position of a top-level key's value in a JSONC object, skipping strings and comments.
 * @param {string} text
 * @param {string} name
 * @returns {{ valueStart: number } | null}
 */
function findTopLevelKey(text, name) {
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (text.startsWith("//", i)) i = text.includes("\n", i) ? text.indexOf("\n", i) : text.length;
        else if (text.startsWith("/*", i)) i = text.indexOf("*/", i + 2) + 1;
        else if (char === '"') {
            const end = stringEnd(text, i);
            if (depth === 1 && JSON.parse(text.slice(i, end + 1)) === name) {
                const colon = /^\s*:\s*/.exec(text.slice(end + 1));
                if (colon) return { valueStart: end + 1 + colon[0].length };
            }
            i = end;
        } else if (char === "{" || char === "[") depth += 1;
        else if (char === "}" || char === "]") depth -= 1;
    }
    return null;
}

/** @param {string} text @param {number} start index of the opening quote */
function stringEnd(text, start) {
    let i = start + 1;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    return i;
}

/** @param {string} text @param {number} open index of "[" */
function matchingJsonBracket(text, open) {
    if (text[open] !== "[") throw new Error('OpenCode\'s "instructions" is not an array; edit it by hand.');
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
        if (text.startsWith("//", i)) i = text.includes("\n", i) ? text.indexOf("\n", i) : text.length;
        else if (text.startsWith("/*", i)) i = text.indexOf("*/", i + 2) + 1;
        else if (text[i] === '"') i = stringEnd(text, i);
        else if (text[i] === "[") depth += 1;
        else if (text[i] === "]" && --depth === 0) return i;
    }
    throw new Error('Unterminated "instructions" array in OpenCode\'s config.');
}
