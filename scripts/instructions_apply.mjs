/**
 * Writes the memory-usage instructions for one agent (see agent_instructions.mjs for
 * where each agent reads them). Files the skill owns are replaced whole; files the user
 * owns (Codex's AGENTS file, Grok's and OpenCode's configs) are edited in place, changing
 * only the skill's own part. OpenCode's AGENTS.md is never created.
 */
import { grokState, opencodeInstructionsTarget } from "./agent_config_files.mjs";
import { codexInstructionsTarget, grokInstructionMode, instructionsText, withGrokExtraRuleDir, withInstructionsBlock, withOpencodeInstruction } from "./agent_instructions.mjs";
import { readIfExists, writeUserFile } from "./fs_util.mjs";

/** @typedef {ReturnType<typeof import("./layout.mjs").layout>} Layout */

/**
 * @param {"claude" | "codex" | "grok" | "opencode"} agent
 * @param {Layout} L
 * @param {{ agents: readonly string[] }} choices
 * @param {NodeJS.ProcessEnv} env for GROK_CLAUDE_RULES_ENABLED
 */
export function applyAgentInstructions(agent, L, choices, env) {
    const text = instructionsText();
    if (agent === "claude") {
        writeUserFile(L.claudeRulesFile, text);
        return;
    }
    if (agent === "grok") {
        const grok = grokState(L, env);
        const mode = grokInstructionMode({
            compatRules: grok.compatRules,
            claudeRulesAvailable: choices.agents.includes("claude") || grok.claudeRulesExists,
            claudeRulesSeenByGrok: L.claudeRulesSeenByGrok,
            importsClaudeRules: grok.importsClaudeRules,
        });
        if (mode === "unsupported") {
            throw new Error("Grok's Claude-rules setting (GROK_CLAUDE_RULES_ENABLED or compat.claude.rules) is in a form this setup cannot read; set it to true or false by hand.");
        }
        if (mode === "claude-rules") {
            // Grok reads the setup's Claude rules file: keep it current, and drop the folder entry.
            writeUserFile(L.claudeRulesFile, text);
        } else writeUserFile(L.instructionsFile, text);
        // Returns the file unchanged, before judging whether [paths] is editable, when the
        // folder entry is already as it should be.
        const next = withGrokExtraRuleDir(grok.toml, L.configDir, mode === "extra-rule-dir");
        if (next !== grok.toml) writeUserFile(L.grokConfig, next);
        return;
    }
    if (agent === "opencode") {
        writeUserFile(L.instructionsFile, text);
        const file = opencodeInstructionsTarget(L, L.opencodeInstructionsDir);
        const current = readIfExists(file) ?? "";
        const next = withOpencodeInstruction(current, L.instructionsFile);
        if (next !== current) writeUserFile(file, next);
        return;
    }
    const file = codexInstructionsTarget({ override: readIfExists(L.codexAgentsOverride) }, L);
    writeUserFile(file, withInstructionsBlock(readIfExists(file) ?? "", text));
}
