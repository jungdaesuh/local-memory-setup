/**
 * Local memory setup: QMD (search) and CaviraOSS LongMemory (memory, built from the
 * current main of LONGMEMORY_REPO; the npm package "longmemory" is the old HSG server),
 * with Ollama for LongMemory's embeddings, user services that restart, and agent MCP wiring.
 *
 *   node ensure.mjs [--check]              health check, no changes, no network (default)
 *   node ensure.mjs --plan                 detect, resolve LongMemory main, print the plan; no changes
 *   node ensure.mjs --apply --choices F    run the plan's pending actions for choices file F
 *   node ensure.mjs --apply --yes          same, with the plan's recommended choices
 *   node ensure.mjs --update               resolve main and run only the LongMemory actions
 *
 * stdout carries exactly one JSON document (none for a healthy --check).
 * Exit codes: 0 done or healthy, 1 failed or blocked, 2 needs an admin step, 3 unhealthy, 64 usage.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NeedsAdmin, runApply } from "./apply_loop.mjs";
import { UsageError, parseArgs } from "./cli_args.mjs";
import { RC_FILES, WINDOWS_USER_PATH_READ, detectAgents, detectFacts, ollamaBinary, ollamaSystemUnit, qmdEntryIn, setupNode } from "./detect.mjs";
import { instructedLongMemoryTools } from "./agent_instructions.mjs";
import { applyAgentInstructions } from "./instructions_apply.mjs";
import { ollamaStartStep, rebuildCommand } from "./executor_steps.mjs";
import { longMemoryHealthy, ollamaModelNames, qmdHealthy } from "./health.mjs";
import {
    LONGMEMORY_HEALTH_URL,
    LONGMEMORY_MCP_URL,
    LONGMEMORY_REPO,
    MARKER,
    MIN_NODE,
    NOTES_README,
    OLLAMA_INSTALL_SHA256,
    OLLAMA_PULL_URL,
    OLLAMA_TAGS_URL,
    OLLAMA_VERSION,
    QMD_HEALTH_URL,
    QMD_MCP_URL,
    QMD_VERSION,
    SERVICE_NAMES,
    assertSha256Match,
    fileSha256,
    layout,
    ollamaAdminCommand,
    ollamaInstallScriptUrl,
} from "./layout.mjs";
import { currentBuildDir, installLongMemoryCommit, pruneAfterSwitch, rollbackSwitch, runningLongMemory } from "./longmemory_build.mjs";
import { longMemorySettings, renderEnvFile } from "./longmemory_env.mjs";
import { appendServers, codexServers, grokServers, mcpAddArgs } from "./mcp_config.mjs";
import { MODEL_TIERS } from "./model_choice.mjs";
import { pullModelViaApi } from "./ollama_api.mjs";
import { ollamaServicePlan } from "./ollama_plan.mjs";
import { applyChoices, buildPlan, checkReport, effectiveQmdModels, foldersToAdd, isLongMemoryAction, longMemoryRestartPending, newNotesFolder, planActions, startSummary, stepsNeedingNewerNode } from "./plan.mjs";
import { binEntry } from "./platform.mjs";
import { commandPath, probeJson, run, waitFor } from "./proc.mjs";
import { QMD_GLOBAL_INDEX_ARGS, qmdProcessEnv } from "./qmd_env.mjs";
import { writeUserFile } from "./fs_util.mjs";
import { collectionNameFor, qmdCollections, writeQmdModelsIfAbsent } from "./qmd_state.mjs";
import { launchAgentPlist, systemdUnit, windowsTaskXml, withManagedPathBlock } from "./service_files.mjs";
import { MCP_ADD_TIMEOUT_MS, OLLAMA_MODEL_BYTES, OLLAMA_ROCM_BYTES, QMD_PACKAGE_BYTES, downloadTimeoutMs, installTimeoutMs, ollamaInstallerBytes } from "./sizes.mjs";
import { GATE_FILES, dispatcherText, longMemoryRunnerText, ollamaRunnerText, qmdRunnerText, rcPathLine, runnerFile } from "./service_specs.mjs";

const L = layout();
const platform = /** @type {"linux" | "darwin" | "win32"} */ (process.platform);
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Actions apply cannot resolve itself; reported before anything changes. */
class Blocked extends Error {
    /** @param {string[]} blockers */
    constructor(blockers) {
        super("Setup cannot go ahead on this computer yet.");
        this.blockers = blockers;
    }
}

function emit(document) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

function say(message) {
    process.stderr.write(`${message}\n`);
}

/**
 * Write a file this setup owns when `content` differs from what is on disk (atomic rename).
 * @param {string} file
 * @param {string | Buffer} content
 * @param {number} [mode]
 * @returns {boolean} whether the file changed
 */
function writeIfChanged(file, content, mode) {
    const next = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    if (fs.existsSync(file) && fs.readFileSync(file).equals(next)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, next, mode === undefined ? {} : { mode });
    fs.renameSync(temp, file);
    if (mode !== undefined && platform !== "win32") fs.chmodSync(file, mode);
    return true;
}

/**
 * The QMD launcher the setup runs: the adopted QMD where detection found it, else the one
 * install-qmd put in ~/.local.
 * @param {import("./plan.mjs").Facts} facts
 */
function qmdEntry(facts) {
    const packageDir = facts.qmd.packageDir ?? L.qmdPackage;
    const entry = qmdEntryIn(packageDir);
    if (entry === null) throw new Error(`QMD is not installed in ${packageDir}.`);
    return entry;
}

const ollamaUp = async () => ollamaModelNames(await probeJson(OLLAMA_TAGS_URL)) !== null;

/** Fails with NeedsAdmin, carrying `command`, when sudo would ask for a password. */
function requireSudo(detail, command) {
    if (run("sudo", ["-n", "true"], { allowFail: true, timeoutMs: 15_000 }).status !== 0) throw new NeedsAdmin(detail, [command]);
}

/* ---------------------------------------------------------------- services */

/**
 * Register and start one skill-owned service that runs its runner script.
 * @param {"qmd" | "longmemory" | "ollama"} service
 * @param {boolean} runnerChanged
 * @param {readonly string[]} wants systemd user units to start before this one
 */
function registerService(service, runnerChanged, wants) {
    const runner = runnerFile(L, platform, service);
    const names = SERVICE_NAMES[service];
    if (platform === "linux") {
        const unitPath = path.join(L.systemdUserDir, names.systemd);
        const unitChanged = writeIfChanged(unitPath, systemdUnit({ description: `${MARKER}: ${service}`, execStart: runner, wants }));
        if (unitChanged) run("systemctl", ["--user", "daemon-reload"]);
        run("systemctl", ["--user", "enable", names.systemd]);
        run("systemctl", ["--user", unitChanged || runnerChanged ? "restart" : "start", names.systemd]);
        return;
    }
    if (platform === "darwin") {
        const plistPath = path.join(L.launchAgentsDir, `${names.launchd}.plist`);
        fs.mkdirSync(L.logs, { recursive: true });
        const plistChanged = writeIfChanged(plistPath, launchAgentPlist({ label: names.launchd, program: runner, log: path.join(L.logs, `${service}.log`) }));
        const target = `gui/${os.userInfo().uid}/${names.launchd}`;
        const loaded = () => run("launchctl", ["print", target], { allowFail: true }).status === 0;
        if (loaded() && plistChanged) {
            run("launchctl", ["bootout", target]);
            for (let attempt = 0; attempt < 20 && loaded(); attempt += 1) run("/bin/sleep", ["0.5"]);
        }
        if (!loaded()) run("launchctl", ["bootstrap", `gui/${os.userInfo().uid}`, plistPath]);
        else run("launchctl", runnerChanged ? ["kickstart", "-k", target] : ["kickstart", target]);
        return;
    }
    const domain = process.env.USERDOMAIN;
    if (!domain) throw new Error("USERDOMAIN is not set; cannot name the Task Scheduler user.");
    const xmlPath = path.join(L.share, "tasks", `${names.task}.xml`);
    const xmlChanged = writeIfChanged(xmlPath, windowsTaskXml({ command: runner, userId: `${domain}\\${os.userInfo().username}` }));
    const registered = run("schtasks", ["/Query", "/TN", names.task], { allowFail: true }).status === 0;
    if (xmlChanged || !registered) run("schtasks", ["/Create", "/TN", names.task, "/XML", xmlPath, "/F"]);
    if (xmlChanged || runnerChanged) run("schtasks", ["/End", "/TN", names.task], { allowFail: true });
    run("schtasks", ["/Run", "/TN", names.task]);
}

/** @param {"qmd" | "longmemory" | "ollama"} service @param {string} text */
function writeRunner(service, text) {
    return writeIfChanged(runnerFile(L, platform, service), text, 0o755);
}

/**
 * Restart one of the setup's own services, so it loads rebuilt native modules.
 * @param {"qmd" | "longmemory" | "ollama"} service
 */
function restartService(service) {
    const names = SERVICE_NAMES[service];
    if (platform === "linux") run("systemctl", ["--user", "restart", names.systemd]);
    else if (platform === "darwin") run("launchctl", ["kickstart", "-k", `gui/${os.userInfo().uid}/${names.launchd}`]);
    else {
        run("schtasks", ["/End", "/TN", names.task], { allowFail: true });
        run("schtasks", ["/Run", "/TN", names.task]);
    }
}

/**
 * Rebuild a component's native modules for `node`, then restart its service when it
 * is the setup's own. npm next to that Node is the matching npm; the Node's directory
 * also goes first on PATH for everything the rebuild runs.
 * @param {"qmd" | "longmemory"} component
 * @param {Context} ctx
 */
function rebuildNative(component, ctx) {
    const beside = path.join(path.dirname(ctx.node), platform === "win32" ? "npm.cmd" : "npm");
    const pnpmJson = path.join(L.pnpmPackage, "package.json");
    const pnpmEntry = fs.existsSync(pnpmJson) ? path.join(L.pnpmPackage, binEntry(JSON.parse(fs.readFileSync(pnpmJson, "utf8")).bin, "pnpm")) : "";
    if (component === "longmemory" && pnpmEntry === "") throw new Error(`pnpm is missing from ${L.tools}; run the plan again to rebuild LongMemory.`);
    /** @type {string} */
    let sourceDir;
    if (component === "longmemory") {
        const dir = currentBuildDir(L, platform);
        if (dir === null) throw new Error("LongMemory has no current build to rebuild.");
        sourceDir = dir;
    } else {
        sourceDir = L.qmdPackage;
    }
    const command = rebuildCommand(component, {
        L: { qmdPackage: L.qmdPackage, sourceDir },
        nodeBin: ctx.node,
        npm: fs.existsSync(beside) ? beside : "npm",
        pnpmEntry,
        pathEnv: process.env.PATH ?? "",
        delimiter: path.delimiter,
    });
    run(command.command, command.args, { cwd: command.cwd, env: { ...process.env, CI: "1", PATH: command.pathEnv }, stream: true, timeoutMs: installTimeoutMs(0) });
    if (ctx.facts.services[component]) restartService(component);
}

/* ---------------------------------------------------------------- actions */

/**
 * `node` is the Node every generated script and build runs (detect.mjs setupNode),
 * `abi` its process.versions.modules.
 * @typedef {{ facts: import("./plan.mjs").Facts, choices: import("./plan.mjs").Choices, node: string, abi: string, newNotes: string | null }} Context
 * @type {Record<string, (ctx: Context) => Promise<void>>}
 */
const EXECUTORS = {
    "install-qmd": async ({ node, facts }) => {
        // The plan installs QMD only where none exists; an existing QMD is adopted or blocks the plan.
        if (qmdEntryIn(L.qmdPackage) !== null) throw new Error(`A QMD appeared in ${L.qmdPackage} after planning; run the plan again.`);
        // With the setup's Node first on PATH, npm builds QMD's native modules for it.
        run("npm", ["install", "-g", "--prefix", L.prefix, `@tobilu/qmd@${QMD_VERSION}`], {
            env: { ...process.env, PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}` },
            stream: true,
            timeoutMs: installTimeoutMs(QMD_PACKAGE_BYTES[facts.platform] ?? QMD_PACKAGE_BYTES.linux),
        });
        // Ownership: only a QMD this setup installed is ever rebuilt (plan.mjs rebuildAction).
        writeIfChanged(L.qmdInstallStamp, `${JSON.stringify({ version: QMD_VERSION, installedBy: MARKER }, null, 2)}\n`);
    },

    "rebuild-qmd": async (ctx) => rebuildNative("qmd", ctx),
    "rebuild-longmemory": async (ctx) => rebuildNative("longmemory", ctx),

    "install-longmemory": async ({ node, facts, choices }) => {
        const sha = facts.longmemory.main;
        if (sha === undefined) throw new Error("LongMemory main was not resolved; run the plan again.");
        const tier = MODEL_TIERS[choices.modelTier].longmemory;
        await installLongMemoryCommit({
            sha,
            node,
            repo: LONGMEMORY_REPO,
            platform,
            settings: longMemorySettings({ dbPath: L.dbPath, model: tier.model, dimension: tier.dimension }),
            tools: instructedLongMemoryTools(),
            // The following start step restarts our service and prunes only after that succeeds.
            deferPrune: longMemoryRestartPending(facts),
            L,
        });
    },

    "install-ollama": async ({ facts }) => {
        // Upper bound on Linux: the release plus ROCm (fetched with an AMD card); the extra
        // install time also covers NVIDIA's driver packages.
        const timeoutMs = installTimeoutMs(ollamaInstallerBytes(platform, facts.arch) + (platform === "linux" ? OLLAMA_ROCM_BYTES : 0));
        if (platform === "linux") {
            // Downloaded to a file first, so a failed download fails here instead of feeding sh an empty script.
            const script = path.join(L.share, "downloads", "install.sh");
            fs.mkdirSync(path.dirname(script), { recursive: true });
            run("curl", ["-fsSL", "-o", script, ollamaInstallScriptUrl(OLLAMA_VERSION)], { stream: true, timeoutMs: downloadTimeoutMs(0) });
            // Checked before sudo, so a mismatched file is never run as root.
            assertSha256Match(fileSha256(script), OLLAMA_INSTALL_SHA256);
            requireSudo("Installing Ollama needs the admin password.", ollamaAdminCommand(OLLAMA_VERSION));
            // As root, so install.sh's own sudo calls cannot prompt midway; OLLAMA_VERSION pins the release.
            run("sudo", ["-n", "env", `OLLAMA_VERSION=${OLLAMA_VERSION}`, "sh", script], { stream: true, timeoutMs });
        } else if (platform === "darwin") {
            run("brew", ["install", "ollama"], { stream: true, timeoutMs });
        } else {
            run("winget", ["install", "--id", "Ollama.Ollama", "-e", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"], { stream: true, timeoutMs });
        }
        if (ollamaBinary(L) === null) throw new Error("Ollama was installed but its binary was not found.");
    },

    "start-ollama": async ({ facts }) => {
        const unit = ollamaSystemUnit();
        const owner =
            platform === "linux"
                ? ollamaServicePlan({ platform, systemUnitLoaded: unit.loaded })
                : platform === "darwin"
                  ? ollamaServicePlan({ platform, ollamaApp: facts.ollama.ollamaApp, brewService: facts.ollama.brewService })
                  : ollamaServicePlan({ platform, ollamaApp: fs.existsSync(L.ollamaWindowsApp) });
        const step = ollamaStartStep({ owner: owner.owner, platform, up: await ollamaUp(), own: facts.services.ollama, unit, brewService: facts.ollama.brewService });
        if (step === "leave") return;
        if (step === "enable-system-unit") {
            requireSudo("The Ollama system service is not enabled and running.", "sudo systemctl enable --now ollama.service");
            run("sudo", ["-n", "systemctl", "enable", "--now", "ollama.service"]);
        } else if (step === "brew-services-start") run("brew", ["services", "start", "ollama"]);
        else if (step === "open-app") run("open", ["-a", "Ollama", "--args", "hidden"]);
        else if (step === "launch-windows-app") spawn(L.ollamaWindowsApp, [], { detached: true, stdio: "ignore" }).unref();
        else {
            const binary = ollamaBinary(L);
            if (binary === null) throw new Error("Ollama is not installed.");
            // The setup's own service: rewrite its runner and restart it when that changed.
            registerService("ollama", writeRunner("ollama", ollamaRunnerText({ binary, platform })), []);
        }
        await waitFor("Ollama", ollamaUp, 60);
    },

    "pull-memory-model": async ({ choices }) => {
        const model = MODEL_TIERS[choices.modelTier].longmemory.model;
        const timeoutMs = downloadTimeoutMs(OLLAMA_MODEL_BYTES[model]);
        const binary = ollamaBinary(L);
        if (binary !== null) {
            run(binary, ["pull", model], { stream: true, timeoutMs });
            return;
        }
        // No ollama command on this machine (a server in docker, say): pull through its API.
        say(`Pulling ${model} through ${OLLAMA_PULL_URL}`);
        await pullModelViaApi(OLLAMA_PULL_URL, model, { timeoutMs, onStatus: say });
    },

    "write-settings": async ({ facts, choices, node, abi }) => {
        const tier = MODEL_TIERS[choices.modelTier];
        const settings = longMemorySettings({
            dbPath: L.dbPath,
            model: tier.longmemory.model,
            dimension: tier.longmemory.dimension,
        });
        writeIfChanged(L.envPath, renderEnvFile(settings));
        writeIfChanged(L.runtimePath, `${JSON.stringify({ node, modules: abi }, null, 2)}\n`);
        writeIfChanged(L.dispatcher, dispatcherText({ node, qmdEntry: qmdEntry(facts), gpu: facts.hardware.gpu, platform }), 0o755);

        if (facts.qmd.foreignCommand !== undefined) {
            say(`Leaving PATH alone: ${facts.qmd.foreignCommand} is the qmd your shell runs. The setup's qmd is ${L.dispatcher}.`);
            return;
        }
        if (platform === "win32") {
            const dir = L.dispatchDir.replaceAll("'", "''");
            run("powershell", [
                "-NoProfile",
                "-Command",
                [
                    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
                    `$p=${WINDOWS_USER_PATH_READ}`,
                    `if (-not (($p -split ';') -contains '${dir}')) {`,
                    // Written back as REG_EXPAND_SZ, so %USERPROFILE%-style entries stay unexpanded.
                    `$k.SetValue('Path', ('${dir};' + $p).TrimEnd(';'), 'ExpandString')`,
                    // SetEnvironmentVariable broadcasts WM_SETTINGCHANGE, so new terminals see the change.
                    "[Environment]::SetEnvironmentVariable('LOCAL_MEMORY_SETUP_PATH_REFRESH', '1', 'User')",
                    "[Environment]::SetEnvironmentVariable('LOCAL_MEMORY_SETUP_PATH_REFRESH', $null, 'User') }",
                ].join("; "),
            ]);
            return;
        }
        for (const file of RC_FILES) {
            const target = path.join(L.home, file);
            const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
            const next = withManagedPathBlock(existing, MARKER, rcPathLine(L));
            if (next !== existing) writeUserFile(target, next);
        }
    },

    "set-search-model": async ({ facts, choices }) => {
        // QMD's index.yml models block decides QMD's models; it is written only for a new index.
        writeQmdModelsIfAbsent(L.qmdIndexConfig, effectiveQmdModels(facts, choices.modelTier));
    },

    "start-qmd": async ({ facts, node }) => {
        registerService("qmd", writeRunner("qmd", qmdRunnerText({ node, qmdEntry: qmdEntry(facts), gpu: facts.hardware.gpu, platform })), []);
        await waitFor("QMD", async () => qmdHealthy(await probeJson(QMD_HEALTH_URL)), 60);
    },

    "start-longmemory": async ({ choices, node, facts }) => {
        const gateChanged = GATE_FILES.map((name) => writeIfChanged(path.join(L.gateDir, name), fs.readFileSync(path.join(SCRIPTS_DIR, name)))).some(Boolean);
        const model = MODEL_TIERS[choices.modelTier].longmemory.model;
        const runnerChanged = writeRunner("longmemory", longMemoryRunnerText({ node, L, model, platform }));
        const ownOllamaUnit = platform === "linux" && ollamaServicePlan({ platform, systemUnitLoaded: ollamaSystemUnit().loaded }).owner === "skill" && fs.existsSync(path.join(L.systemdUserDir, SERVICE_NAMES.ollama.systemd));
        // A switch leaves the runner path the same (it execs `current`), so the unit must still restart.
        const switched = fs.existsSync(L.switchMarker);
        const sha = facts.longmemory.main ?? "unknown";
        try {
            registerService("longmemory", runnerChanged || gateChanged || switched, ownOllamaUnit ? [SERVICE_NAMES.ollama.systemd] : []);
            // The runner's gate may wait up to 120 s for Ollama before LongMemory starts.
            await waitFor("LongMemory", async () => longMemoryHealthy(await probeJson(LONGMEMORY_HEALTH_URL)), 150);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const previous = rollbackSwitch(L, platform);
            if (previous !== null) {
                try {
                    restartService("longmemory");
                } catch (rollbackError) {
                    const extra = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                    throw new Error(`LongMemory ${sha} failed the restart check: ${detail} Rolling back to the previous build also failed: ${extra}`);
                }
            }
            throw new Error(`LongMemory ${sha} failed the restart check: ${detail}`);
        }
        try {
            pruneAfterSwitch(L, platform);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`LongMemory ${sha} is running, but removing older builds failed: ${detail}`);
        }
    },

    "connect-claude": async () => connectCli("claude"),
    "connect-opencode": async () => connectCli("opencode"),
    "connect-codex": async () => connectToml(L.codexConfig, codexServers),
    "connect-grok": async () => connectToml(L.grokConfig, grokServers),

    "instructions-claude": async ({ choices }) => applyAgentInstructions("claude", L, choices, process.env),
    "instructions-codex": async ({ choices }) => applyAgentInstructions("codex", L, choices, process.env),
    "instructions-grok": async ({ choices }) => applyAgentInstructions("grok", L, choices, process.env),
    "instructions-opencode": async ({ choices }) => applyAgentInstructions("opencode", L, choices, process.env),

    "index-folders": async ({ facts, choices, node, newNotes }) => {
        if (newNotes !== null) {
            fs.mkdirSync(newNotes, { recursive: true });
            if (!fs.existsSync(path.join(newNotes, "README.md"))) writeUserFile(path.join(newNotes, "README.md"), NOTES_README);
        }
        const existing = fs.existsSync(L.qmdIndexConfig) ? qmdCollections(fs.readFileSync(L.qmdIndexConfig, "utf8")) : [];
        const taken = existing.map((collection) => collection.name);
        const names = [];
        for (const folder of choices.qmdFolders) {
            const known = existing.find((collection) => collection.path === folder);
            if (known !== undefined) {
                names.push(known.name);
                continue;
            }
            const name = collectionNameFor(folder, taken);
            taken.push(name);
            names.push(name);
            run(node, [qmdEntry(facts), ...QMD_GLOBAL_INDEX_ARGS, "collection", "add", folder, "--name", name, "--mask", "**/*.md"], {
                env: qmdProcessEnv(process.env, { node, gpu: facts.hardware.gpu, mode: "retrieval", delimiter: path.delimiter }),
                stream: true,
            });
        }
        // Every chosen collection, each run: `qmd embed` embeds only documents without vectors,
        // so an interrupted run is continued. `-c` takes one collection per run; other
        // collections are left as they are. No time limit: the first run also downloads
        // QMD's embedding model.
        for (const name of names) {
            run(node, [qmdEntry(facts), ...QMD_GLOBAL_INDEX_ARGS, "embed", "-c", name], {
                env: qmdProcessEnv(process.env, { node, gpu: facts.hardware.gpu, mode: "embed", delimiter: path.delimiter }),
                stream: true,
            });
        }
    },

    "enable-boot-start": async ({ facts }) => {
        const lingerFile = path.posix.join("/var/lib/systemd/linger", facts.username);
        // loginctl lets a user enable their own linger when polkit allows it without a
        // password; --no-ask-password keeps a polkit prompt from blocking. sudo is the other route.
        if (run("loginctl", ["--no-ask-password", "enable-linger", facts.username], { allowFail: true }).status !== 0 && facts.sudoNonInteractive) {
            run("sudo", ["-n", "loginctl", "enable-linger", facts.username], { allowFail: true });
        }
        if (!fs.existsSync(lingerFile)) {
            throw new NeedsAdmin("Start-at-boot needs systemd linger, which needs the admin password once.", [`sudo loginctl enable-linger ${facts.username}`]);
        }
    },
};

/**
 * Claude Code and OpenCode are connected through their own `mcp add`, which writes the
 * file each of them owns; a server name already present is left as it is.
 * @param {"claude" | "opencode"} agent
 */
function connectCli(agent) {
    const found = detectAgents(L, () => new Set([agent]));
    if (found.problems[agent] !== undefined) throw new Error(found.problems[agent]);
    const present = found.agents[agent];
    if (!present.qmd) run(agent, mcpAddArgs(agent, "qmd", QMD_MCP_URL), { timeoutMs: MCP_ADD_TIMEOUT_MS });
    if (!present.longmemory) run(agent, mcpAddArgs(agent, "longmemory", LONGMEMORY_MCP_URL), { timeoutMs: MCP_ADD_TIMEOUT_MS });
}

/**
 * @param {string} file
 * @param {typeof codexServers} servers
 */
function connectToml(file, servers) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const next = appendServers(current, servers({ qmdUrl: QMD_MCP_URL, longMemoryUrl: LONGMEMORY_MCP_URL }));
    if (next === current) return;
    writeUserFile(file, next);
}

/* ---------------------------------------------------------------- modes */

/**
 * @param {boolean} yes
 * @param {string | undefined} choicesFile
 * @param {boolean} updateOnly resolve main and run only the LongMemory actions; do not save choices
 */
async function apply(yes, choicesFile, updateOnly) {
    const facts = await detectFacts(L, { probeAdmin: true, resolveMain: true });
    const plan = buildPlan(facts);
    const requested = applyChoices(plan, yes ? null : JSON.parse(fs.readFileSync(/** @type {string} */ (choicesFile), "utf8")));
    // Only folders QMD does not index yet must exist; an indexed folder that moved does not block a repair.
    // A LongMemory-only update does not touch those folders.
    const toAdd = foldersToAdd(requested, facts.qmd.collectionPaths);
    const notesToCreate = updateOnly ? null : newNotesFolder(facts, requested);
    if (!updateOnly) {
        const missingFolders = toAdd.filter((folder) => folder !== notesToCreate && (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()));
        if (missingFolders.length > 0) throw new Error(`These folders do not exist: ${missingFolders.join(", ")}`);
    }
    // QMD stores a collection under its real path (qmd.js collection add: getRealPath); the
    // notes folder to create takes its parent's real path.
    const realFolder = (/** @type {string} */ folder) =>
        folder === notesToCreate ? path.join(fs.realpathSync(path.dirname(folder)), path.basename(folder)) : fs.realpathSync(folder);
    const folders = updateOnly ? requested.qmdFolders : requested.qmdFolders.map((folder) => (toAdd.includes(folder) ? realFolder(folder) : folder));
    if (!updateOnly && new Set(folders).size !== folders.length) throw new Error("Two qmdFolders entries are the same folder.");
    const choices = { ...requested, qmdFolders: folders };

    const pending = planActions(facts, choices)
        .filter((action) => !action.alreadyDone)
        .filter((action) => !updateOnly || isLongMemoryAction(action.id));
    const blockers = pending.flatMap((action) => (action.blocker === null ? [] : [action.blocker]));
    if (blockers.length > 0) throw new Blocked(blockers);
    // One Node for every generated script and build: the recorded one while it is usable, else this one.
    const setup = setupNode(L);
    const tooOld = stepsNeedingNewerNode(pending, setup.applyVersion);
    if (tooOld.length > 0) {
        throw new Error(
            `${tooOld.join(", ")} need Node.js ${MIN_NODE.major}.${MIN_NODE.minor} or newer; ${setup.applyNode} is ${setup.applyVersion}. Run the setup with a newer Node.js.`,
        );
    }
    const needed = [
        ...(pending.some((action) => ["install-qmd", "install-longmemory", "rebuild-qmd"].includes(action.id)) ? ["npm"] : []),
        ...(pending.some((action) => action.id === "install-longmemory") ? ["git"] : []),
        // install.sh unpacks a .tar.zst release (install.sh download_and_extract needs zstd and tar).
        ...(platform === "linux" && pending.some((action) => action.id === "install-ollama") ? ["curl", "zstd", "tar"] : []),
        ...(platform === "win32" && pending.some((action) => action.id === "install-ollama") ? ["winget"] : []),
    ];
    const missingTools = needed.filter((tool) => commandPath(tool) === null);
    if (missingTools.length > 0) throw new Error(`Install these first, then apply again: ${missingTools.join(", ")}.`);
    // Admin steps that come before the servers can run are checked up front, so apply
    // stops before changing anything instead of halfway through.
    const blocked = pending.filter((action) => action.needsAdmin && ["install-ollama", "start-ollama"].includes(action.id));
    if (blocked.length > 0) {
        throw new NeedsAdmin(
            "Setup needs an administrator step it cannot run without a password.",
            blocked.map((action) => /** @type {string} */ (action.adminCommand)),
        );
    }

    /** @type {Context} */
    const ctx = { facts, choices, node: setup.applyNode, abi: setup.applyAbi, newNotes: notesToCreate === null ? null : realFolder(notesToCreate) };
    const deferred = await runApply({
        pending,
        execute: async (action) => {
            say(`==> ${action.summary}`);
            await EXECUTORS[action.id](ctx);
        },
        remainingAfter: async () =>
            planActions(await detectFacts(L, { probeAdmin: false, resolveMain: false }), choices)
                .filter((action) => !action.alreadyDone)
                .filter((action) => !updateOnly || isLongMemoryAction(action.id))
                .map((action) => ({ id: action.id, problem: action.blocker ?? action.problem })),
        persist: updateOnly ? () => {} : () => writeIfChanged(L.choicesPath, `${JSON.stringify(choices, null, 2)}\n`),
    });
    if (deferred.length > 0) {
        throw new NeedsAdmin(
            `Everything else is set up and running. ${deferred.map((error) => error.message).join(" ")}`,
            deferred.flatMap((error) => error.commands),
        );
    }
    if (updateOnly) {
        emit({ status: "ready", updated: "longmemory", commit: runningLongMemory(L, platform)?.commit ?? null, longmemory: LONGMEMORY_MCP_URL });
        return;
    }
    const tier = MODEL_TIERS[choices.modelTier];
    emit({
        status: "ready",
        modelTier: choices.modelTier,
        qmdModel: effectiveQmdModels(facts, choices.modelTier).embed,
        longmemoryModel: tier.longmemory.model,
        longmemoryDimension: tier.longmemory.dimension,
        qmd: QMD_MCP_URL,
        longmemory: LONGMEMORY_MCP_URL,
        startsAgain: startSummary(facts, choices),
        env: L.envPath,
    });
}

async function main() {
    const { mode, yes, choicesFile } = parseArgs(process.argv.slice(2));
    if (mode === "--plan") {
        emit(buildPlan(await detectFacts(L, { probeAdmin: true, resolveMain: true })));
        return 0;
    }
    if (mode === "--check") {
        const report = checkReport(await detectFacts(L, { probeAdmin: false, resolveMain: false }));
        if (report.healthy) return 0;
        emit(report);
        return 3;
    }
    if (mode === "--update") {
        await apply(true, undefined, true);
        return 0;
    }
    await apply(yes, choicesFile, false);
    return 0;
}

// Entry point only: every module with logic worth importing lives beside this one.
// (An `import.meta.url === argv[1]` guard would silently skip main() whenever the
// skill is reached through a symlink, because import.meta.url is the real path.)
try {
    process.exitCode = await main();
} catch (error) {
    if (error instanceof NeedsAdmin) {
        emit({ status: "needs_admin", detail: error.message, commands: error.commands });
        process.exitCode = 2;
    } else if (error instanceof Blocked) {
        emit({ status: "blocked", detail: error.message, blockers: error.blockers });
        process.exitCode = 1;
    } else if (error instanceof UsageError) {
        emit({ status: "usage", detail: error.message });
        process.exitCode = 64;
    } else {
        emit({ status: "failed", detail: error instanceof Error ? error.message : String(error) });
        process.exitCode = 1;
    }
}
