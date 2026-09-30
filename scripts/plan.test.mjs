import assert from "node:assert/strict";
import test from "node:test";
import {
    applyChoices,
    buildPlan,
    foldersToAdd,
    checkReport,
    effectiveQmdModels,
    lockedTiers,
    newNotesFolder,
    planActions,
    recommendedChoices,
    savedChoices,
    startSummary,
    stepsNeedingNewerNode,
    tierDownloadBytes,
    totals,
    validateChoices,
} from "./plan.mjs";

const GIB = 1024 * 1024 * 1024;
const QWEN06 = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
const QWEN8 = "hf:Qwen/Qwen3-Embedding-8B-GGUF/Qwen3-Embedding-8B-Q8_0.gguf";
const RERANK = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const EXPAND = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";

/**
 * A fresh machine: nothing installed, no agents, no GPU, 16 GB.
 * @param {Partial<import("./plan.mjs").Facts>} overrides
 * @returns {import("./plan.mjs").Facts}
 */
function facts(overrides = {}) {
    const agent = { installed: false, qmd: false, longmemory: false };
    return {
        platform: "linux",
        arch: "x64",
        nodeVersion: "22.22.1",
        username: "ana",
        hardware: { ramBytes: 16 * GIB, vramBytes: 0, gpu: "none" },
        disk: [{ path: "/home/ana/.local/share/local-memory-setup", freeBytes: 100 * GIB }],
        sudoNonInteractive: false,
        lingerEnabled: false,
        brewAvailable: false,
        agents: { claude: agent, codex: agent, grok: agent, opencode: agent },
        qmd: { version: null, healthy: false, collectionPaths: [] },
        longmemory: { built: false, healthy: false, envFile: false, dbExists: false },
        ollama: { installed: false, healthy: false, models: [], systemUnit: { loaded: false, enabled: false, active: false }, ollamaApp: false, brewService: false },
        services: { qmd: false, longmemory: false, ollama: false },
        settingsWritten: false,
        saved: null,
        notesDir: null,
        ...overrides,
    };
}

const SAVED = { schemaVersion: 1, modelTier: /** @type {const} */ ("medium"), agents: /** @type {("claude" | "codex")[]} */ (["claude", "codex"]), bootMode: /** @type {const} */ ("boot"), qmdFolders: ["/home/ana/notes"] };

/** Everything installed and running for SAVED, on Linux with the install.sh system unit. */
function healthyFacts(saved = SAVED) {
    const wired = { installed: true, qmd: true, longmemory: true };
    return facts({
        agents: { claude: wired, codex: wired, grok: { installed: false, qmd: false, longmemory: false }, opencode: { installed: false, qmd: false, longmemory: false } },
        qmd: { version: "2.5.3", healthy: true, collectionPaths: ["/home/ana/notes"], configModels: { embed: QWEN06, generate: EXPAND, rerank: RERANK } },
        longmemory: { built: true, healthy: true, envFile: true, envModel: "bge-m3", dbExists: true, storedMemories: 12 },
        ollama: { installed: true, healthy: true, models: ["bge-m3:latest"], systemUnit: { loaded: true, enabled: true, active: true }, ollamaApp: false, brewService: false },
        services: { qmd: true, longmemory: true, ollama: false },
        settingsWritten: true,
        lingerEnabled: true,
        nodeAbi: "127",
        instructions: {
            shared: true,
            claudeRules: true,
            claudeRulesExists: true,
            claudeRulesSeenByGrok: true,
            grokCompatRules: true,
            grokImportsClaudeRules: false,
            grokExtraDir: false,
            grokEditable: true,
            codexBlock: true,
            opencodeListed: false,
        },
        saved,
    });
}

const find = (actions, id) => actions.find((entry) => entry.id === id);

/* ---------------------------------------------------------------- recommendations */

test("recommended defaults for a fresh Linux laptop without sudo", () => {
    const withAgents = facts({
        agents: {
            claude: { installed: true, qmd: false, longmemory: false },
            codex: { installed: false, qmd: false, longmemory: false },
            grok: { installed: true, qmd: false, longmemory: false },
            opencode: { installed: false, qmd: false, longmemory: false },
        },
        notesDir: "/home/ana/notes",
    });
    assert.deepEqual(recommendedChoices(withAgents), { schemaVersion: 1, modelTier: "medium", agents: ["claude", "grok"], bootMode: "login", qmdFolders: ["/home/ana/notes"] });
});

test("boot mode is recommended when it needs no password, including polkit self-linger", () => {
    assert.equal(recommendedChoices(facts({ lingerEnabled: true })).bootMode, "boot");
    assert.equal(recommendedChoices(facts({ sudoNonInteractive: true })).bootMode, "boot");
    assert.equal(recommendedChoices(facts({ selfLingerAllowed: true })).bootMode, "boot");
});

test("macOS and Windows have no boot mode, and no folder when ~/notes is absent", () => {
    const mac = recommendedChoices(facts({ platform: "darwin", hardware: { ramBytes: 36 * GIB, vramBytes: 36 * GIB, gpu: "apple" } }));
    assert.equal(mac.bootMode, null);
    assert.equal(mac.modelTier, "large");
    assert.deepEqual(mac.qmdFolders, []);
    assert.equal(buildPlan(facts({ platform: "win32" })).options.bootMode.length, 0);
});

test("a saved install is recommended as-is, minus agents that are no longer installed", () => {
    assert.deepEqual(recommendedChoices(healthyFacts()), SAVED);
    const codexGone = healthyFacts();
    codexGone.agents.codex = { installed: false, qmd: false, longmemory: false };
    const plan = buildPlan(codexGone);
    assert.deepEqual(plan.recommended.agents, ["claude"]);
    assert.doesNotThrow(() => validateChoices(plan, plan.recommended));
});

/* ---------------------------------------------------------------- F6: saved choices */

test("corrupt saved choices fail loudly, naming the file, on plan, check, and --yes paths", () => {
    for (const bad of [
        { ...SAVED, modelTier: "xl" },
        { ...SAVED, agents: ["vim"] },
        { ...SAVED, qmdFolders: ["notes"] },
        { ...SAVED, bootMode: "sometimes" },
        "not an object",
    ]) {
        const f = facts({ saved: bad });
        assert.throws(() => buildPlan(f), /choices\.json\) are invalid/);
        assert.throws(() => checkReport(f), /choices\.json\) are invalid/);
    }
    assert.throws(() => savedChoices(facts({ saved: { ...SAVED, modelTier: "xl" } })), /modelTier must be one of/);
});

/* ---------------------------------------------------------------- F32: existing QMD */

test("QMD is installed only when none exists", () => {
    const fresh = find(planActions(facts(), SAVED), "install-qmd");
    assert.equal(fresh.alreadyDone, false);
    assert.equal(fresh.blocker, null);
    assert.equal(fresh.downloadBytes, 405_000_000);
});

test("an existing supported QMD (2.5.3 or 2.8.3) is adopted, never reinstalled or downgraded", () => {
    for (const version of ["2.5.3", "2.8.3"]) {
        const adopted = find(planActions(facts({ qmd: { ...facts().qmd, version } }), SAVED), "install-qmd");
        assert.equal(adopted.alreadyDone, true, version);
        assert.match(adopted.summary, new RegExp(`Use the QMD ${version.replaceAll(".", "\\.")} already installed`));
        assert.equal(adopted.downloadBytes, 0);
    }
});

test("an unsupported installed QMD blocks the plan with a decision, and is left in place", () => {
    const plan = buildPlan(facts({ qmd: { ...facts().qmd, version: "1.9.0" } }));
    const refused = find(plan.actions, "install-qmd");
    assert.equal(refused.alreadyDone, false);
    assert.match(refused.blocker ?? "", /QMD 1\.9\.0 is installed in ~\/\.local, and this skill works only with QMD 2\.5\.3 or 2\.8\.3 or newer.*upgrade it yourself.*@tobilu\/qmd@2\.8\.3/);
    assert.equal(plan.totals.blockers.length, 1);
});

test("a working QMD newer than every checked version is used, in plan, apply, and check alike", () => {
    const working = facts({ qmd: { ...facts().qmd, version: "2.9.0", healthy: true } });
    const adopted = find(planActions(working, SAVED), "install-qmd");
    assert.equal(adopted.alreadyDone, true);
    assert.equal(adopted.blocker, null);
    assert.match(adopted.summary, /newer than the versions this skill was checked with.*kept and used/);
    assert.doesNotMatch(adopted.summary, /npm install|@tobilu\/qmd@/);
    // The same predicate feeds apply's blockers: a repair of other components is not blocked.
    const setUp = healthyFacts();
    const repair = { ...setUp, qmd: { ...setUp.qmd, version: "2.9.0" }, longmemory: { ...setUp.longmemory, healthy: false } };
    assert.deepEqual(buildPlan(repair).totals.blockers, []);
    assert.deepEqual(checkReport(repair).repairActions, ["start-longmemory"]);
    // Decided by the version alone: the same QMD while it is down is still used, so start-qmd can repair it.
    const down = { ...repair, qmd: { ...repair.qmd, healthy: false } };
    assert.equal(find(planActions(down, SAVED), "install-qmd").alreadyDone, true);
    assert.deepEqual(buildPlan(down).totals.blockers, []);
    assert.deepEqual(checkReport(down).repairActions, ["start-qmd", "start-longmemory"]);
});

test("a qmd on PATH from outside ~/.local blocks a second install", () => {
    const blocked = find(planActions(facts({ qmd: { ...facts().qmd, foreignCommand: "/opt/bun/bin/qmd" } }), SAVED), "install-qmd");
    assert.match(blocked.blocker ?? "", /\/opt\/bun\/bin\/qmd/);
});

/* ---------------------------------------------------------------- F33: foreign Ollama */

for (const platform of /** @type {const} */ (["linux", "darwin", "win32"])) {
    test(`${platform}: a healthy Ollama the setup did not register is left alone`, () => {
        const f = facts({ platform, brewAvailable: true, ollama: { ...facts().ollama, installed: true, healthy: true } });
        const choices = { ...SAVED, bootMode: /** @type {"boot" | null} */ (platform === "linux" ? "boot" : null) };
        const actions = planActions(f, choices);
        const start = find(actions, "start-ollama");
        assert.equal(start.alreadyDone, true);
        assert.equal(start.needsAdmin, false);
        assert.match(start.summary, /already running, started outside this setup/);
        assert.equal(startSummary(f, choices).ollama, "not managed by this setup (it was already running)");
    });
}

test("Linux: Ollama served while the system unit is stopped is left alone, not enabled over it", () => {
    const f = facts({ ollama: { ...facts().ollama, installed: true, healthy: true, systemUnit: { loaded: true, enabled: false, active: false } } });
    const start = find(planActions(f, SAVED), "start-ollama");
    assert.equal(start.alreadyDone, true);
    assert.equal(start.needsAdmin, false);
});

test("an Ollama server without a local binary (docker) is used, not reinstalled", () => {
    const f = facts({ ollama: { ...facts().ollama, installed: false, healthy: true } });
    const actions = planActions(f, SAVED);
    assert.equal(find(actions, "install-ollama").alreadyDone, true);
    assert.match(find(actions, "install-ollama").summary, /through its API/);
    assert.equal(find(actions, "start-ollama").alreadyDone, true);
    assert.equal(find(actions, "pull-memory-model").alreadyDone, false);
});

test("the skill's own Ollama service counts as done only when registered and answering", () => {
    const own = facts({ platform: "darwin", brewAvailable: true, ollama: { ...facts().ollama, installed: true, healthy: true }, services: { qmd: false, longmemory: false, ollama: true } });
    const start = find(planActions(own, { ...SAVED, bootMode: null }), "start-ollama");
    assert.equal(start.alreadyDone, true);
    assert.match(start.summary, /^Start Ollama/);
    const down = facts({ platform: "darwin", brewAvailable: true, ollama: { ...facts().ollama, installed: true, healthy: false } });
    assert.equal(find(planActions(down, { ...SAVED, bootMode: null }), "start-ollama").alreadyDone, false);
});

/* ---------------------------------------------------------------- F31: QMD's configured models */

test("QMD's index.yml models decide the QMD model; the tier's model applies only to a fresh index", () => {
    const configured = facts({ qmd: { ...facts().qmd, version: "2.5.3", configModels: { embed: QWEN8, generate: EXPAND, rerank: RERANK } } });
    assert.deepEqual(effectiveQmdModels(configured, "small"), { embed: QWEN8, generate: EXPAND, rerank: RERANK });
    assert.equal(effectiveQmdModels(facts(), "medium").embed, QWEN06);
    // A partial block falls back to QMD's own defaults for the missing roles.
    const partial = facts({ qmd: { ...facts().qmd, configModels: { embed: QWEN8 } } });
    assert.deepEqual(effectiveQmdModels(partial, "medium"), { embed: QWEN8, generate: EXPAND, rerank: RERANK });
});

/* ---------------------------------------------------------------- F21: tier lock */

test("the tier is locked by memories LongMemory already stores, not by a saved file", () => {
    assert.equal(lockedTiers(facts()), null);
    assert.equal(lockedTiers(facts({ saved: SAVED })), null);
    // serve creates and migrates the database at startup: an empty one locks nothing.
    const empty = healthyFacts();
    assert.equal(lockedTiers({ ...empty, longmemory: { ...empty.longmemory, storedMemories: 0 } }), null);
    // A database that could not be counted fails closed.
    assert.deepEqual(lockedTiers({ ...empty, longmemory: { built: true, healthy: true, envFile: true, envModel: "bge-m3", dbExists: true, memoryCountUnknown: true } }), ["medium", "large"]);
    assert.deepEqual(lockedTiers(healthyFacts()), ["medium", "large"]);
    const plan = buildPlan(healthyFacts());
    assert.throws(() => validateChoices(plan, { ...SAVED, modelTier: "small" }), /different memory model.*bge-m3.*medium or large/);
    assert.deepEqual(validateChoices(plan, { ...SAVED, modelTier: "large" }).modelTier, "large");
});

test("a failed first apply (no saved choices, no database) locks nothing and reports not set up", () => {
    const afterFailure = facts({ qmd: { ...facts().qmd, version: "2.5.3" } });
    const plan = buildPlan(afterFailure);
    assert.doesNotThrow(() => validateChoices(plan, { ...SAVED, modelTier: "small", agents: [] }));
    assert.equal(checkReport(afterFailure).installed, false);
});

test("a recommended tier respects the lock when the hardware suggests another", () => {
    const f = facts({ hardware: { ramBytes: 7 * GIB, vramBytes: 0, gpu: "none" }, longmemory: { built: true, healthy: false, envFile: true, envModel: "bge-m3", dbExists: true, storedMemories: 4 } });
    assert.equal(recommendedChoices(f).modelTier, "medium");
});

/* ---------------------------------------------------------------- admin and blockers */

test("fresh Linux without sudo: Ollama's install is the admin step, with its exact command", () => {
    const plan = buildPlan(facts());
    const install = find(plan.actions, "install-ollama");
    assert.equal(install.needsAdmin, true);
    assert.equal(install.adminCommand, "curl -fsSL -o ollama-install.sh https://ollama.com/install.sh && OLLAMA_VERSION=0.34.4 sh ollama-install.sh");
    assert.match(install.summary, /ROCm.*NVIDIA's driver packages/);
    assert.equal(plan.totals.needsAdmin, true);
    assert.equal(plan.detected.ollama.owner.owner, "system-unit");
    // install.sh enables and starts the unit itself, so starting it is not a second admin step.
    assert.equal(find(plan.actions, "start-ollama").needsAdmin, false);
});

test("only a step that needs admin shows an admin command", () => {
    const plan = buildPlan(facts({ sudoNonInteractive: true }));
    for (const entry of plan.actions) if (!entry.needsAdmin) assert.equal(entry.adminCommand, null, entry.id);
    assert.equal(plan.totals.needsAdmin, false);
    assert.ok(plan.actions.every((entry) => !("problem" in entry)));
});

test("start-at-boot needs no admin when polkit allows self-linger", () => {
    const boot = (f) => find(planActions(f, SAVED), "enable-boot-start");
    assert.equal(boot(facts()).needsAdmin, true);
    assert.equal(boot(facts({ selfLingerAllowed: true })).needsAdmin, false);
});

test("Linux without systemd blocks the service steps with a clear reason", () => {
    const plan = buildPlan(facts({ withoutSystemd: true }));
    assert.ok(plan.totals.blockers.some((blocker) => /systemd is not running/.test(blocker)));
    assert.match(find(plan.actions, "start-qmd").blocker ?? "", /wsl\.conf/);
});

test("macOS installs Ollama with Homebrew and owns the service; the app or brew services take over when present", () => {
    const brew = buildPlan(facts({ platform: "darwin", brewAvailable: true }));
    assert.equal(find(brew.actions, "install-ollama").needsAdmin, false);
    assert.equal(brew.detected.ollama.owner.owner, "skill");
    assert.equal(find(buildPlan(facts({ platform: "darwin" })).actions, "install-ollama").needsAdmin, true);
    const app = buildPlan(facts({ platform: "darwin", ollama: { ...facts().ollama, installed: true, ollamaApp: true } }));
    assert.equal(app.detected.ollama.owner.owner, "external");
});

test("Windows relies on the Ollama app's login item after winget installs it", () => {
    const plan = buildPlan(facts({ platform: "win32" }));
    assert.equal(plan.detected.ollama.owner.owner, "external");
    assert.equal(find(plan.actions, "install-ollama").needsAdmin, false);
});

/* ---------------------------------------------------------------- ordering (F4) */

test("actions are ordered so each step's inputs exist, and the deferrable admin step is last", () => {
    const withClaude = facts({ agents: { ...facts().agents, claude: { installed: true, qmd: false, longmemory: false } } });
    const actions = planActions(withClaude, { ...SAVED, agents: ["claude"] });
    const ids = actions.map((entry) => entry.id);
    const before = (a, b) => assert.ok(ids.indexOf(a) < ids.indexOf(b), `${a} before ${b}: ${ids.join(",")}`);
    before("install-ollama", "start-ollama");
    before("start-ollama", "pull-memory-model");
    before("install-qmd", "write-settings");
    before("install-qmd", "set-search-model");
    before("write-settings", "start-qmd");
    before("write-settings", "start-longmemory");
    before("pull-memory-model", "start-longmemory");
    before("start-longmemory", "connect-claude");
    before("connect-claude", "index-folders");
    assert.equal(ids.at(-1), "enable-boot-start");
    const boot = ids.indexOf("enable-boot-start");
    assert.ok(actions.slice(boot + 1).every((entry) => entry.needsAdmin), "no non-admin step follows the deferrable admin step");
});

test("boot start is an action only for Linux boot mode", () => {
    assert.ok(planActions(facts(), { ...SAVED, bootMode: "boot" }).some((entry) => entry.id === "enable-boot-start"));
    assert.ok(!planActions(facts(), { ...SAVED, bootMode: "login" }).some((entry) => entry.id === "enable-boot-start"));
    assert.ok(!planActions(facts({ platform: "darwin" }), { ...SAVED, bootMode: null }).some((entry) => entry.id === "enable-boot-start"));
});

/* ---------------------------------------------------------------- servers left alone */

test("a server already answering on its port, started elsewhere, is left alone", () => {
    const f = facts({ qmd: { ...facts().qmd, version: "2.5.3", healthy: true } });
    const start = find(planActions(f, SAVED), "start-qmd");
    assert.equal(start.alreadyDone, true);
    assert.match(start.summary, /already running, started outside this setup/);
    assert.equal(startSummary(f, SAVED).qmd, "not managed by this setup (it was already running)");
    const ours = { ...f, services: { ...f.services, qmd: true } };
    assert.match(find(planActions(ours, SAVED), "start-qmd").summary, /^Start QMD's search server/);
    assert.equal(startSummary(ours, SAVED).qmd, "when the computer starts");
});

test("write-settings is out of date when the settings file names another memory model", () => {
    const f = healthyFacts();
    assert.equal(find(planActions(f, SAVED), "write-settings").alreadyDone, true);
    assert.equal(find(planActions({ ...f, longmemory: { ...f.longmemory, envModel: "nomic-embed-text" } }, SAVED), "write-settings").alreadyDone, false);
});

/* ---------------------------------------------------------------- totals and sizes */

test("totals count only pending actions and collect blockers", () => {
    const base = { summary: "", needsAdmin: false, adminCommand: null, blocker: null, problem: "" };
    const actions = [
        { ...base, id: "a", needsAdmin: true, adminCommand: "x", downloadBytes: 5, alreadyDone: true, blocker: "ignored: done" },
        { ...base, id: "b", downloadBytes: 7, alreadyDone: false },
        { ...base, id: "c", downloadBytes: 11, alreadyDone: false, blocker: "stop" },
    ];
    assert.deepEqual(totals(actions), { downloadBytes: 18, needsAdmin: false, blockers: ["stop"] });
});

test("the plan's totals match its own pending actions on a fresh Linux x64", () => {
    const plan = buildPlan(facts({ sudoNonInteractive: true }));
    // QMD package + LongMemory build + Ollama tarball + bge-m3. QMD's search models are not
    // downloaded by the setup; the plan reports them as a first-use download instead.
    assert.equal(plan.totals.downloadBytes, 405_000_000 + 544_435_761 + 1_427_703_051 + 1_157_672_605);
    assert.equal(plan.totals.firstUseDownloadBytes, 639_150_592 + 639_153_184 + 1_282_438_912);
    // No cache check in this fixture: every model counts, stated as an upper bound.
    assert.match(plan.notes[0], /downloads its search models the first time it needs them, so the first search or indexing is slow \(up to about 2\.6 GB/);
    assert.ok(!plan.actions.some((entry) => /pull-search/.test(entry.id)));
    assert.deepEqual(plan.totals.blockers, []);
});

test("tier download sizes add the QMD models and the Ollama model", () => {
    assert.equal(tierDownloadBytes("small"), 333_590_944 + 639_153_184 + 1_282_438_912 + 274_302_450);
    assert.equal(tierDownloadBytes("large"), 8_047_105_824 + 639_153_184 + 1_282_438_912 + 1_157_672_605);
});

/* ---------------------------------------------------------------- validation */

test("validateChoices accepts a complete, consistent document", () => {
    const plan = buildPlan(facts({ agents: { ...facts().agents, claude: { installed: true, qmd: false, longmemory: false } } }));
    const choices = { schemaVersion: 1, modelTier: "small", agents: ["claude"], bootMode: "login", qmdFolders: ["/home/ana/notes"] };
    assert.deepEqual(validateChoices(plan, choices), choices);
});

test("validateChoices lists every problem and rejects the whole document", () => {
    const plan = buildPlan(facts());
    assert.throws(
        () => validateChoices(plan, { schemaVersion: 2, modelTier: "huge", agents: ["claude", "claude"], bootMode: "sometimes", qmdFolders: ["notes", "notes"], color: "red" }),
        (error) => {
            const message = String(error);
            for (const expected of [
                'Unknown key "color"',
                "schemaVersion must be 1",
                "modelTier must be one of small, medium, large",
                'agents: "claude" is not an installed agent',
                "agents lists an agent twice",
                "bootMode must be one of boot, login",
                'qmdFolders: "notes" is not an absolute path',
                "qmdFolders lists a folder twice",
            ]) {
                assert.ok(message.includes(expected), `missing: ${expected}\n${message}`);
            }
            return true;
        },
    );
    assert.throws(() => validateChoices(plan, { modelTier: "small" }), /Missing key "agents"[\s\S]*Missing key "bootMode"/);
    assert.throws(() => validateChoices(plan, []), /JSON object/);
    assert.throws(() => validateChoices(plan, null), /JSON object/);
});

test("bootMode must be null outside Linux, and Windows folders must be absolute Windows paths", () => {
    const plan = buildPlan(facts({ platform: "win32" }));
    assert.throws(() => validateChoices(plan, { schemaVersion: 1, modelTier: "small", agents: [], bootMode: "boot", qmdFolders: [] }), /null on this platform/);
    assert.deepEqual(validateChoices(plan, { schemaVersion: 1, modelTier: "small", agents: [], bootMode: null, qmdFolders: ["C:\\Users\\ana\\notes"] }).qmdFolders, ["C:\\Users\\ana\\notes"]);
});

/* ---------------------------------------------------------------- check */

test("check: not installed, healthy, one broken service, and a blocker as the problem text", () => {
    assert.deepEqual(checkReport(facts()), { healthy: false, installed: false, problems: ["Local memory is not set up on this computer yet."], repairActions: [] });
    assert.deepEqual(checkReport(healthyFacts()), { healthy: true, installed: true, problems: [], repairActions: [] });
    const down = healthyFacts();
    const report = checkReport({ ...down, qmd: { ...down.qmd, healthy: false } });
    assert.equal(report.healthy, false);
    assert.deepEqual(report.repairActions, ["start-qmd"]);
    const noSystemd = checkReport({ ...down, withoutSystemd: true, qmd: { ...down.qmd, healthy: false } });
    assert.match(noSystemd.problems[0], /systemd is not running/);
});

test("start summary says boot or login per owner", () => {
    assert.deepEqual(startSummary(healthyFacts(), SAVED), { qmd: "when the computer starts", longmemory: "when the computer starts", ollama: "when the computer starts" });
    const login = startSummary(facts({ platform: "darwin", brewAvailable: true }), { ...SAVED, bootMode: null });
    assert.deepEqual(login, { qmd: "when you log in", longmemory: "when you log in", ollama: "when you log in" });
});

/* ---------------------------------------------------------------- round 2 */

test("the setup's own service with an out-of-date runner is updated, not treated as foreign", () => {
    const stale = { ...healthyFacts(), staleServices: /** @type {("qmd" | "longmemory")[]} */ (["qmd", "longmemory"]) };
    const actions = planActions(stale, SAVED);
    for (const id of ["start-qmd", "start-longmemory"]) {
        assert.equal(find(actions, id).alreadyDone, false, id);
        assert.match(find(actions, id).summary, /^Update .* restart it\.$/);
    }
    assert.deepEqual(startSummary(stale, SAVED), { qmd: "when the computer starts", longmemory: "when the computer starts", ollama: "when the computer starts" });
    assert.deepEqual(checkReport(stale).repairActions, ["start-qmd", "start-longmemory"]);
    // A healthy server that is not the setup's own stays foreign, stale list or not.
    const foreign = { ...stale, services: { qmd: false, longmemory: false, ollama: false } };
    assert.equal(find(planActions(foreign, SAVED), "start-qmd").alreadyDone, true);
});

test("repair with --apply --yes after an agent was uninstalled uses the saved choices without it", () => {
    const f = healthyFacts();
    f.agents.codex = { installed: false, qmd: false, longmemory: false };
    const plan = buildPlan({ ...f, qmd: { ...f.qmd, healthy: false } });
    const choices = applyChoices(plan, null);
    assert.deepEqual(choices.agents, ["claude"]);
    assert.equal(choices.modelTier, "medium");
    assert.throws(() => applyChoices(plan, SAVED), /"codex" is not an installed agent/);
});

test("only folders QMD does not index yet must exist for apply", () => {
    const choices = { ...SAVED, qmdFolders: ["/home/ana/notes", "/home/ana/new"] };
    assert.deepEqual(foldersToAdd(choices, ["/home/ana/notes"]), ["/home/ana/new"]);
    assert.deepEqual(foldersToAdd(SAVED, ["/home/ana/notes"]), []);
});

test("the write-settings summary does not claim to add qmd when another qmd comes first on PATH", () => {
    const f = facts({ qmd: { ...facts().qmd, version: "2.5.3", foreignCommand: "/usr/local/bin/qmd" } });
    assert.match(find(planActions(f, SAVED), "write-settings").summary, /keeps its own qmd command \(\/usr\/local\/bin\/qmd\)/);
});

test("an existing QMD index without a models block keeps QMD's defaults instead of taking the tier's model", () => {
    const GEMMA = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
    const f = facts({ qmd: { version: "2.5.3", healthy: false, collectionPaths: ["/home/ana/docs"] } });
    assert.equal(effectiveQmdModels(f, "medium").embed, GEMMA);
    const set = find(planActions(f, { ...SAVED, bootMode: "login" }), "set-search-model");
    assert.equal(set.alreadyDone, true);
    assert.match(set.summary, /Keep the search models .*embeddinggemma/);
    assert.equal(effectiveQmdModels(facts(), "medium").embed, QWEN06);
});

/* ---------------------------------------------------------------- round 4 */

test("the setup's own Ollama with an out-of-date runner is pending re-registration while it answers", () => {
    const own = facts({
        platform: "darwin",
        brewAvailable: true,
        ollama: { ...facts().ollama, installed: true, healthy: true },
        services: { qmd: false, longmemory: false, ollama: true },
        staleServices: ["ollama"],
    });
    const start = find(planActions(own, { ...SAVED, bootMode: null }), "start-ollama");
    assert.equal(start.alreadyDone, false);
    assert.match(start.summary, /^Start Ollama/);
});

test("native modules built for another Node ABI are rebuilt before any service starts, for a QMD this setup installed", () => {
    const moved = { ...healthyFacts(), nodeAbi: "137", qmd: { ...healthyFacts().qmd, nativeAbi: "127", installedBySetup: true }, longmemory: { ...healthyFacts().longmemory, nativeAbi: "127" } };
    const actions = planActions(moved, SAVED);
    const ids = actions.map((entry) => entry.id);
    for (const id of ["rebuild-qmd", "rebuild-longmemory"]) {
        assert.equal(find(actions, id).alreadyDone, false, id);
        assert.match(find(actions, id).summary, /built for Node ABI 127; it has ABI 137\), and restart/);
        assert.ok(ids.indexOf(id) < ids.indexOf("start-qmd") && ids.indexOf(id) < ids.indexOf("start-longmemory"));
    }
    assert.deepEqual(checkReport(moved).repairActions, ["rebuild-qmd", "rebuild-longmemory"]);
    const same = { ...moved, nodeAbi: "127" };
    assert.equal(find(planActions(same, SAVED), "rebuild-qmd").alreadyDone, true);
});

test("index-folders stays pending while a chosen collection has documents without vectors", () => {
    const f = healthyFacts();
    assert.equal(find(planActions(f, SAVED), "index-folders").alreadyDone, true);
    const interrupted = { ...f, qmd: { ...f.qmd, unembeddedFolders: ["/home/ana/notes"] } };
    const step = find(planActions(interrupted, SAVED), "index-folders");
    assert.equal(step.alreadyDone, false);
    assert.match(step.summary, /if it is interrupted, the next run continues it/);
    assert.deepEqual(checkReport(interrupted).repairActions, ["index-folders"]);
});

test("memory instructions: one action per chosen agent, done from the files each agent reads", () => {
    const all = { ...SAVED, agents: /** @type {("claude" | "codex" | "grok" | "opencode")[]} */ (["opencode", "grok", "codex", "claude"]) };
    const installed = { installed: true, qmd: true, longmemory: true };
    const f = { ...healthyFacts(), agents: { claude: installed, codex: installed, grok: installed, opencode: installed } };
    const ids = planActions(f, all).map((entry) => entry.id).filter((id) => id.startsWith("instructions-"));
    assert.deepEqual(ids, ["instructions-claude", "instructions-codex", "instructions-grok", "instructions-opencode"]);
    const byId = (facts2, choices) => Object.fromEntries(planActions(facts2, choices).filter((entry) => entry.id.startsWith("instructions-")).map((entry) => [entry.id, entry]));
    // Grok through Claude's rules file (compat on, Claude chosen): done without a Grok edit.
    assert.equal(byId(f, all)["instructions-grok"].alreadyDone, true);
    assert.match(byId(f, all)["instructions-grok"].summary, /Claude Code's rules file, which Grok already reads/);
    // Compat off: Grok needs the shared folder in extra_rule_dirs.
    const off = { ...f, instructions: { ...f.instructions, grokCompatRules: false } };
    assert.equal(byId(off, all)["instructions-grok"].alreadyDone, false);
    assert.match(byId(off, all)["instructions-grok"].summary, /a rules folder listed in Grok's settings/);
    // Grok without Claude chosen and without the setup's Claude rules file never relies on it.
    const grokOnly = { ...SAVED, agents: /** @type {"grok"[]} */ (["grok"]) };
    const noClaudeFile = { ...f, instructions: { ...f.instructions, claudeRules: false, claudeRulesExists: false } };
    assert.equal(byId(noClaudeFile, grokOnly)["instructions-grok"].alreadyDone, false);
    // Compat on and our folder also listed: pending, so the duplicate entry is removed.
    const both = { ...f, instructions: { ...f.instructions, grokExtraDir: true } };
    assert.equal(byId(both, all)["instructions-grok"].alreadyDone, false);
    // OpenCode needs the shared file listed; Codex needs its block.
    assert.equal(byId(f, all)["instructions-opencode"].alreadyDone, false);
    assert.equal(byId({ ...f, instructions: { ...f.instructions, opencodeListed: true } }, all)["instructions-opencode"].alreadyDone, true);
    assert.equal(byId({ ...f, instructions: { ...f.instructions, codexBlock: false } }, all)["instructions-codex"].alreadyDone, false);
    // --check offers the repair.
    const current = healthyFacts();
    const instructions = /** @type {NonNullable<typeof current.instructions>} */ (current.instructions);
    assert.deepEqual(checkReport({ ...current, instructions: { ...instructions, claudeRules: false } }).repairActions, ["instructions-claude"]);
});

/* ---------------------------------------------------------------- round 5 */

test("a QMD this setup did not install is never rebuilt: an ABI mismatch blocks, naming both ABIs", () => {
    const adopted = { ...healthyFacts(), nodeAbi: "127", qmd: { ...healthyFacts().qmd, nativeAbi: "137", installedBySetup: false } };
    const step = find(planActions(adopted, SAVED), "rebuild-qmd");
    assert.equal(step.alreadyDone, false);
    assert.match(step.blocker ?? "", /built for Node ABI 137, but this setup runs Node ABI 127, and it does not rebuild a QMD it did not install/);
    assert.match(step.summary, /does not rebuild it/);
    assert.ok(buildPlan(adopted).totals.blockers.some((blocker) => /does not rebuild a QMD/.test(blocker)));
    // Matching ABIs: nothing to do, owned or not.
    assert.equal(find(planActions({ ...adopted, nodeAbi: "137" }, SAVED), "rebuild-qmd").alreadyDone, true);
});

test("index-folders is pending, with its own problem text, when QMD's index cannot be read", () => {
    const f = healthyFacts();
    const unreadable = { ...f, qmd: { ...f.qmd, embeddingUnknown: true } };
    const step = find(planActions(unreadable, SAVED), "index-folders");
    assert.equal(step.alreadyDone, false);
    assert.deepEqual(checkReport(unreadable).problems, ["QMD's index could not be read, so the chosen folders may not be fully indexed."]);
});

test("Grok instructions: an unreadable Claude-rules setting or an uneditable [paths] blocks with an edit-by-hand message", () => {
    const f = healthyFacts();
    const grok = { installed: true, qmd: true, longmemory: true };
    const choices = { ...SAVED, agents: /** @type {("claude" | "grok")[]} */ (["claude", "grok"]) };
    const base = { ...f, agents: { ...f.agents, grok } };
    const instructions = /** @type {NonNullable<typeof f.instructions>} */ (f.instructions);
    const unsupported = { ...base, instructions: { ...instructions, grokCompatRules: /** @type {const} */ ("unsupported") } };
    assert.match(find(planActions(unsupported, choices), "instructions-grok").blocker ?? "", /cannot read. Set it to true or false by hand/);
    const uneditable = { ...base, instructions: { ...instructions, grokCompatRules: false, grokEditable: false } };
    assert.match(find(planActions(uneditable, choices), "instructions-grok").blocker ?? "", /Add the setup's folder to extra_rule_dirs by hand/);
    // Nothing to edit: no blocker even when [paths] is in a form the setup does not edit.
    const fine = { ...base, instructions: { ...instructions, grokEditable: false } };
    assert.equal(find(planActions(fine, choices), "instructions-grok").blocker, null);
});

test("Grok keeps reading Claude's rules file when Claude is no longer chosen but the file is there", () => {
    const f = healthyFacts();
    const grokOnly = { ...SAVED, agents: /** @type {"grok"[]} */ (["grok"]) };
    const withGrok = { ...f, agents: { ...f.agents, grok: { installed: true, qmd: true, longmemory: true } } };
    assert.equal(find(planActions(withGrok, grokOnly), "instructions-grok").alreadyDone, true);
    assert.match(find(planActions(withGrok, grokOnly), "instructions-grok").summary, /Claude Code's rules file, which Grok already reads/);
});

test("the first-use note counts only QMD models not already downloaded, and says when it cannot tell", () => {
    const cached = { ...healthyFacts(), qmd: { ...healthyFacts().qmd, modelCache: { cached: [QWEN06, RERANK, EXPAND], unknown: [] } } };
    assert.deepEqual(buildPlan(cached).notes, ["QMD's search models are already downloaded on this computer."]);
    assert.equal(buildPlan(cached).totals.firstUseDownloadBytes, 0);
    const oneMissing = { ...cached, qmd: { ...cached.qmd, modelCache: { cached: [QWEN06, EXPAND], unknown: [] } } };
    assert.equal(buildPlan(oneMissing).totals.firstUseDownloadBytes, 639_153_184);
    assert.match(buildPlan(oneMissing).notes[0], /first search or indexing is slow \(about 0\.64 GB\)/);
    const custom = "hf:ggml-org/embeddinggemma-300M-GGUF:Q8_0";
    const unknown = { ...cached, qmd: { ...cached.qmd, configModels: { embed: custom, generate: EXPAND, rerank: RERANK }, modelCache: { cached: [EXPAND, RERANK], unknown: [custom] } } };
    assert.match(buildPlan(unknown).notes[0], /plus models whose size or download state this setup cannot tell/);
});

/* ---------------------------------------------------------------- final batch */

const NPM_GLOBAL_QMD = "/opt/homebrew/lib/node_modules/@tobilu/qmd";

test("a compatible QMD in npm's global folder is adopted where it is, and the plan is not blocked", () => {
    // QMD installed the way its README says (npm install -g @tobilu/qmd), nothing in ~/.local.
    const f = facts({
        qmd: { version: "2.8.3", healthy: true, collectionPaths: [], foreignCommand: "/opt/homebrew/bin/qmd", packageDir: NPM_GLOBAL_QMD, installedBySetup: false },
    });
    const plan = buildPlan(f);
    const install = find(plan.actions, "install-qmd");
    assert.equal(install.alreadyDone, true);
    assert.equal(install.summary, `Use the QMD 2.8.3 already installed in ${NPM_GLOBAL_QMD}.`);
    assert.deepEqual(plan.totals.blockers, []);
});

test("an adopted QMD outside ~/.local built for another Node is never rebuilt: the plan names it and stops", () => {
    const f = facts({
        nodeAbi: "127",
        qmd: { version: "2.8.3", healthy: false, collectionPaths: [], packageDir: NPM_GLOBAL_QMD, installedBySetup: false, nativeAbi: "115" },
    });
    const rebuild = find(planActions(f, SAVED), "rebuild-qmd");
    assert.equal(rebuild.alreadyDone, false);
    assert.match(rebuild.blocker ?? "", new RegExp(`The QMD in ${NPM_GLOBAL_QMD} was built for Node ABI 115.*does not rebuild a QMD it did not install`));
    assert.match(rebuild.summary, new RegExp(`Leave the QMD in ${NPM_GLOBAL_QMD} as it is`));
});

test("a QMD version between the supported ones is not called older, and the message names where it is", () => {
    for (const version of ["2.6.0", "1.9.0"]) {
        const refused = find(planActions(facts({ qmd: { ...facts().qmd, version, packageDir: NPM_GLOBAL_QMD } }), SAVED), "install-qmd");
        assert.match(refused.blocker ?? "", new RegExp(`QMD ${version.replaceAll(".", "\\.")} is installed in ${NPM_GLOBAL_QMD}, and this skill works only with`));
        assert.doesNotMatch(`${refused.blocker} ${refused.problem}`, /older/);
        assert.equal(refused.problem, `QMD ${version} is not a version this setup supports.`);
    }
});

test("a qmd command with no QMD package behind it still blocks, and says where the setup looked", () => {
    const blocked = find(planActions(facts({ qmd: { ...facts().qmd, foreignCommand: "/opt/bun/bin/qmd" } }), SAVED), "install-qmd");
    assert.match(blocked.blocker ?? "", /no QMD package could be found for it \(not in ~\/\.local, beside it, or in npm's global folder\)/);
});

test("a chosen agent whose config cannot be read blocks its own steps only, naming the file", () => {
    const problem = "/home/ana/.config/opencode/opencode.json could not be read (Unexpected end of JSON input); fix or remove it, then plan again.";
    const f = facts({ agentProblems: { opencode: problem } });
    const chosen = { ...SAVED, agents: /** @type {("claude" | "opencode")[]} */ (["claude", "opencode"]) };
    const actions = planActions(f, chosen);
    assert.equal(find(actions, "connect-opencode").blocker, problem);
    assert.equal(find(actions, "instructions-opencode").blocker, problem);
    assert.equal(find(actions, "connect-claude").blocker, null);
    assert.equal(find(actions, "instructions-claude").blocker, null);
    // Not chosen: its file has no bearing on the plan.
    assert.ok(planActions(f, SAVED).every((entry) => entry.blocker === null));
});

test("a healthy setup checked on a Node older than 22.15 is healthy; only installs and rebuilds need the newer Node", () => {
    const old = { ...healthyFacts(), nodeVersion: "22.12.0" };
    assert.deepEqual(checkReport(old), { healthy: true, installed: true, problems: [], repairActions: [] });
    assert.ok(buildPlan(old).notes.some((note) => /22\.12\.0.*installing or rebuilding QMD or LongMemory needs Node\.js 22\.15 or newer/.test(note)));
    assert.ok(!buildPlan(healthyFacts()).notes.some((note) => /needs Node\.js 22\.15/.test(note)));
});

test("when this Node cannot read QMD's index, indexing is judged by collection membership and noted, not reported as a problem", () => {
    const set = healthyFacts();
    const unchecked = { ...set, nodeVersion: "22.12.0", qmd: { ...set.qmd, embeddingUnchecked: true } };
    assert.equal(find(planActions(unchecked, SAVED), "index-folders").alreadyDone, true);
    assert.equal(checkReport(unchecked).healthy, true);
    assert.ok(buildPlan(unchecked).notes.some((note) => /only that they are QMD collections was checked/.test(note)));
    // A folder that is not a collection is still a problem.
    const missing = { ...unchecked, qmd: { ...unchecked.qmd, collectionPaths: [] } };
    assert.deepEqual(checkReport(missing).repairActions, ["index-folders"]);
    // A readable index that failed to read stays unknown, not complete.
    assert.equal(find(planActions({ ...set, qmd: { ...set.qmd, embeddingUnknown: true } }, SAVED), "index-folders").alreadyDone, false);
});

test("with no QMD collection yet the plan creates and indexes ~/notes; an existing index is never given it", () => {
    const fresh = facts({ notesPath: "/home/ana/notes" });
    const plan = buildPlan(fresh);
    assert.deepEqual(plan.recommended.qmdFolders, ["/home/ana/notes"]);
    assert.equal(newNotesFolder(fresh, plan.recommended), "/home/ana/notes");
    assert.match(find(plan.actions, "index-folders").summary, /^Create \/home\/ana\/notes with a short README, as a place for your notes\. Make these folders searchable: \/home\/ana\/notes\./);
    // QMD already indexes something: its collections are left as they are and nothing is added.
    const indexed = facts({ notesPath: "/home/ana/notes", qmd: { ...facts().qmd, version: "2.5.3", collectionPaths: ["/home/ana/docs"] } });
    assert.deepEqual(buildPlan(indexed).recommended.qmdFolders, []);
    assert.equal(find(buildPlan(indexed).actions, "index-folders"), undefined);
    // ~/notes already exists: it is used, not created.
    const existing = facts({ notesPath: "/home/ana/notes", notesDir: "/home/ana/notes" });
    assert.deepEqual(buildPlan(existing).recommended.qmdFolders, ["/home/ana/notes"]);
    assert.equal(newNotesFolder(existing, buildPlan(existing).recommended), null);
    assert.doesNotMatch(find(buildPlan(existing).actions, "index-folders").summary, /^Create/);
});

test("only installs and rebuilds need Node 22.15; repairs that build nothing do not", () => {
    const pending = [{ id: "write-settings" }, { id: "install-longmemory" }, { id: "rebuild-qmd" }, { id: "start-qmd" }];
    assert.deepEqual(stepsNeedingNewerNode(pending, "22.12.0"), ["install-longmemory", "rebuild-qmd"]);
    assert.deepEqual(stepsNeedingNewerNode(pending, "22.15.0"), []);
    assert.deepEqual(stepsNeedingNewerNode([{ id: "start-qmd" }, { id: "connect-claude" }], "22.12.0"), []);
});
