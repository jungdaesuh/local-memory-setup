/**
 * Install plan: a pure function of detected facts (detect.mjs) and the user's
 * choices. `--plan` prints it, `--apply` executes the pending actions of the same
 * plan, and `--check` reports the pending actions of the saved choices as problems.
 *
 * Foreign QMD installs and service registrations are never adopted; this setup replaces
 * only its own legacy QMD and retires only its marked HTTP services. Unresolved conflicts
 * become blockers before apply changes anything.
 */
import path from "node:path";
import { LONGMEMORY_COMMIT, MIN_NODE, OLLAMA_VERSION, QMD_VERSION, ollamaAdminCommand } from "./layout.mjs";
import { shortSha } from "./longmemory_build.mjs";
import { nodeAtLeast } from "./platform.mjs";
import { MODEL_TIERS, QMD_DEFAULT_MODELS, TIER_IDS, recommendTier } from "./model_choice.mjs";
import { grokInstructionMode } from "./agent_instructions.mjs";
import { ollamaHasModel, ollamaServicePlan } from "./ollama_plan.mjs";
import { LONGMEMORY_BUILD_BYTES, OLLAMA_MODEL_BYTES, OLLAMA_ROCM_BYTES, QMD_MODEL_BYTES, QMD_PACKAGE_BYTES, ollamaInstallerBytes } from "./sizes.mjs";

export const SCHEMA_VERSION = 1;

/** @typedef {"claude" | "codex" | "grok" | "opencode"} AgentId */
export const AGENT_IDS = /** @type {readonly AgentId[]} */ (["claude", "codex", "grok", "opencode"]);
const AGENT_LABELS = { claude: "Claude Code", codex: "Codex", grok: "Grok", opencode: "OpenCode" };

/**
 * @typedef {import("./model_choice.mjs").ModelTier} ModelTier
 * @typedef {import("./qmd_state.mjs").QmdModels} QmdModels
 * @typedef {{
 *   schemaVersion: number,
 *   modelTier: ModelTier,
 *   agents: AgentId[],
 *   bootMode: "boot" | "login" | null,
 *   qmdFolders: string[],
 * }} Choices
 *
 * Optional facts are absent when the thing they describe does not exist:
 * qmd.configModels without an index.yml `models` block, qmd.foreignCommand unless a
 * `qmd` outside this setup is first on PATH, qmd.unembeddedFolders unless a collection has
 * documents without vectors, qmd.nativeAbi/longmemory.nativeAbi/nodeAbi unless the native
 * module or the setup's Node was found, instructions before detection has looked (tests),
 * longmemory.envFile/envModel/dbExists before detection has
 * looked (tests), longmemory.main unless detection resolved refs/heads/main,
 * longmemory.current unless a finished build is current,
 * longmemory.storedMemories unless the database was counted,
 * longmemory.memoryCountUnknown unless a database exists that could not be counted,
 * staleServices unless the setup-owned Ollama runner is out of date,
 * withoutSystemd unless Linux runs without systemd as PID 1, selfLingerAllowed unless
 * polkit lets an active user enable linger.
 * services.<name> is true when the setup's own registration exists, even when inactive;
 * foreignServices lists unmarked QMD/LongMemory registrations at the same service name.
 * @typedef {{
 *   platform: "linux" | "darwin" | "win32",
 *   arch: string,
 *   nodeVersion: string,
 *   username: string,
 *   hardware: import("./model_choice.mjs").Hardware,
 *   disk: { path: string, freeBytes: number }[],
 *   sudoNonInteractive: boolean,
 *   lingerEnabled: boolean,
 *   selfLingerAllowed?: boolean,
 *   withoutSystemd?: boolean,
 *   staleServices?: ("ollama")[],
 *   brewAvailable: boolean,
 *   agents: Record<AgentId, { installed: boolean, qmd: boolean, longmemory: boolean }>,
 *   nodeAbi?: string,
 *   qmd: {
 *     version: string | null, healthy: boolean, collectionPaths: string[], configModels?: QmdModels, foreignCommand?: string,
 *     unembeddedFolders?: string[], embeddingUnknown?: boolean, embeddingUnchecked?: boolean, nativeAbi?: string, installedBySetup?: boolean,
 *     reviewed?: boolean, reviewedOwned?: boolean,
 *     packageDir?: string,
 *     modelCache?: { cached: string[], unknown: string[] },
 *   },
 *   longmemory: { built: boolean, healthy: boolean, main?: string, current?: string, envFile?: boolean, envModel?: string, dbExists?: boolean, storedMemories?: number, memoryCountUnknown?: boolean, nativeAbi?: string },
 *   instructions?: {
 *     shared: boolean, claudeRules: boolean, claudeRulesExists: boolean, claudeRulesSeenByGrok: boolean,
 *     grokCompatRules: boolean | "unsupported", grokImportsClaudeRules: boolean, grokExtraDir: boolean, grokEditable: boolean,
 *     codexBlock: boolean, opencodeListed: boolean,
 *   },
 *   ollama: {
 *     installed: boolean, healthy: boolean, models: string[],
 *     systemUnit: { loaded: boolean, enabled: boolean, active: boolean },
 *     ollamaApp: boolean, brewService: boolean,
 *   },
 *   services: { qmd: boolean, longmemory: boolean, ollama: boolean },
 *   foreignServices?: ("qmd" | "longmemory")[],
 *   privateStorage?: boolean,
 *   nativeRuntime?: boolean,
 *   settingsWritten: boolean,
 *   agentProblems?: Partial<Record<AgentId, string>>,
 *   saved: unknown,
 *   notesDir: string | null,
 *   notesPath?: string,
 * }} Facts ollama.models holds the model names from GET /api/tags; saved is choices.json as parsed.
 *
 * @typedef {{
 *   id: string, summary: string, needsAdmin: boolean, adminCommand: string | null,
 *   downloadBytes: number, alreadyDone: boolean, blocker: string | null, problem: string,
 * }} Action
 */

const GB = 1_000_000_000;
function aboutGb(bytes) {
    return `about ${(bytes / GB).toFixed(bytes < GB ? 2 : 1)} GB`;
}

/* ------------------------------------------------------------ choices */

/**
 * Structural problems of a choices document.
 * @param {unknown} input
 * @param {{ os: string, agents: readonly string[], bootModes: readonly string[] }} allowed
 */
function choiceProblems(input, allowed) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return ["Choices must be a JSON object."];
    const doc = /** @type {Record<string, unknown>} */ (input);
    const keys = ["schemaVersion", "modelTier", "agents", "bootMode", "qmdFolders"];
    const problems = [];
    for (const key of Object.keys(doc)) if (!keys.includes(key)) problems.push(`Unknown key "${key}".`);
    for (const key of keys) if (!Object.hasOwn(doc, key)) problems.push(`Missing key "${key}".`);
    if (Object.hasOwn(doc, "schemaVersion") && doc.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion must be ${SCHEMA_VERSION}.`);
    if (Object.hasOwn(doc, "modelTier") && !TIER_IDS.includes(/** @type {ModelTier} */ (doc.modelTier))) {
        problems.push(`modelTier must be one of ${TIER_IDS.join(", ")}.`);
    }
    if (Object.hasOwn(doc, "agents")) {
        if (!Array.isArray(doc.agents)) problems.push("agents must be an array.");
        else {
            for (const agent of doc.agents) {
                if (!allowed.agents.includes(agent)) problems.push(`agents: "${String(agent)}" is not an installed agent (${allowed.agents.join(", ") || "none detected"}).`);
            }
            if (new Set(doc.agents).size !== doc.agents.length) problems.push("agents lists an agent twice.");
        }
    }
    if (Object.hasOwn(doc, "bootMode")) {
        if (allowed.bootModes.length === 0) {
            if (doc.bootMode !== null) problems.push("bootMode must be null on this platform.");
        } else if (!allowed.bootModes.includes(/** @type {string} */ (doc.bootMode))) {
            problems.push(`bootMode must be one of ${allowed.bootModes.join(", ")}.`);
        }
    }
    if (Object.hasOwn(doc, "qmdFolders")) {
        const isAbsolute = allowed.os === "win32" ? path.win32.isAbsolute : path.posix.isAbsolute;
        if (!Array.isArray(doc.qmdFolders)) problems.push("qmdFolders must be an array.");
        else {
            for (const folder of doc.qmdFolders) {
                if (typeof folder !== "string" || !isAbsolute(folder)) problems.push(`qmdFolders: ${JSON.stringify(folder)} is not an absolute path.`);
            }
            if (new Set(doc.qmdFolders).size !== doc.qmdFolders.length) problems.push("qmdFolders lists a folder twice.");
        }
    }
    return problems;
}

/**
 * The saved choices (choices.json, written after a successful apply), checked for
 * structure, with agents that are no longer installed left out. Null when never saved.
 * @param {Facts} facts
 * @returns {Choices | null}
 */
export function savedChoices(facts) {
    if (facts.saved === null) return null;
    const problems = choiceProblems(facts.saved, { os: facts.platform, agents: AGENT_IDS, bootModes: facts.platform === "linux" ? ["boot", "login"] : [] });
    if (problems.length > 0) throw new Error(`Saved choices (~/.config/local-memory-setup/choices.json) are invalid; fix or delete the file:\n- ${problems.join("\n- ")}`);
    const saved = /** @type {Choices} */ (facts.saved);
    return { ...saved, agents: saved.agents.filter((id) => facts.agents[id].installed) };
}

/**
 * Tiers compatible with memories LongMemory already stores: its database holds vectors
 * from the model in its settings file. Null while it stores none. LongMemory creates and
 * migrates the database file when it starts (src/stores/sqlite/sqlite_store.ts), so the
 * file alone says nothing; the stored memory rows do. A database that could not be counted
 * locks, to fail closed. The QMD half of a tier needs no lock: QMD's index.yml decides it.
 * @param {Facts} facts
 * @returns {ModelTier[] | null}
 */
export function lockedTiers(facts) {
    const { envModel, storedMemories, memoryCountUnknown } = facts.longmemory;
    const holdsMemories = (storedMemories ?? 0) > 0 || memoryCountUnknown === true;
    if (!holdsMemories || envModel === undefined) return null;
    return TIER_IDS.filter((id) => MODEL_TIERS[id].longmemory.model === envModel);
}

/** @param {Facts} facts @returns {Choices} */
export function recommendedChoices(facts) {
    const saved = savedChoices(facts);
    if (saved !== null) return saved;
    const locked = lockedTiers(facts);
    const byHardware = recommendTier(facts.hardware);
    return {
        schemaVersion: SCHEMA_VERSION,
        modelTier: locked !== null && locked.length > 0 && !locked.includes(byHardware) ? locked[0] : byHardware,
        agents: AGENT_IDS.filter((id) => facts.agents[id].installed),
        bootMode: facts.platform === "linux" ? (facts.lingerEnabled || facts.sudoNonInteractive || facts.selfLingerAllowed === true ? "boot" : "login") : null,
        qmdFolders: defaultQmdFolders(facts),
    };
}

/** Steps that install or build QMD or LongMemory, and so need MIN_NODE (layout.mjs). */
const BUILD_STEPS = ["install-qmd", "install-longmemory", "rebuild-qmd", "rebuild-longmemory"];

/**
 * The pending steps the Node that runs builds (`nodeVersion`) is too old for. Checks and
 * repairs that build nothing run on any Node 22.
 * @param {readonly { id: string }[]} pending
 * @param {string} nodeVersion
 * @returns {string[]}
 */
export function stepsNeedingNewerNode(pending, nodeVersion) {
    return nodeAtLeast(nodeVersion, MIN_NODE) ? [] : pending.flatMap((entry) => (BUILD_STEPS.includes(entry.id) ? [entry.id] : []));
}

/**
 * The folders QMD indexes by default: ~/notes when it exists; else, when QMD has no
 * collection at all yet, a new ~/notes (created with a short README, as the first skill
 * version did). An existing index's collections are never changed.
 * @param {Facts} facts
 * @returns {string[]}
 */
export function defaultQmdFolders(facts) {
    if (facts.notesDir !== null) return [facts.notesDir];
    return facts.notesPath !== undefined && facts.qmd.collectionPaths.length === 0 ? [facts.notesPath] : [];
}

/**
 * The notes folder apply creates (with NOTES_README) before indexing it: ~/notes when it
 * is chosen, does not exist yet, and is not already a collection. Any other chosen
 * folder must already exist.
 * @param {Facts} facts
 * @param {Choices} choices
 * @returns {string | null}
 */
export function newNotesFolder(facts, choices) {
    const notes = facts.notesPath;
    return facts.notesDir === null && notes !== undefined && choices.qmdFolders.includes(notes) && !facts.qmd.collectionPaths.includes(notes) ? notes : null;
}

/* ------------------------------------------------------------ models */

/**
 * True when QMD has no index yet: no index.yml `models` block and no collections. Only
 * then does the chosen size set QMD's model. An index with collections but no models
 * block (written by an older QMD, or by hand) was built with QMD's defaults, so those stay.
 * @param {Facts} facts
 */
export function qmdIndexIsNew(facts) {
    return facts.qmd.configModels === undefined && facts.qmd.collectionPaths.length === 0;
}

/**
 * The models QMD will use. An index.yml `models` block wins (QMD resolves
 * config before env and default, and persists what it resolved); an existing index
 * without one keeps QMD's defaults; only a new index takes the tier's embed model,
 * which apply then writes into index.yml.
 * @param {Facts} facts
 * @param {ModelTier} tier
 * @returns {Required<QmdModels>}
 */
export function effectiveQmdModels(facts, tier) {
    const configured = facts.qmd.configModels;
    if (qmdIndexIsNew(facts)) return { ...QMD_DEFAULT_MODELS, embed: MODEL_TIERS[tier].qmd.uri };
    if (configured === undefined) return { ...QMD_DEFAULT_MODELS };
    return {
        embed: configured.embed ?? QMD_DEFAULT_MODELS.embed,
        generate: configured.generate ?? QMD_DEFAULT_MODELS.generate,
        rerank: configured.rerank ?? QMD_DEFAULT_MODELS.rerank,
    };
}

/**
 * What QMD will download the first time it needs its models, in plain words. The setup
 * never downloads QMD models itself: QMD fetches each one lazily on first use, and its
 * own pull would delete and refetch models it cached earlier.
 * @param {Facts} facts
 * @param {ModelTier} tier
 */
export function qmdFirstUseDownload(facts, tier) {
    const uris = [...new Set(Object.values(effectiveQmdModels(facts, tier)))];
    const cache = facts.qmd.modelCache;
    // Without a cache check (tests), every model counts: an upper bound.
    const missing = cache === undefined ? uris : uris.filter((uri) => !cache.cached.includes(uri));
    const bytes = missing.reduce((sum, uri) => sum + (QMD_MODEL_BYTES[uri] ?? 0), 0);
    const unknown = missing.some((uri) => QMD_MODEL_BYTES[uri] === undefined || (cache?.unknown ?? []).includes(uri));
    if (missing.length === 0) return { bytes: 0, note: "QMD's search models are already downloaded on this computer." };
    const extra = unknown ? " plus models whose size or download state this setup cannot tell" : "";
    return {
        bytes,
        note: `QMD downloads its search models the first time it needs them, so the first search or indexing is slow (${cache === undefined ? "up to " : ""}${aboutGb(bytes)}${extra}).`,
    };
}

/** @param {ModelTier} tier */
export function tierDownloadBytes(tier) {
    const models = MODEL_TIERS[tier];
    return [models.qmd.uri, QMD_DEFAULT_MODELS.generate, QMD_DEFAULT_MODELS.rerank].reduce((sum, uri) => sum + QMD_MODEL_BYTES[uri], 0) + OLLAMA_MODEL_BYTES[models.longmemory.model];
}

/* ------------------------------------------------------------ Ollama */

/**
 * Ollama's owner after this install. An install the skill performs is predicted:
 * install.sh creates the system unit on Linux, winget installs the app on Windows,
 * and the Homebrew formula on macOS has no owner of its own. A server that already
 * answers is never reinstalled, so it predicts no install.
 * @param {Facts} facts
 */
export function predictedOllamaOwner(facts) {
    const { ollama } = facts;
    const willInstall = !ollama.installed && !ollama.healthy;
    if (facts.platform === "linux") return ollamaServicePlan({ platform: "linux", systemUnitLoaded: ollama.systemUnit.loaded || willInstall });
    if (facts.platform === "darwin") return ollamaServicePlan({ platform: "darwin", ollamaApp: ollama.ollamaApp, brewService: ollama.brewService });
    return ollamaServicePlan({ platform: "win32", ollamaApp: ollama.ollamaApp || willInstall });
}

/**
 * True when Ollama answers but not from the owner the skill would manage: a manual
 * `ollama serve`, a snap or docker, an app in a custom folder. Such a server is left alone.
 * @param {Facts} facts
 */
export function ollamaForeign(facts) {
    const owner = predictedOllamaOwner(facts).owner;
    if (!facts.ollama.healthy) return false;
    if (owner === "skill") return !facts.services.ollama;
    // A setup-owned service with an old runner is the setup's own, not foreign.
    if (owner === "system-unit") return !facts.ollama.systemUnit.active;
    return false;
}

/* ------------------------------------------------------------ actions */

const NO_SYSTEMD =
    "systemd is not running on this Linux system (WSL without systemd, or a container), so no service can be registered. In WSL, add [boot] systemd=true to /etc/wsl.conf, run wsl --shutdown, then plan again.";

/**
 * @param {Partial<Action> & Pick<Action, "id" | "summary" | "alreadyDone" | "problem">} fields
 * @returns {Action}
 */
function action(fields) {
    return { needsAdmin: false, adminCommand: null, downloadBytes: 0, blocker: null, ...fields };
}

/** Native memory servers run only inside an agent's stdio connection. */
function qmdServerAction(facts) {
    const unmanagedHttp = facts.qmd.healthy && !facts.services.qmd;
    const foreignRegistration = (facts.foreignServices ?? []).includes("qmd");
    return action({
        id: "start-qmd",
        summary: facts.services.qmd
            ? "Retire this setup's old QMD HTTP service; agents will launch QMD over a private stdio connection."
            : "Prepare reviewed QMD for private stdio connections from agents.",
        alreadyDone: qmdServerReady(facts),
        blocker: foreignRegistration
            ? "An unmarked service registration occupies this setup's QMD service name. Resolve it manually before migrating to stdio."
            : unmanagedHttp
              ? "A QMD HTTP server is answering outside this setup's managed service. Stop that listener before migrating memory access to stdio."
              : null,
        problem: "The reviewed QMD stdio runtime is missing or the setup's old HTTP service is still registered.",
    });
}

/** @param {Facts} facts */
function qmdServerReady(facts) {
    return facts.nativeRuntime === true && facts.qmd.reviewed === true && !facts.services.qmd && !(facts.foreignServices ?? []).includes("qmd") && !(facts.qmd.healthy && !facts.services.qmd);
}

/** LongMemory steps `--update` runs, and the only ones it treats as remaining afterwards. */
const LONGMEMORY_ACTIONS = ["install-longmemory", "rebuild-longmemory", "start-longmemory"];

/** @param {string} id */
export function isLongMemoryAction(id) {
    return LONGMEMORY_ACTIONS.includes(id);
}

/**
 * Native LongMemory is current only when a verified build (main, when resolved) and the launcher are ready and
 * no legacy listener can continue exposing the shared database over unauthenticated HTTP.
 * @param {Facts} facts
 */
export function longMemoryRestartPending(facts) {
    const { built, current, main } = facts.longmemory;
    const unmanagedHttp = facts.longmemory.healthy && !facts.services.longmemory;
    const foreignRegistration = (facts.foreignServices ?? []).includes("longmemory");
    // Without a resolved main (the offline check), being behind main is not a problem.
    const staleBuild = !built || (main !== undefined && current !== main);
    return facts.nativeRuntime !== true || staleBuild || facts.services.longmemory || unmanagedHttp || foreignRegistration;
}

/**
 * Build the resolved main when it is not the running build. The reviewed baseline commit
 * uses the committed lockfile; any other commit a freshly generated one that must pass the
 * production audit gate. Without a resolved main, only whether a verified build runs counts.
 * @param {Facts} facts
 */
function longMemoryInstallAction(facts) {
    const { built, main, current } = facts.longmemory;
    if (main === undefined) {
        return action({
            id: "install-longmemory",
            summary: "Download and build LongMemory, a memory server your AI agents save to and recall from.",
            downloadBytes: built ? 0 : LONGMEMORY_BUILD_BYTES,
            alreadyDone: built,
            problem: "No verified LongMemory build is current.",
        });
    }
    const short = shortSha(main);
    const differs = !built || current !== main;
    const running = current === undefined ? "No LongMemory build is running." : `The running build is ${shortSha(current)}.`;
    const graph =
        main === LONGMEMORY_COMMIT
            ? "its reviewed dependency lock"
            : "a freshly generated dependency lock that must pass npm audit with no high or critical production advisories";
    return action({
        id: "install-longmemory",
        summary: differs ? `Build LongMemory main @ ${short} with ${graph}. ${running}` : `LongMemory main @ ${short} is the running build.`,
        downloadBytes: differs ? LONGMEMORY_BUILD_BYTES : 0,
        alreadyDone: !differs,
        problem: `LongMemory is not running main @ ${short}.`,
    });
}

/**
 * Retire this setup's old HTTP service and leave native LongMemory available to stdio
 * launchers. An unmanaged HTTP listener blocks this security migration.
 * @param {Facts} facts
 */
function longMemoryServerAction(facts) {
    const pending = longMemoryRestartPending(facts);
    const unmanagedHttp = facts.longmemory.healthy && !facts.services.longmemory;
    const foreignRegistration = (facts.foreignServices ?? []).includes("longmemory");
    return action({
        id: "start-longmemory",
        summary: facts.services.longmemory
            ? "Retire this setup's old LongMemory HTTP service; agents will launch the verified LongMemory build over stdio."
            : "Prepare the verified LongMemory build for private stdio connections from agents.",
        alreadyDone: !pending,
        blocker: foreignRegistration
            ? "An unmarked service registration occupies this setup's LongMemory service name. Resolve it manually before migrating to stdio."
            : unmanagedHttp
              ? "A LongMemory HTTP server is answering outside this setup's managed service. Stop that listener before migrating memory access to stdio."
              : null,
        problem: "The verified LongMemory stdio runtime is missing or the setup's old HTTP service is still registered.",
    });
}

/**
 * Native modules (better-sqlite3) built for a different Node ABI than the Node the setup
 * runs them with fail to load: rebuild them before any service starts.
 * @param {Facts} facts
 * @param {"qmd" | "longmemory"} component
 */
function rebuildAction(facts, component) {
    const built = component === "qmd" ? facts.qmd.nativeAbi : facts.longmemory.nativeAbi;
    const label = component === "qmd" ? "QMD" : "LongMemory";
    const current = built === undefined || facts.nodeAbi === undefined || built === facts.nodeAbi;
    // A QMD the user installed is never rebuilt: its own service or shell may run it with the Node it was built for.
    const adopted = component === "qmd" && facts.qmd.installedBySetup !== true && facts.qmd.reviewedOwned !== true;
    return action({
        id: `rebuild-${component}`,
        summary: current
            ? `${label}'s native parts match the Node.js this setup uses.`
            : adopted
              ? `Leave the QMD in ${facts.qmd.packageDir ?? "~/.local"} as it is; this setup did not install it and does not rebuild it.`
              : `Rebuild ${label}'s native parts for the Node.js this setup uses (they were built for Node ABI ${built}; it has ABI ${facts.nodeAbi}), and restart ${label} if this setup runs it.`,
        alreadyDone: current,
        blocker:
            !current && adopted
                ? `The QMD in ${facts.qmd.packageDir ?? "~/.local"} was built for Node ABI ${built}, but this setup runs Node ABI ${facts.nodeAbi}, and it does not rebuild a QMD it did not install. Run the setup with the Node that QMD was built for, or rebuild QMD yourself (npm rebuild in its folder), then plan again.`
                : null,
        problem: `${label}'s native parts were built for a different Node.js version.`,
    });
}

/**
 * Global memory-usage instructions for one chosen agent (see agent_instructions.mjs).
 * @param {Facts} facts
 * @param {Choices} choices
 * @param {AgentId} id
 */
function instructionsAction(facts, choices, id) {
    const found = facts.instructions ?? {
        shared: false,
        claudeRules: false,
        claudeRulesExists: false,
        claudeRulesSeenByGrok: false,
        grokCompatRules: true,
        grokImportsClaudeRules: false,
        grokExtraDir: false,
        grokEditable: true,
        codexBlock: false,
        opencodeListed: false,
    };
    const grokMode = grokInstructionMode({
        compatRules: found.grokCompatRules,
        claudeRulesAvailable: choices.agents.includes("claude") || found.claudeRulesExists,
        claudeRulesSeenByGrok: found.claudeRulesSeenByGrok,
        importsClaudeRules: found.grokImportsClaudeRules,
    });
    const done = {
        claude: found.claudeRules,
        codex: found.codexBlock,
        grok: grokMode === "claude-rules" ? found.claudeRules && !found.grokExtraDir : grokMode === "extra-rule-dir" && found.shared && found.grokExtraDir,
        opencode: found.shared && found.opencodeListed,
    };
    const where = {
        claude: "a rules file in Claude Code's settings folder",
        codex: "a marked section of its global AGENTS file",
        grok: grokMode === "claude-rules" ? "Claude Code's rules file, which Grok already reads" : "a rules folder listed in Grok's settings",
        opencode: "the instructions list in its settings",
    };
    const grokNeedsEdit = grokMode === "extra-rule-dir" ? !found.grokExtraDir : found.grokExtraDir;
    return action({
        id: `instructions-${id}`,
        summary: `Add memory usage instructions to ${AGENT_LABELS[id]}'s global instructions (${where[id]}), so it recalls and stores memories on its own.`,
        alreadyDone: done[id],
        blocker:
            facts.agentProblems?.[id] !== undefined
                ? (facts.agentProblems[id] ?? null)
                : id !== "grok" || done.grok
                  ? null
                : grokMode === "unsupported"
                  ? "Grok's Claude-rules setting (GROK_CLAUDE_RULES_ENABLED or compat.claude.rules in its config.toml) is in a form this setup cannot read. Set it to true or false by hand, then plan again."
                  : grokNeedsEdit && !found.grokEditable
                    ? "Grok's config.toml defines [paths] in a form this setup does not edit (an inline table, dotted or quoted keys). Add the setup's folder to extra_rule_dirs by hand, then plan again."
                    : null,
        problem: `${AGENT_LABELS[id]}'s memory usage instructions are missing or out of date.`,
    });
}

/** @param {Facts} facts */
function qmdInstallAction(facts) {
    const { version, foreignCommand, packageDir, reviewedOwned, reviewed } = facts.qmd;
    if (reviewed === true) return action({ id: "install-qmd", summary: `Use reviewed QMD ${QMD_VERSION} and its pinned dependency graph.`, alreadyDone: true, problem: "" });
    const setupOwnedLegacy = facts.qmd.installedBySetup === true;
    const foreignInstall = (version !== null || packageDir !== undefined || foreignCommand !== undefined) && !setupOwnedLegacy && reviewedOwned !== true;
    if (foreignInstall) {
        const location = packageDir ?? foreignCommand ?? "an unknown location";
        return action({
            id: "install-qmd",
            summary: `Leave the existing QMD at ${location} untouched; it is outside this setup's reviewed install.`,
            alreadyDone: false,
            blocker: `An existing QMD installation was found at ${location}. This setup will not replace or adopt it because its dependency graph and HTTP service ownership are not verified. Stop its HTTP service and remove or move the foreign command before applying reviewed QMD ${QMD_VERSION}.`,
            problem: "QMD is not installed from this setup's reviewed dependency graph.",
        });
    }
    return action({
        id: "install-qmd",
        summary: setupOwnedLegacy
            ? `Replace this setup's legacy QMD with reviewed QMD ${QMD_VERSION} and its pinned dependency graph.`
            : `Install reviewed QMD ${QMD_VERSION} and its pinned dependency graph.`,
        downloadBytes: QMD_PACKAGE_BYTES[facts.platform],
        alreadyDone: false,
        problem: `Reviewed QMD ${QMD_VERSION} is not installed.`,
    });
}

/** @param {Facts} facts */
function ollamaInstallAction(facts) {
    const bytes = ollamaInstallerBytes(facts.platform, facts.arch);
    if (!facts.ollama.installed && facts.ollama.healthy) {
        return action({
            id: "install-ollama",
            summary: "Use the Ollama server already answering on this computer. No ollama command was found, so models are downloaded through its API.",
            alreadyDone: true,
            problem: "",
        });
    }
    const base = { id: "install-ollama", downloadBytes: bytes, alreadyDone: facts.ollama.installed, problem: "Ollama is not installed." };
    if (facts.platform === "linux") {
        return action({
            ...base,
            summary: `Install Ollama with its official installer (${aboutGb(bytes)}). It runs the memory model on this computer and needs the admin password once. With an AMD graphics card it also downloads ROCm (${aboutGb(OLLAMA_ROCM_BYTES)}); with an NVIDIA card and no working driver it installs NVIDIA's driver packages.`,
            needsAdmin: !facts.sudoNonInteractive,
            adminCommand: ollamaAdminCommand(OLLAMA_VERSION),
        });
    }
    if (facts.platform === "darwin") {
        return action({
            ...base,
            summary: "Install Ollama with Homebrew. It runs the memory model on this computer.",
            needsAdmin: !facts.brewAvailable,
            adminCommand: "Install Homebrew from https://brew.sh, then run: brew install ollama",
        });
    }
    return action({ ...base, summary: "Install Ollama with winget, accepting its package agreements. It runs the memory model on this computer and needs no admin rights." });
}

/**
 * Ordered actions for `choices`: private storage, reviewed runtimes, settings, then
 * agent migration. Ollama must serve before its model is pulled.
 * @param {Facts} facts
 * @param {Choices} choices
 * @returns {Action[]}
 */
export function planActions(facts, choices) {
    const tier = MODEL_TIERS[choices.modelTier];
    const owner = predictedOllamaOwner(facts);
    const foreignOllama = ollamaForeign(facts);
    const startWhen = facts.platform === "linux" && choices.bootMode === "boot" ? "every time the computer starts" : "every time you log in";
    const qmdModels = effectiveQmdModels(facts, choices.modelTier);
    const unit = facts.ollama.systemUnit;

    const actions = [
        action({
            id: "secure-storage",
            summary: "Restrict memory databases, indexes, settings, and model cache to this user.",
            alreadyDone: facts.privateStorage === true,
            problem: "Memory and QMD storage permissions are not private.",
        }),
        qmdInstallAction(facts),
        rebuildAction(facts, "qmd"),
        longMemoryInstallAction(facts),
        rebuildAction(facts, "longmemory"),
        ollamaInstallAction(facts),
        action({
            id: "start-ollama",
            summary: foreignOllama
                ? "Leave Ollama as it is: it is already running, started outside this setup."
                : owner.owner === "system-unit"
                  ? "Make sure the Ollama system service is switched on. It starts every time the computer starts."
                  : owner.owner === "external"
                    ? `Start Ollama through ${owner.by}, which already starts it when you log in.`
                    : `Start Ollama and have it start again ${startWhen}.`,
            needsAdmin: !foreignOllama && owner.owner === "system-unit" && facts.ollama.installed && !(unit.enabled && unit.active) && !facts.sudoNonInteractive,
            adminCommand: "sudo systemctl enable --now ollama.service",
            alreadyDone:
                foreignOllama ||
                (facts.ollama.healthy &&
                    (owner.owner === "system-unit"
                        ? unit.enabled && unit.active
                        : owner.owner === "skill"
                          ? facts.services.ollama && !(facts.staleServices ?? []).includes("ollama")
                          : true)),
            blocker: facts.withoutSystemd === true && owner.owner !== "external" && !facts.ollama.healthy ? NO_SYSTEMD : null,
            problem: "Ollama is not running or not set to start automatically.",
        }),
        action({
            id: "pull-memory-model",
            summary: `Download the memory model into Ollama (${aboutGb(OLLAMA_MODEL_BYTES[tier.longmemory.model])}).`,
            downloadBytes: OLLAMA_MODEL_BYTES[tier.longmemory.model],
            alreadyDone: ollamaHasModel(facts.ollama.models, tier.longmemory.model),
            problem: "The memory model is missing from Ollama.",
        }),
        action({
            id: "write-settings",
            summary:
                facts.qmd.foreignCommand === undefined
                    ? "Save private settings and the recorded native launcher paths for this user."
                    : `Save private settings and launcher paths. The terminal keeps its existing qmd command (${facts.qmd.foreignCommand}).`,
            alreadyDone:
                facts.settingsWritten && facts.privateStorage === true && facts.nativeRuntime === true && facts.qmd.reviewed === true && facts.longmemory.built && facts.longmemory.envModel === tier.longmemory.model,
            problem: "Private settings or reviewed native launch paths are missing or out of date.",
        }),
        action({
            id: "set-search-model",
            summary: qmdIndexIsNew(facts)
                ? "Set the search model for QMD's new index."
                : `Keep the search models QMD's index already uses (${qmdModels.embed}).`,
            alreadyDone: !qmdIndexIsNew(facts),
            problem: "QMD's index has no search model set.",
        }),
        qmdServerAction(facts),
        longMemoryServerAction(facts),
        ...choices.agents.map((id) =>
            action({
                id: `connect-${id}`,
                summary: `Connect ${AGENT_LABELS[id]} to the search and memory servers.`,
                alreadyDone: facts.agents[id].qmd && facts.agents[id].longmemory,
                blocker: facts.agentProblems?.[id] ?? null,
                problem: `${AGENT_LABELS[id]} is not connected to both servers.`,
            }),
        ),
        ...AGENT_IDS.filter((id) => choices.agents.includes(id)).map((id) => instructionsAction(facts, choices, id)),
    ];
    if (choices.qmdFolders.length > 0) {
        actions.push(
            action({
                id: "index-folders",
                summary: `${newNotesFolder(facts, choices) === null ? "" : `Create ${newNotesFolder(facts, choices)} with a short README, as a place for your notes. `}Make these folders searchable: ${choices.qmdFolders.join(", ")}. The first indexing also downloads QMD's embedding model and can take a while; if it is interrupted, the next run continues it.`,
                // Done only when every chosen folder is a collection whose documents all have vectors,
                // so an interrupted `qmd embed` is resumed by the next apply. An index that cannot
                // be read is not assumed complete.
                // On a Node that cannot read QMD's index without writing (embeddingUnchecked), only
                // collection membership is checked; the plan notes it.
                alreadyDone:
                    facts.qmd.embeddingUnknown !== true &&
                    choices.qmdFolders.every((folder) => facts.qmd.collectionPaths.includes(folder) && !(facts.qmd.unembeddedFolders ?? []).includes(folder)),
                problem: facts.qmd.embeddingUnknown === true ? "QMD's index could not be read, so the chosen folders may not be fully indexed." : "A chosen folder is not fully indexed by QMD.",
            }),
        );
    }
    if (facts.platform === "linux" && choices.bootMode === "boot" && owner.owner === "skill") {
        actions.push(
            action({
                id: "enable-boot-start",
                summary: "Let Ollama's user service start at boot before anyone logs in. This may ask for the admin password once.",
                needsAdmin: !facts.lingerEnabled && !facts.sudoNonInteractive && facts.selfLingerAllowed !== true,
                adminCommand: `sudo loginctl enable-linger ${facts.username}`,
                alreadyDone: facts.lingerEnabled,
                problem: "Start-at-boot (systemd linger) is off.",
            }),
        );
    }
    return actions;
}

/** @param {readonly Action[]} actions */
export function totals(actions) {
    const pending = actions.filter((entry) => !entry.alreadyDone);
    return {
        downloadBytes: pending.reduce((sum, entry) => sum + entry.downloadBytes, 0),
        needsAdmin: pending.some((entry) => entry.needsAdmin),
        blockers: pending.flatMap((entry) => (entry.blocker === null ? [] : [entry.blocker])),
    };
}

/**
 * The plan's view of an action: `problem` is for --check, and an admin command is
 * shown only when the step needs one.
 * @param {Action} entry
 */
function publicAction(entry) {
    const { problem: _problem, ...rest } = entry;
    return { ...rest, adminCommand: entry.needsAdmin ? entry.adminCommand : null };
}

/**
 * @param {Facts} facts
 */
export function buildPlan(facts) {
    const saved = savedChoices(facts);
    const recommended = recommendedChoices(facts);
    const actions = planActions(facts, recommended);
    return {
        schemaVersion: SCHEMA_VERSION,
        platform: { os: facts.platform, arch: facts.arch, node: facts.nodeVersion },
        hardware: { ...facts.hardware, appleSilicon: facts.hardware.gpu === "apple" },
        detected: {
            disk: facts.disk,
            sudoNonInteractive: facts.sudoNonInteractive,
            lingerEnabled: facts.lingerEnabled,
            agents: facts.agents,
            qmd: { ...facts.qmd, models: effectiveQmdModels(facts, recommended.modelTier) },
            longmemory: facts.longmemory,
            ollama: { ...facts.ollama, owner: predictedOllamaOwner(facts), foreign: ollamaForeign(facts) },
            services: facts.services,
            installedModelTier: saved === null ? null : saved.modelTier,
            lockedTiers: lockedTiers(facts),
            instructions: facts.instructions ?? null,
            nodeAbi: facts.nodeAbi ?? null,
        },
        recommended,
        options: {
            modelTier: TIER_IDS.map((id) => ({ id, approxDownloadBytes: tierDownloadBytes(id), description: MODEL_TIERS[id].description })),
            bootMode: facts.platform === "linux" ? ["boot", "login"] : [],
            agents: AGENT_IDS.filter((id) => facts.agents[id].installed),
        },
        actions: actions.map(publicAction),
        totals: { ...totals(actions), firstUseDownloadBytes: qmdFirstUseDownload(facts, recommended.modelTier).bytes },
        notes: [
            qmdFirstUseDownload(facts, recommended.modelTier).note,
            ...(nodeAtLeast(facts.nodeVersion, MIN_NODE)
                ? []
                : [`This Node.js (${facts.nodeVersion}) can run the setup's checks, but installing or rebuilding QMD or LongMemory needs Node.js ${MIN_NODE.major}.${MIN_NODE.minor} or newer.`]),
            ...(facts.qmd.embeddingUnchecked === true ? ["Whether chosen folders are fully indexed could not be checked on this Node.js; only that they are QMD collections was checked."] : []),
        ],
    };
}

/** @typedef {ReturnType<typeof buildPlan>} Plan */

/**
 * Validate a choices document against `plan`. Every problem is collected, and any
 * problem rejects the whole document before anything is changed.
 * @param {Plan} plan
 * @param {unknown} input
 * @returns {Choices}
 */
export function validateChoices(plan, input) {
    const problems = choiceProblems(input, { os: plan.platform.os, agents: plan.options.agents, bootModes: plan.options.bootMode });
    const locked = plan.detected.lockedTiers;
    const tier = typeof input === "object" && input !== null ? /** @type {Record<string, unknown>} */ (input).modelTier : undefined;
    if (locked !== null && TIER_IDS.includes(/** @type {ModelTier} */ (tier)) && !locked.includes(/** @type {ModelTier} */ (tier))) {
        problems.push(
            `modelTier "${String(tier)}" uses a different memory model than the memories LongMemory already stores (${plan.detected.longmemory.envModel}). Choose ${locked.length > 0 ? locked.join(" or ") : "no other tier"}; switching models makes existing memory vectors unusable.`,
        );
    }
    if (problems.length > 0) throw new Error(`Invalid choices:\n- ${problems.join("\n- ")}`);
    return /** @type {Choices} */ (input);
}

/**
 * The choices apply runs: the file's, validated, or with --yes the plan's recommended
 * choices, which are the saved choices (minus agents no longer installed) when a setup
 * exists. `--apply --yes` is therefore also the repair.
 * @param {Plan} plan
 * @param {unknown | null} fileChoices parsed --choices document, or null for --yes
 */
export function applyChoices(plan, fileChoices) {
    return validateChoices(plan, fileChoices === null ? plan.recommended : fileChoices);
}

/**
 * Chosen folders that must exist now: those QMD does not index yet. A folder already
 * indexed that was moved away does not block a repair; QMD keeps its collection.
 * @param {Choices} choices
 * @param {readonly string[]} collectionPaths
 */
export function foldersToAdd(choices, collectionPaths) {
    return choices.qmdFolders.filter((folder) => !collectionPaths.includes(folder));
}

/**
 * When each server starts again after a reboot, in plain words. A server the setup
 * left alone is reported as not managed by it.
 * @param {Facts} facts
 * @param {Choices} choices
 */
export function startSummary(facts, choices) {
    const userServices = facts.platform === "linux" && choices.bootMode === "boot" ? "when the computer starts" : "when you log in";
    const outside = "not managed by this setup (it was already running)";
    const owner = predictedOllamaOwner(facts);
    return {
        qmd: qmdServerReady(facts) ? "on demand when an agent connects over stdio" : "not ready for native stdio connections",
        longmemory: !longMemoryRestartPending(facts)
            ? "on demand when an agent connects over stdio"
            : "not ready for native stdio connections",
        ollama: ollamaForeign(facts)
            ? outside
            : owner.owner === "system-unit"
              ? "when the computer starts"
              : owner.owner === "external"
                ? `when you log in (${owner.by})`
                : userServices,
    };
}

/**
 * Health report for later sessions. Healthy when every action of the saved
 * choices is already done.
 * @param {Facts} facts
 */
export function checkReport(facts) {
    const saved = savedChoices(facts);
    if (saved === null) {
        return { healthy: false, installed: false, problems: ["Local memory is not set up on this computer yet."], repairActions: [] };
    }
    const pending = planActions(facts, saved).filter((entry) => !entry.alreadyDone);
    return {
        healthy: pending.length === 0,
        installed: true,
        problems: pending.map((entry) => entry.blocker ?? entry.problem),
        repairActions: pending.map((entry) => entry.id),
    };
}
