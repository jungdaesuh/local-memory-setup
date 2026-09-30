/**
 * Memory-usage instructions per agent: the text, where each agent reads it, how each
 * agent's config is edited and detected, and the agents' directory variables. File tests
 * run only in fake HOME and CODEX_HOME / GROK_HOME / OPENCODE_CONFIG_DIR /
 * CLAUDE_CONFIG_DIR / XDG_CONFIG_HOME trees.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { opencodeEffectiveInstructions, opencodeInstructionsTarget, opencodeMcpNames } from "./agent_config_files.mjs";
import {
    BLOCK_BEGIN,
    BLOCK_END,
    PROJECT_ID_RULE,
    codexInstructionsTarget,
    grokClaudeRulesOn,
    grokExtraRuleDirs,
    grokInstructionMode,
    grokPathsEditable,
    instructionsBlockCurrent,
    instructionsText,
    instructedLongMemoryTools,
    isClaudeRulesDir,
    withGrokExtraRuleDir,
    withInstructionsBlock,
    withOpencodeInstruction,
} from "./agent_instructions.mjs";
import { detectAgents, detectInstructions } from "./detect.mjs";
import { applyAgentInstructions } from "./instructions_apply.mjs";
import { layout } from "./layout.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { parseJsonc, tomlStructureProblems } from "./mcp_config.mjs";

const TEXT = instructionsText();
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* ------------------------------------------------------------ instructions text */

// The tools LongMemory registers (docs/mcp.md "Tools", src/mcp/tools/*.ts) and QMD
// 2.5.3 serves (dist/mcp/server.js), listed from those sources, not from the text under test.
const LONGMEMORY_TOOLS = [
    "longmemory_project_context", "longmemory_recall", "longmemory_ingest", "longmemory_remember_decision",
    "longmemory_update_task_state", "longmemory_explain", "longmemory_report_conflicts", "longmemory_sync_connector",
    "longmemory_match_skills", "longmemory_manage_skill", "longmemory_code_graph", "longmemory_asset_catalog", "longmemory_manage_asset",
];
// Tools whose schema (src/mcp/schemas/tool_schemas.ts) takes a project_id.
const TAKES_PROJECT_ID = ["longmemory_project_context", "longmemory_recall", "longmemory_ingest", "longmemory_remember_decision"];

test("every LongMemory tool the instructions name is one LongMemory registers", () => {
    const named = instructedLongMemoryTools();
    assert.deepEqual(named, ["longmemory_project_context", "longmemory_recall", "longmemory_remember_decision", "longmemory_ingest"]);
    for (const tool of named) assert.ok(LONGMEMORY_TOOLS.includes(tool), `${tool} is not a LongMemory tool`);
    // QMD 2.5.3 dist/mcp/server.js: tools query, get, multi_get, status; query takes searches of type lex, vec, hyde.
    const qmdLine = TEXT.split("\n").find((line) => line.includes("QMD: "));
    const qmdNamed = [...(qmdLine ?? "").matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
    for (const word of qmdNamed) assert.ok(["query", "get", "multi_get", "status", "searches", "lex", "vec", "hyde"].includes(word), `QMD line names ${word}`);
    assert.ok(qmdNamed.includes("query") && qmdNamed.includes("get"));
    assert.match(TEXT, /Never store secrets, credentials, or the contents of \.env files/);
    assert.ok(!TEXT.includes(BLOCK_BEGIN) && !TEXT.includes(BLOCK_END));
});

test("every instruction line that calls a project-scoped tool passes project_id, with one stated rule", () => {
    // Each mention is checked on its own clause: the text from the tool's name to the next tool's name.
    const clauses = TEXT.split(/(?=`longmemory_[a-z_]+`)/);
    let checked = 0;
    for (const clause of clauses) {
        const tool = /^`(longmemory_[a-z_]+)`/.exec(clause)?.[1];
        if (tool === undefined || !TAKES_PROJECT_ID.includes(tool)) continue;
        assert.match(clause.split("\n")[0], /`project_id`/, `${tool} without project_id: ${clause.split("\n")[0]}`);
        checked += 1;
    }
    assert.equal(checked, 4);
    assert.ok(TEXT.includes(PROJECT_ID_RULE));
});

// LongMemory's own default project id, vendored verbatim from src/mcp/runtime.ts:44.
// The next test checks this copy against origin/main of the read-only upstream clone.
const RUNTIME_TS_LINE = 44;
const CURRENT_PROJECT_SOURCE = "const current_project = (cwd: string) => basename(resolve(cwd)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'current';";

test("the project_id rule states LongMemory's own current_project normalization", () => {
    const upstream = /basename\(resolve\(cwd\)\)\.toLowerCase\(\)\.replace\(\/\[\^([^\]]+)\]\+\/g, '(.)'\)/.exec(CURRENT_PROJECT_SOURCE);
    assert.ok(upstream !== null, "runtime.ts no longer has the form this test reads");
    const [, keptClass, replacement] = upstream;
    // The rule's words, read back into a character class: "other than a-z, 0-9, `.`, `_`, and `-` replaced by a single `-`".
    const stated = /lowercased, with every run of characters other than (.+) replaced by a single `(.)`$/.exec(PROJECT_ID_RULE);
    assert.ok(stated !== null, PROJECT_ID_RULE);
    const statedClass = stated[1]
        .replace(/,? and /, ", ")
        .split(", ")
        .map((part) => part.replaceAll("`", ""))
        .join("");
    assert.equal(statedClass, keptClass);
    assert.equal(stated[2], replacement);
});

const LONGMEMORY_UPSTREAM = process.env.LONGMEMORY_CHECKOUT ?? "/home/jungdaesuh/code/opensource/OpenMemory";
const hasUpstreamRuntime =
    fs.existsSync(LONGMEMORY_UPSTREAM) && spawnSync("git", ["-C", LONGMEMORY_UPSTREAM, "cat-file", "-e", "origin/main:src/mcp/runtime.ts"], { stdio: "ignore" }).status === 0;
test(
    "the vendored current_project line is origin/main's runtime.ts line, read with git show",
    { skip: !hasUpstreamRuntime && `no origin/main runtime.ts at ${LONGMEMORY_UPSTREAM} (set LONGMEMORY_CHECKOUT)` },
    () => {
        const source = execFileSync("git", ["-C", LONGMEMORY_UPSTREAM, "show", "origin/main:src/mcp/runtime.ts"], { encoding: "utf8" });
        assert.equal(source.split("\n")[RUNTIME_TS_LINE - 1], CURRENT_PROJECT_SOURCE);
    },
);

/* ------------------------------------------------------------ Codex marker block */

test("the Codex block is inserted once, replaced in place, and everything outside it is kept byte for byte", () => {
    const before = "# My rules\r\n\r\nAlways run tests.\n";
    const once = withInstructionsBlock(before, TEXT);
    assert.ok(once.startsWith(before));
    assert.equal(once.split(BLOCK_BEGIN).length - 1, 1);
    assert.equal(withInstructionsBlock(once, TEXT), once);
    assert.ok(instructionsBlockCurrent(once, TEXT));
    const stale = `top\n${BLOCK_BEGIN}\nold text\n${BLOCK_END}\nbottom\n`;
    const replaced = withInstructionsBlock(stale, TEXT);
    assert.ok(replaced.startsWith("top\n") && replaced.endsWith("\nbottom\n"));
    assert.ok(!replaced.includes("old text"));
    const doubled = `${BLOCK_BEGIN}\na\n${BLOCK_END}\nmiddle\n${BLOCK_BEGIN}\nb\n${BLOCK_END}\n`;
    const single = withInstructionsBlock(doubled, TEXT);
    assert.equal(single.split(BLOCK_BEGIN).length - 1, 1);
    assert.ok(single.includes("\nmiddle\n"));
    assert.throws(() => withInstructionsBlock(`${BLOCK_BEGIN}\nno end\n`, TEXT), /markers; fix them by hand/);
    assert.equal(instructionsBlockCurrent(`${BLOCK_BEGIN}\nno end\n`, TEXT), false);
    assert.equal(withInstructionsBlock("", TEXT), `${BLOCK_BEGIN}\n${TEXT}${BLOCK_END}\n`);
});

test("Codex's target is AGENTS.override.md when it exists and is non-empty, else AGENTS.md", () => {
    const paths = { codexAgents: "/c/AGENTS.md", codexAgentsOverride: "/c/AGENTS.override.md" };
    assert.equal(codexInstructionsTarget({ override: null }, paths), "/c/AGENTS.md");
    assert.equal(codexInstructionsTarget({ override: "  \n" }, paths), "/c/AGENTS.md");
    assert.equal(codexInstructionsTarget({ override: "rules" }, paths), "/c/AGENTS.override.md");
});

/* ------------------------------------------------------------ Grok settings */

test("Grok's Claude-rules setting: environment first, then config.toml, else on; unreadable forms are not guessed", () => {
    assert.equal(grokClaudeRulesOn("", undefined), true);
    assert.equal(grokClaudeRulesOn("[compat.claude]\nrules = false\n", undefined), false);
    assert.equal(grokClaudeRulesOn("compat.claude.rules = false\n", undefined), false);
    assert.equal(grokClaudeRulesOn('[compat]\n"claude".rules = false\n', undefined), false);
    assert.equal(grokClaudeRulesOn('["compat"."claude"]\n"rules" = false\n', undefined), false);
    assert.equal(grokClaudeRulesOn("[compat.claude]\nagents = false\nrules = true\n", undefined), true);
    // GROK_CLAUDE_RULES_ENABLED wins over the file (Grok: env > config.toml > default).
    assert.equal(grokClaudeRulesOn("[compat.claude]\nrules = true\n", "0"), false);
    assert.equal(grokClaudeRulesOn("[compat.claude]\nrules = false\n", "true"), true);
    for (const form of ["[compat]\nclaude = { rules = false }\n", "compat = { claude = { rules = false } }\n", "[compat.claude]\nrules = \"no\"\n"]) {
        assert.equal(grokClaudeRulesOn(form, undefined), "unsupported", form);
    }
    assert.equal(grokClaudeRulesOn("", "maybe"), "unsupported");
});

test("Grok's mode follows what it will read: Claude's rules file through compat or /import-claude, else the setup's folder", () => {
    const base = { compatRules: /** @type {boolean | "unsupported"} */ (true), claudeRulesAvailable: true, claudeRulesSeenByGrok: true, importsClaudeRules: false };
    assert.equal(grokInstructionMode(base), "claude-rules");
    assert.equal(grokInstructionMode({ ...base, compatRules: false }), "extra-rule-dir");
    // /import-claude: compat off, ~/.claude/rules listed in extra_rule_dirs: Grok still reads the Claude file.
    assert.equal(grokInstructionMode({ ...base, compatRules: false, importsClaudeRules: true }), "claude-rules");
    assert.equal(grokInstructionMode({ ...base, claudeRulesAvailable: false }), "extra-rule-dir");
    assert.equal(grokInstructionMode({ ...base, claudeRulesSeenByGrok: false }), "extra-rule-dir");
    assert.equal(grokInstructionMode({ ...base, compatRules: "unsupported" }), "unsupported");
    assert.ok(isClaudeRulesDir("~/.claude/rules/", "/home/a") && isClaudeRulesDir("/home/a/.claude/rules", "/home/a"));
    assert.equal(isClaudeRulesDir("/home/a/.claude", "/home/a"), false);
});

test("extra_rule_dirs gains or loses exactly the setup's folder; unsafe forms are refused and output stays valid", () => {
    const dir = "/home/a/.config/local-memory-setup";
    assert.equal(withGrokExtraRuleDir("", dir, true), `[paths]\nextra_rule_dirs = ["${dir}"]\n`);
    const withOthers = '[ui]\ntheme = "dark"\n\n[paths]\nextra_rule_dirs = ["/x", \'/y\'] # mine\n';
    const added = withGrokExtraRuleDir(withOthers, dir, true);
    assert.deepEqual(grokExtraRuleDirs(added), ["/x", "/y", dir]);
    assert.ok(added.startsWith('[ui]\ntheme = "dark"\n\n[paths]\n') && added.endsWith(" # mine\n"));
    assert.equal(withGrokExtraRuleDir(added, dir, true), added);
    assert.deepEqual(grokExtraRuleDirs(withGrokExtraRuleDir(added, dir, false)), ["/x", "/y"]);
    assert.deepEqual(grokExtraRuleDirs(withGrokExtraRuleDir("[paths]\nother = 1\n", dir, true)), [dir]);
    const multi = '[paths]\nextra_rule_dirs = [\n  "/x", # first\n  "/y",\n]\n';
    assert.deepEqual(grokExtraRuleDirs(withGrokExtraRuleDir(multi, dir, true)), ["/x", "/y", dir]);
    for (const form of [
        "paths = { extra_rule_dirs = [] }\n",
        '[paths]\n"extra_rule_dirs" = ["/x"]\n',
        'paths.extra_skill_dirs = ["/s"]\n',
        "[[paths]]\nx = 1\n",
    ]) {
        assert.equal(grokPathsEditable(form), false, form);
        assert.throws(() => withGrokExtraRuleDir(form, dir, true), /edit extra_rule_dirs by hand/, form);
    }
    for (const out of [added, withGrokExtraRuleDir("", dir, true), withGrokExtraRuleDir("[paths]\nother = 1\n", dir, true)]) assert.deepEqual(tomlStructureProblems(out), []);
});

test("the TOML structure check catches what a TOML parser rejects", () => {
    assert.deepEqual(tomlStructureProblems('[a]\nx = 1\n[b]\ny = "z"\n'), []);
    assert.match(tomlStructureProblems("[a]\n[a]\n").join(), /declared twice/);
    assert.match(tomlStructureProblems("x = 1\nx = 2\n").join(), /assigned twice/);
    assert.match(tomlStructureProblems('paths.extra = ["/s"]\n[paths]\nx = 1\n').join(), /already defined by a key/);
    assert.match(tomlStructureProblems('[paths]\n"extra_rule_dirs" = []\nextra_rule_dirs = []\n').join(), /assigned twice/);
});

/* ------------------------------------------------------------ OpenCode */

test("OpenCode's instructions list gains the file, with comments and other settings kept", () => {
    const file = "/home/a/.config/local-memory-setup/agent-instructions.md";
    const jsonc = '{\n  // my settings\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": { "qmd": { "type": "remote", "url": "u" } }, /* keep */\n}\n';
    const added = withOpencodeInstruction(jsonc, file);
    assert.ok(added.includes("// my settings") && added.includes("/* keep */"));
    assert.deepEqual(/** @type {{ instructions: string[] }} */ (parseJsonc(added)).instructions, [file]);
    assert.equal(withOpencodeInstruction(added, file), added);
    const existing = '{ "instructions": ["CONTRIBUTING.md", "~/rules/*.md",] }';
    assert.deepEqual(/** @type {{ instructions: string[] }} */ (parseJsonc(withOpencodeInstruction(existing, file))).instructions, ["CONTRIBUTING.md", "~/rules/*.md", file]);
    assert.deepEqual(/** @type {{ instructions: string[] }} */ (parseJsonc(withOpencodeInstruction("", file))).instructions, [file]);
    assert.throws(() => withOpencodeInstruction('{"instructions": "one.md"}', file), /not an array/);
});

/** A fake home with every agent directory moved by its variable. */
function fakeTree() {
    const root = tempDir("lms-agents-");
    const env = {
        CLAUDE_CONFIG_DIR: path.join(root, "claude-cfg"),
        CODEX_HOME: path.join(root, "codex-home"),
        GROK_HOME: path.join(root, "grok-home"),
        OPENCODE_CONFIG_DIR: path.join(root, "opencode-cfg"),
        XDG_CONFIG_HOME: path.join(root, "xdg"),
    };
    return { root, env, L: layout("linux", path.join(root, "home"), env) };
}

test("layout honours each agent's directory variable, and OpenCode's MCP directory stays its global one", () => {
    const { env, L } = fakeTree();
    assert.equal(L.claudeRulesFile, path.join(env.CLAUDE_CONFIG_DIR, "rules", "local-memory-setup.md"));
    assert.equal(L.claudeJson, path.join(env.CLAUDE_CONFIG_DIR, ".claude.json"));
    assert.equal(L.claudeRulesSeenByGrok, false);
    assert.equal(L.codexConfig, path.join(env.CODEX_HOME, "config.toml"));
    assert.equal(L.grokConfig, path.join(env.GROK_HOME, "config.toml"));
    // `opencode mcp add` writes to Path.config, which OPENCODE_CONFIG_DIR does not move.
    assert.equal(L.opencodeMcpDir, path.join(env.XDG_CONFIG_HOME, "opencode"));
    assert.equal(L.opencodeInstructionsDir, env.OPENCODE_CONFIG_DIR);
    const plain = layout("linux", "/home/a", {});
    assert.equal(plain.claudeJson, "/home/a/.claude.json");
    assert.equal(plain.opencodeMcpDir, "/home/a/.config/opencode");
    assert.equal(plain.opencodeInstructionsDir, "/home/a/.config/opencode");
    assert.equal(plain.claudeRulesSeenByGrok, true);
});

test("OpenCode servers in the global directory count as wired when OPENCODE_CONFIG_DIR is set, so a user's entry is never re-added", () => {
    const { L } = fakeTree();
    fs.mkdirSync(L.opencodeMcpDir, { recursive: true });
    // The user's own qmd (another port) and a longmemory entry, where `opencode mcp add` writes.
    fs.writeFileSync(path.join(L.opencodeMcpDir, "opencode.json"), JSON.stringify({ mcp: { qmd: { type: "remote", url: "http://localhost:9999/mcp" } } }));
    fs.mkdirSync(L.opencodeInstructionsDir, { recursive: true });
    fs.writeFileSync(path.join(L.opencodeInstructionsDir, "opencode.jsonc"), '{ "mcp": { "longmemory": { "type": "remote", "url": "u" } } }');
    assert.deepEqual(opencodeMcpNames(L).sort(), ["longmemory", "qmd"]);
    const opencode = detectAgents(L, () => new Set(["opencode"])).agents.opencode;
    assert.equal(opencode.qmd, true);
    assert.equal(opencode.longmemory, true);
});

test("within one OpenCode folder the last file defining instructions wins, and the setup writes there", () => {
    const { L } = fakeTree();
    const dir = L.opencodeInstructionsDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "opencode.json"), '{ "instructions": ["a.md"] }');
    fs.writeFileSync(path.join(dir, "opencode.jsonc"), '{ "instructions": ["b.md"] }');
    assert.deepEqual(opencodeEffectiveInstructions(L, dir), ["b.md"]);
    assert.equal(opencodeInstructionsTarget(L, dir), path.join(dir, "opencode.jsonc"));
    const empty = fakeTree().L;
    assert.equal(opencodeInstructionsTarget(empty, empty.opencodeInstructionsDir), path.join(empty.opencodeInstructionsDir, "opencode.json"));
});

test("in OPENCODE_CONFIG_DIR, which OpenCode reads only opencode.json(c) from, config.json is never written or counted", () => {
    const { L } = fakeTree();
    const dir = L.opencodeInstructionsDir;
    fs.mkdirSync(dir, { recursive: true });
    const configJson = '{ "theme": "x", "instructions": ["ignored.md"] }';
    fs.writeFileSync(path.join(dir, "config.json"), configJson);
    assert.deepEqual(opencodeEffectiveInstructions(L, dir), []);
    assert.equal(opencodeInstructionsTarget(L, dir), path.join(dir, "opencode.json"));
    applyAgentInstructions("opencode", L, { agents: ["opencode"] }, {});
    assert.equal(fs.readFileSync(path.join(dir, "config.json"), "utf8"), configJson);
    assert.deepEqual(/** @type {{ instructions: string[] }} */ (parseJsonc(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"))).instructions, [L.instructionsFile]);
    assert.equal(detectInstructions(L, {}).opencodeListed, true);
    // In OpenCode's global directory config.json is read, and an instructions list there is used.
    const global = fakeTree().L;
    const plain = layout("linux", path.dirname(path.dirname(global.opencodeMcpDir)), {});
    fs.mkdirSync(plain.opencodeMcpDir, { recursive: true });
    fs.writeFileSync(path.join(plain.opencodeMcpDir, "config.json"), '{ "instructions": ["a.md"] }');
    assert.equal(opencodeInstructionsTarget(plain, plain.opencodeMcpDir), path.join(plain.opencodeMcpDir, "config.json"));
});

test("writing every agent's instructions touches only the setup's files and parts, and detection agrees", () => {
    const { L } = fakeTree();
    const all = { agents: ["claude", "codex", "grok", "opencode"] };
    fs.mkdirSync(path.dirname(L.codexAgents), { recursive: true });
    fs.writeFileSync(L.codexAgents, "# Codex rules\nkeep me\n");
    fs.mkdirSync(L.opencodeInstructionsDir, { recursive: true });
    fs.writeFileSync(path.join(L.opencodeInstructionsDir, "opencode.jsonc"), '{\n  // mine\n  "model": "x",\n}\n');
    for (const agent of /** @type {const} */ (["claude", "codex", "grok", "opencode"])) applyAgentInstructions(agent, L, all, {});

    assert.equal(fs.readFileSync(L.claudeRulesFile, "utf8"), TEXT);
    assert.ok(fs.readFileSync(L.codexAgents, "utf8").startsWith("# Codex rules\nkeep me\n"));
    // CLAUDE_CONFIG_DIR is set, so Grok does not see Claude's rules: it gets the shared folder.
    assert.deepEqual(grokExtraRuleDirs(fs.readFileSync(L.grokConfig, "utf8")), [L.configDir]);
    assert.equal(fs.readFileSync(L.instructionsFile, "utf8"), TEXT);
    assert.deepEqual(fs.readdirSync(L.configDir).filter((name) => name.endsWith(".md")), ["agent-instructions.md"]);
    assert.match(fs.readFileSync(path.join(L.opencodeInstructionsDir, "opencode.jsonc"), "utf8"), /\/\/ mine/);
    // OpenCode's AGENTS.md is never created, in either of its folders.
    assert.equal(fs.existsSync(path.join(L.opencodeInstructionsDir, "AGENTS.md")), false);
    assert.equal(fs.existsSync(path.join(L.opencodeMcpDir, "AGENTS.md")), false);

    assert.deepEqual(detectInstructions(L, {}), {
        shared: true,
        claudeRules: true,
        claudeRulesExists: false,
        claudeRulesSeenByGrok: false,
        grokCompatRules: true,
        grokImportsClaudeRules: false,
        grokExtraDir: true,
        grokEditable: true,
        codexBlock: true,
        opencodeListed: true,
    });
    const files = [L.claudeRulesFile, L.codexAgents, L.grokConfig, path.join(L.opencodeInstructionsDir, "opencode.jsonc")];
    const snapshot = files.map((file) => fs.readFileSync(file, "utf8"));
    for (const agent of /** @type {const} */ (["claude", "codex", "grok", "opencode"])) applyAgentInstructions(agent, L, all, {});
    assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), snapshot);
});

test("Codex writes to a non-empty AGENTS.override.md and leaves AGENTS.md alone", () => {
    const { L } = fakeTree();
    fs.mkdirSync(path.dirname(L.codexAgents), { recursive: true });
    fs.writeFileSync(L.codexAgents, "base\n");
    fs.writeFileSync(L.codexAgentsOverride, "override rules\n");
    applyAgentInstructions("codex", L, { agents: ["codex"] }, {});
    assert.equal(fs.readFileSync(L.codexAgents, "utf8"), "base\n");
    assert.ok(fs.readFileSync(L.codexAgentsOverride, "utf8").startsWith("override rules\n"));
    assert.equal(detectInstructions(L, {}).codexBlock, true);
});

/** Grok reads ~/.claude/rules here: no CLAUDE_CONFIG_DIR. */
function grokTree() {
    const home = path.join(tempDir("lms-grok-"), "home");
    return layout("linux", home, {});
}

/** Number of routes by which Grok would load the setup's text. */
function grokDeliveries(L, env) {
    const found = detectInstructions(L, env);
    const compat = found.claudeRulesExists && (found.grokCompatRules === true || found.grokImportsClaudeRules) ? 1 : 0;
    return compat + (found.grokExtraDir && found.shared ? 1 : 0);
}

test("Grok with compat on and Claude chosen gets exactly one route, and a leftover folder entry is removed", () => {
    const L = grokTree();
    fs.mkdirSync(path.dirname(L.grokConfig), { recursive: true });
    fs.writeFileSync(L.grokConfig, `[paths]\nextra_rule_dirs = ["/keep", ${JSON.stringify(L.configDir)}]\n`);
    applyAgentInstructions("claude", L, { agents: ["claude", "grok"] }, {});
    applyAgentInstructions("grok", L, { agents: ["claude", "grok"] }, {});
    assert.deepEqual(grokExtraRuleDirs(fs.readFileSync(L.grokConfig, "utf8")), ["/keep"]);
    assert.equal(grokDeliveries(L, {}), 1);
    // GROK_CLAUDE_RULES_ENABLED=0 turns compat off: the folder route replaces it.
    applyAgentInstructions("grok", L, { agents: ["claude", "grok"] }, { GROK_CLAUDE_RULES_ENABLED: "0" });
    assert.deepEqual(grokExtraRuleDirs(fs.readFileSync(L.grokConfig, "utf8")), ["/keep", L.configDir]);
    assert.equal(grokDeliveries(L, { GROK_CLAUDE_RULES_ENABLED: "0" }), 1);
});

test("after /import-claude (compat off, ~/.claude/rules listed) Grok still gets exactly one route", () => {
    const L = grokTree();
    fs.mkdirSync(path.dirname(L.grokConfig), { recursive: true });
    fs.writeFileSync(L.grokConfig, '[compat.claude]\nrules = false\n\n[paths]\nextra_rule_dirs = ["~/.claude/rules"]\n');
    applyAgentInstructions("claude", L, { agents: ["claude", "grok"] }, {});
    applyAgentInstructions("grok", L, { agents: ["claude", "grok"] }, {});
    assert.deepEqual(grokExtraRuleDirs(fs.readFileSync(L.grokConfig, "utf8")), ["~/.claude/rules"]);
    assert.equal(grokDeliveries(L, {}), 1);
});

test("with Claude no longer chosen but its rules file still present, Grok keeps using it rather than adding a second route", () => {
    const L = grokTree();
    applyAgentInstructions("claude", L, { agents: ["claude", "grok"] }, {});
    applyAgentInstructions("grok", L, { agents: ["grok"] }, {});
    assert.equal(fs.existsSync(L.grokConfig) ? (grokExtraRuleDirs(fs.readFileSync(L.grokConfig, "utf8")) ?? []).length : 0, 0);
    assert.equal(grokDeliveries(L, {}), 1);
});

test("OpenCode with no config gets opencode.json in its instructions folder, never AGENTS.md", () => {
    const { L } = fakeTree();
    applyAgentInstructions("opencode", L, { agents: ["opencode"] }, {});
    assert.deepEqual(fs.readdirSync(L.opencodeInstructionsDir), ["opencode.json"]);
    assert.equal(detectInstructions(L, {}).opencodeListed, true);
});

/* ------------------------------------------------------------ final batch */

test("Grok with nothing to change leaves a [paths] form the setup cannot edit alone, instead of refusing", () => {
    // Claude's config folder not moved, so Grok's compat mode reads the setup's Claude rules file.
    const L = layout("linux", path.join(tempDir("lms-groknoop-"), "home"), {});
    assert.equal(L.claudeRulesSeenByGrok, true);
    const toml = 'paths.custom = "x"\n';
    fs.mkdirSync(path.dirname(L.grokConfig), { recursive: true });
    fs.writeFileSync(L.grokConfig, toml);
    assert.equal(grokPathsEditable(toml), false);
    assert.equal(withGrokExtraRuleDir(toml, L.configDir, false), toml);
    // Claude chosen, compat on: Grok reads Claude's rules file, and the setup's folder is not listed.
    applyAgentInstructions("grok", L, { agents: ["claude", "grok"] }, { GROK_CLAUDE_RULES_ENABLED: "true" });
    assert.equal(fs.readFileSync(L.grokConfig, "utf8"), toml);
    assert.equal(fs.readFileSync(L.claudeRulesFile, "utf8"), TEXT);
    // Adding the folder to that form is still refused.
    assert.throws(() => withGrokExtraRuleDir(toml, L.configDir, true), /edit extra_rule_dirs by hand/);
});

test("a malformed agent config becomes a problem naming the file, and only installed or chosen agents' files are read", () => {
    const { L } = fakeTree();
    fs.mkdirSync(L.opencodeMcpDir, { recursive: true });
    fs.writeFileSync(path.join(L.opencodeMcpDir, "opencode.json"), "");
    fs.mkdirSync(path.dirname(L.claudeJson), { recursive: true });
    fs.writeFileSync(L.claudeJson, "{ not json");
    // Neither agent relevant: nothing is parsed, nothing is reported.
    const none = detectAgents(L, () => new Set());
    assert.deepEqual(none.problems, {});
    /** @type {Partial<Record<import("./plan.mjs").AgentId, string>>} */
    const quiet = {};
    detectInstructions(L, {}, new Set(), quiet);
    assert.deepEqual(quiet, {});
    // Both relevant: each problem names its own file.
    const both = detectAgents(L, () => new Set(["claude", "opencode"]));
    assert.match(both.problems.claude ?? "", new RegExp(`^${L.claudeJson.replaceAll("/", "\\/")} could not be read .*fix or remove it, then plan again\\.$`));
    assert.match(both.problems.opencode ?? "", /could not be read/);
    assert.equal(both.agents.opencode.qmd, false);
    /** @type {Partial<Record<import("./plan.mjs").AgentId, string>>} */
    const found = {};
    detectInstructions(L, {}, new Set(["opencode"]), found);
    assert.match(found.opencode ?? "", /could not be read/);
});

test("Grok's extra_rule_dirs decode every TOML basic-string escape, so \\U and Windows paths are read, not thrown on", () => {
    assert.deepEqual(grokExtraRuleDirs('[paths]\nextra_rule_dirs = ["~/r\\U0001F600les", "C:\\\\rules", "tab\\there"]\n'), ["~/r\u{1F600}les", "C:\\rules", "tab\there"]);
});
