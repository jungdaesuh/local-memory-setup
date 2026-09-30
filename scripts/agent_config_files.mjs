/**
 * Which agent configuration files matter, read-only. Detection and the instruction
 * writers both use these, so they agree on where each agent looks.
 *
 * OpenCode 1.18.31 (binary strings checked): its global directory, Path.config, is
 * always ${XDG_CONFIG_HOME:-~/.config}/opencode; `opencode mcp add` writes there, to the
 * first existing of opencode.json and opencode.jsonc, and replaces an entry of the same
 * name. OPENCODE_CONFIG_DIR adds a second directory the loader reads. Within one
 * directory, config.json, opencode.json and opencode.jsonc are merged plainly (a later
 * file's key replaces an earlier one's); across directories `instructions` concatenate.
 */
import fs from "node:fs";
import path from "node:path";
import { grokClaudeRulesOn, grokExtraRuleDirs, grokPathsEditable, isClaudeRulesDir } from "./agent_instructions.mjs";
import { readIfExists } from "./fs_util.mjs";
import { jsonServerNames, parseJsonc } from "./mcp_config.mjs";

/** @typedef {ReturnType<typeof import("./layout.mjs").layout>} Layout */

/**
 * The config files OpenCode reads in `dir`, in merge order. config.json is read only in
 * its global directory (Path.config); OPENCODE_CONFIG_DIR contributes opencode.json and
 * opencode.jsonc only.
 * @param {Layout} L
 * @param {string} dir
 */
function opencodeFileNames(L, dir) {
    return dir === L.opencodeMcpDir ? ["config.json", "opencode.json", "opencode.jsonc"] : ["opencode.json", "opencode.jsonc"];
}

/**
 * OpenCode config files in one directory, in merge order, with their parsed contents.
 * @param {Layout} L
 * @param {string} dir
 */
export function opencodeFilesIn(L, dir) {
    return opencodeFileNames(L, dir).flatMap((name) => {
        const file = path.join(dir, name);
        const text = readIfExists(file);
        return text === null ? [] : [{ file, text, config: /** @type {Record<string, unknown>} */ (parseJsonc(text)) }];
    });
}

/**
 * Every MCP server name OpenCode loads, from both of its directories. A name found
 * anywhere is left alone, because `opencode mcp add` would replace it.
 * @param {Layout} L
 */
export function opencodeMcpNames(L) {
    const dirs = [...new Set([L.opencodeMcpDir, L.opencodeInstructionsDir])];
    return [...new Set(dirs.flatMap((dir) => opencodeFilesIn(L, dir).flatMap((entry) => jsonServerNames(entry.config, "mcp"))))];
}

/**
 * The `instructions` OpenCode ends up with for one directory: the last file in merge
 * order that defines the key wins.
 * @param {Layout} L
 * @param {string} dir
 * @returns {unknown[]}
 */
export function opencodeEffectiveInstructions(L, dir) {
    const defining = opencodeFilesIn(L, dir).filter((entry) => Object.hasOwn(entry.config, "instructions"));
    const last = defining.at(-1);
    return last !== undefined && Array.isArray(last.config.instructions) ? last.config.instructions : [];
}

/**
 * The file in which an `instructions` entry takes effect: the last file OpenCode reads in
 * `dir` that defines the key, else the first existing opencode.json(c), else (global
 * directory only) config.json, else a new opencode.json.
 * @param {Layout} L
 * @param {string} dir
 */
export function opencodeInstructionsTarget(L, dir) {
    const files = opencodeFilesIn(L, dir);
    const defining = files.filter((entry) => Object.hasOwn(entry.config, "instructions"));
    const preferred = files.find((entry) => /opencode\.jsonc?$/.test(entry.file));
    return defining.at(-1)?.file ?? preferred?.file ?? files[0]?.file ?? path.join(dir, "opencode.json");
}

/**
 * What Grok will read, from its config and the environment it inherits.
 * @param {Layout} L
 * @param {NodeJS.ProcessEnv} env
 */
export function grokState(L, env) {
    const toml = readIfExists(L.grokConfig) ?? "";
    const dirs = grokExtraRuleDirs(toml) ?? [];
    return {
        toml,
        compatRules: grokClaudeRulesOn(toml, env.GROK_CLAUDE_RULES_ENABLED),
        importsClaudeRules: dirs.some((entry) => isClaudeRulesDir(entry, L.home)),
        ourDirListed: dirs.includes(L.configDir),
        // The setup's Claude rules file, where Grok's compatibility or /import-claude reads it.
        claudeRulesExists: L.claudeRulesSeenByGrok && fs.existsSync(L.claudeRulesFile),
        editable: grokPathsEditable(toml),
    };
}
