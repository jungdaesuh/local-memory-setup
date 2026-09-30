/**
 * Where everything lives and which versions are installed. Single source for
 * paths, ports, URLs, and pinned upstream versions; detection and apply both read it.
 * LongMemory is not pinned to one commit: apply builds the current `main` of
 * LONGMEMORY_REPO (see longmemory_build.mjs).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { npmGlobalBin, npmGlobalBinDir } from "./platform.mjs";

/** Installed when no QMD exists. Contract verified against this release: `mcp --http --port`, `/health`, `embed -c`, `collection add --name --mask`, `--index`, QMD_* env, index.yml `models`. */
export const QMD_VERSION = "2.5.3";
/**
 * Existing QMD releases the skill adopts instead of reinstalling. Each was checked
 * against the same contract in its published dist/ (2.8.3: cli/qmd.js mcp/embed/--index/
 * collection options, llm.js resolveEmbedModel and QMD_* env, mcp/server.js /health and
 * listen on QMD_HOST ?? "localhost", cli ensureModelsConfiguredForCli).
 */
export const QMD_COMPATIBLE_VERSIONS = ["2.5.3", "2.8.3"];
export const LONGMEMORY_REPO = "https://github.com/CaviraOSS/LongMemory.git";
/**
 * Node needed to install or rebuild QMD and LongMemory: pnpm 11.5.2 (LongMemory's
 * packageManager) needs >=22.13, and the setup reads its databases read-only through
 * SQLite URI filenames (`file:...?immutable=1`), which official Node builds support from
 * 22.15. A health check on an older Node works; it reports those checks as unknown.
 */
export const MIN_NODE = { major: 22, minor: 15 };
export const SQLITE_URI_NODE = MIN_NODE;

/** README of the notes folder the setup creates when QMD has no collection yet (as the first skill version did). */
export const NOTES_README = "# Notes\n\nMarkdown in this folder is indexed by QMD.\n";

export const QMD_PORT = 8181;
export const LONGMEMORY_PORT = 7331;
export const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
/** OLLAMA_HOST value for a skill-run `ollama serve`: loopback, Ollama's documented default. */
export const OLLAMA_HOST = new URL(OLLAMA_ORIGIN).host;
/** Release the Linux install.sh is pinned to (OLLAMA_VERSION; github.com/ollama/ollama releases/latest on 2026-09-29). */
export const OLLAMA_VERSION = "0.34.4";
/**
 * SHA-256 of https://raw.githubusercontent.com/ollama/ollama/v0.34.4/scripts/install.sh
 * downloaded 2026-09-30 (`curl -fsSL <url> | sha256sum`). The installer is that tagged
 * file, not https://ollama.com/install.sh, and it is not run unless this matches.
 */
export const OLLAMA_INSTALL_SHA256 = "25f64b810b947145095956533e1bdf56eacea2673c55a7e586be4515fc882c9f";

/**
 * install.sh from the git tag of `version`. install.sh reads OLLAMA_VERSION into its download URLs.
 * @param {string} version
 */
export function ollamaInstallScriptUrl(version) {
    return `https://raw.githubusercontent.com/ollama/ollama/v${version}/scripts/install.sh`;
}

/** @param {string} file */
export function fileSha256(file) {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Refuse a downloaded installer whose hash is not the pin. Callers run the file only after this returns.
 * @param {string} actual
 * @param {string} expected
 */
export function assertSha256Match(actual, expected) {
    if (actual !== expected) {
        throw new Error(`Ollama installer SHA-256 is ${actual}, not the pinned ${expected}. The installer was not run.`);
    }
}

/**
 * The Linux Ollama install for a user to run in a terminal: download the tagged script,
 * check the pinned SHA-256, then run it. A mismatch makes `sha256sum -c` fail, so `sh` does not run.
 * @param {string} version
 */
export function ollamaAdminCommand(version) {
    if (version !== OLLAMA_VERSION) throw new Error(`Ollama installer is pinned to ${OLLAMA_VERSION}, not ${version}.`);
    const url = ollamaInstallScriptUrl(version);
    return `curl -fsSL -o install.sh ${url} && echo "${OLLAMA_INSTALL_SHA256}  install.sh" | sha256sum -c - && OLLAMA_VERSION=${version} sh install.sh`;
}

/**
 * LongMemory's built CLI and the stamp written after `pnpm build` (that build deletes dist first).
 * @param {string} buildDir
 */
export function longMemoryCli(buildDir) {
    return path.join(buildDir, "dist", "cli", "index.js");
}

/** @param {string} buildDir */
export function longMemoryStamp(buildDir) {
    return path.join(buildDir, "dist", `.${MARKER}-commit`);
}

/**
 * How the service runner starts LongMemory: env file, then `serve`, no extra flags.
 * The smoke test starts a candidate build with the same arguments.
 * @param {string} node
 * @param {string} envFile
 * @param {string} cli
 */
export function longMemoryServeArgv(node, envFile, cli) {
    return [node, `--env-file=${envFile}`, cli, "serve"];
}

/**
 * QMD's HTTP server listens on the name "localhost" (dist/mcp/server.js
 * `httpServer.listen(port, "localhost")`), which is ::1 on hosts that resolve
 * localhost to IPv6 first. Clients use the same name so they reach it either way.
 */
export const QMD_MCP_URL = `http://localhost:${QMD_PORT}/mcp`;
export const QMD_HEALTH_URL = `http://localhost:${QMD_PORT}/health`;
/** LongMemory binds LONGMEMORY_HOST, which the env file sets to 127.0.0.1. */
export const LONGMEMORY_MCP_URL = `http://127.0.0.1:${LONGMEMORY_PORT}/mcp`;
export const LONGMEMORY_HEALTH_URL = `http://127.0.0.1:${LONGMEMORY_PORT}/health`;
export const OLLAMA_TAGS_URL = `${OLLAMA_ORIGIN}/api/tags`;
export const OLLAMA_PULL_URL = `${OLLAMA_ORIGIN}/api/pull`;

export const MARKER = "local-memory-setup";

/** Service names per platform. Namespaced so they never collide with a user's own units or tasks. */
export const SERVICE_NAMES = {
    qmd: { systemd: "local-memory-qmd.service", launchd: "com.local-memory-setup.qmd", task: "LocalMemoryQmd" },
    longmemory: { systemd: "local-memory-longmemory.service", launchd: "com.local-memory-setup.longmemory", task: "LocalMemoryLongMemory" },
    ollama: { systemd: "local-memory-ollama.service", launchd: "com.local-memory-setup.ollama", task: "LocalMemoryOllama" },
};

/**
 * Every path honours the agents' and tools' own directory variables: CLAUDE_CONFIG_DIR,
 * CODEX_HOME, GROK_HOME, OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME, XDG_CACHE_HOME, and QMD's
 * INDEX_PATH.
 * @param {NodeJS.Platform} platform
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 */
export function layout(platform = process.platform, home = os.homedir(), env = process.env) {
    const join = platform === "win32" ? path.win32.join : path.posix.join;
    const prefix = join(home, ".local");
    const share = join(home, ".local", "share", MARKER);
    const configDir = join(home, ".config", MARKER);
    const tools = join(share, "tools");
    const modulesDir = (root) => (platform === "win32" ? join(root, "node_modules") : join(root, "lib", "node_modules"));
    // Builds live under longmemory/builds/<sha>. The database stays beside that tree, not inside a build.
    const longmemoryRoot = join(share, "longmemory");
    // OllamaSetup.exe installs to {localappdata}\\Programs\\Ollama (app/ollama.iss DefaultDirName).
    const ollamaWindowsDir = join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "Ollama");
    const xdgCache = env.XDG_CACHE_HOME;
    const xdgConfig = env.XDG_CONFIG_HOME;
    // Claude Code: "every ~/.claude path ... lives under that directory instead" (CLAUDE_CONFIG_DIR),
    // including .claude.json. Codex: CODEX_HOME. Grok: GROK_HOME. OpenCode: OPENCODE_CONFIG_DIR, else XDG.
    const defaultClaudeDir = join(home, ".claude");
    const claudeDir = env.CLAUDE_CONFIG_DIR ?? defaultClaudeDir;
    const codexHome = env.CODEX_HOME ?? join(home, ".codex");
    const grokHome = env.GROK_HOME ?? join(home, ".grok");
    return {
        home,
        prefix,
        share,
        configDir,
        bin: join(share, "bin"),
        gateDir: join(share, "bin", "gate"),
        logs: platform === "darwin" ? join(home, "Library", "Logs", MARKER) : join(share, "logs"),
        dispatchDir: join(prefix, "libexec", MARKER),
        dispatcher: join(prefix, "libexec", MARKER, platform === "win32" ? "qmd.cmd" : "qmd"),
        // Where the first version of this skill wrote its wrapper; recognised only while an rc file carries the skill's marker.
        legacyDispatcher: join(prefix, "libexec", "qmd-dispatch", "qmd"),
        npmBinDir: npmGlobalBinDir(prefix, platform),
        qmdShim: npmGlobalBin(prefix, "qmd", platform),
        qmdPackage: join(modulesDir(prefix), "@tobilu", "qmd"),
        tools,
        pnpmPackage: join(modulesDir(tools), "pnpm"),
        longmemoryRoot,
        buildsDir: join(longmemoryRoot, "builds"),
        // Symlink to the running build on Linux and macOS. Windows has no equivalent the runner can follow, so it reads currentPointer.
        currentLink: join(longmemoryRoot, "current"),
        currentPointer: join(longmemoryRoot, "current.txt"),
        // Directory of the build that was current before the last switch, and a marker that prune is still owed.
        previousBuildFile: join(longmemoryRoot, "previous"),
        switchMarker: join(longmemoryRoot, "switch-pending"),
        // Written when this setup installed QMD; only such a QMD is ever rebuilt.
        qmdInstallStamp: join(share, "qmd-install.json"),
        dbPath: join(share, "longmemory.db"),
        envPath: join(configDir, "longmemory.env"),
        choicesPath: join(configDir, "choices.json"),
        // The Node every generated script runs, recorded at apply (see detect.mjs setupNode).
        runtimePath: join(configDir, "runtime.json"),
        // The one instructions text for every agent. The only .md file in configDir, so a Grok
        // extra_rule_dirs entry pointing at configDir loads exactly this file.
        instructionsFile: join(configDir, "agent-instructions.md"),
        qmdModelCache: xdgCache ? join(xdgCache, "qmd", "models") : join(home, ".cache", "qmd", "models"),
        qmdIndexConfig: xdgConfig ? join(xdgConfig, "qmd", "index.yml") : join(home, ".config", "qmd", "index.yml"),
        // QMD's index database (dist/store.js getDefaultDbPath: INDEX_PATH, else <cache>/qmd/index.sqlite).
        qmdIndexDb: env.INDEX_PATH ?? (xdgCache ? join(xdgCache, "qmd", "index.sqlite") : join(home, ".cache", "qmd", "index.sqlite")),
        systemdUserDir: join(home, ".config", "systemd", "user"),
        launchAgentsDir: join(home, "Library", "LaunchAgents"),
        claudeDir,
        // Claude Code keeps .claude.json in CLAUDE_CONFIG_DIR when set, else in the home directory.
        claudeJson: env.CLAUDE_CONFIG_DIR === undefined ? join(home, ".claude.json") : join(claudeDir, ".claude.json"),
        claudeRulesFile: join(claudeDir, "rules", `${MARKER}.md`),
        // Grok's Claude compatibility reads ~/.claude/rules, not CLAUDE_CONFIG_DIR.
        claudeRulesSeenByGrok: claudeDir === defaultClaudeDir,
        codexHome,
        codexConfig: join(codexHome, "config.toml"),
        codexAgents: join(codexHome, "AGENTS.md"),
        codexAgentsOverride: join(codexHome, "AGENTS.override.md"),
        grokHome,
        grokConfig: join(grokHome, "config.toml"),
        // OpenCode's global directory (Path.config): where `opencode mcp add` writes, whatever
        // OPENCODE_CONFIG_DIR says. OPENCODE_CONFIG_DIR is a second directory OpenCode also loads;
        // the setup's instructions entry goes there when it is set (see agent_config_files.mjs).
        opencodeMcpDir: join(xdgConfig ?? join(home, ".config"), "opencode"),
        opencodeInstructionsDir: env.OPENCODE_CONFIG_DIR ?? join(xdgConfig ?? join(home, ".config"), "opencode"),
        notesDir: join(home, "notes"),
        ollamaWindowsExe: join(ollamaWindowsDir, "ollama.exe"),
        ollamaWindowsApp: join(ollamaWindowsDir, "ollama app.exe"),
    };
}
