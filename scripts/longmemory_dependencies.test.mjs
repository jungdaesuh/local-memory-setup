/**
 * The root-only dependency derivation, lockfile generation and audit gate for LongMemory
 * commits newer than the reviewed baseline. npm and the LongMemory remote are replaced by
 * a fake `npm` on PATH and a local git repository, so nothing here uses the network.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dependencyFingerprint, reviewedDependencyPaths } from "./dependency_install.mjs";
import { LONGMEMORY_COMMIT, fileSha256 } from "./layout.mjs";
import { buildDirectoryName, currentBuildDir, installLongMemoryCommit, pointCurrentAt } from "./longmemory_build.mjs";
import {
    auditBlockedMessage,
    auditSummaryPasses,
    generateAuditedDependencyGraph,
    lockOnlyInstallArgs,
    parseAuditReport,
    productionAuditArgs,
    rootImporterDependencies,
    rootOnlyManifest,
} from "./longmemory_dependencies.mjs";

const UPSTREAM_PACKAGE = {
    name: "longmemory",
    version: "2.0.0",
    description: "not copied",
    license: "Apache-2.0",
    engines: { node: ">=20" },
    packageManager: "pnpm@11.5.2",
    type: "module",
    main: "dist/index.js",
    types: "dist/index.d.ts",
    bin: { longmemory: "dist/cli/index.js" },
    scripts: { build: "tsc -p tsconfig.json", dev: "tsx src/cli/index.ts" },
    devDependencies: { typescript: "^5.9.3" },
    dependencies: { "@modelcontextprotocol/sdk": "^1.29.0", "better-sqlite3": "^12.11.1" },
};

const PNPM_LOCK = `#  file  : pnpm-lock.yaml

lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@modelcontextprotocol/sdk':
        specifier: ^1.29.0
        version: 1.29.0(@cfworker/json-schema@4.1.1)(zod@4.4.3)
      better-sqlite3:
        specifier: ^12.11.1
        version: 12.11.1
    devDependencies:
      typescript:
        specifier: ^5.9.3
        version: 5.9.4

  apps/vscode-extension:
    devDependencies:
      left-pad:
        specifier: ^1.0.0
        version: 1.3.0

packages:

  better-sqlite3@12.11.1:
    resolution: {integrity: sha512-x}
`;

const EXPECTED_MANIFEST = `${JSON.stringify(
    {
        name: "longmemory",
        version: "2.0.0",
        private: true,
        license: "Apache-2.0",
        engines: { node: ">=20" },
        type: "module",
        main: "dist/index.js",
        types: "dist/index.d.ts",
        scripts: { build: "tsc -p tsconfig.json" },
        dependencies: { "@modelcontextprotocol/sdk": "1.29.0", "better-sqlite3": "12.11.1" },
        devDependencies: { typescript: "5.9.4" },
    },
    null,
    2,
)}\n`;

const CLEAN_AUDIT = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } };
const BLOCKED_AUDIT = {
    auditReportVersion: 2,
    vulnerabilities: {
        hono: {
            name: "hono",
            severity: "high",
            via: [
                { source: 1, name: "hono", title: "Path traversal in hono", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "high" },
                { source: 2, name: "hono", title: "Minor issue", url: "https://github.com/advisories/GHSA-dddd-eeee-ffff", severity: "low" },
            ],
        },
        "@hono/node-server": { name: "@hono/node-server", severity: "high", via: ["hono"] },
        qs: { name: "qs", severity: "moderate", via: [{ source: 3, name: "qs", title: "qs issue", url: "https://github.com/advisories/GHSA-1111-2222-3333", severity: "moderate" }] },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 2, critical: 0, total: 3 } },
};

/** @param {string} prefix @param {(root: string) => void | Promise<void>} operation */
async function withTemp(prefix, operation) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
        await operation(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

/* ------------------------------------------------------------ derivation */

test("the root importer's direct dependencies are read with peer suffixes removed and other importers ignored", () => {
    const importer = rootImporterDependencies(PNPM_LOCK);
    assert.deepEqual([...importer.dependencies], [
        ["@modelcontextprotocol/sdk", { specifier: "^1.29.0", version: "1.29.0" }],
        ["better-sqlite3", { specifier: "^12.11.1", version: "12.11.1" }],
    ]);
    assert.deepEqual([...importer.devDependencies], [["typescript", { specifier: "^5.9.3", version: "5.9.4" }]]);
    assert.equal(importer.optionalDependencies.size, 0);
});

test("the pnpm lockfile must be version 9 with a complete root importer", () => {
    assert.throws(() => rootImporterDependencies(PNPM_LOCK.replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'")), /not 9\.x/);
    assert.throws(() => rootImporterDependencies(PNPM_LOCK.replace("importers:", "importerz:")), /no importers section/);
    assert.throws(() => rootImporterDependencies(PNPM_LOCK.replace("\n  .:\n", "\n  root:\n")), /no root importer/);
    assert.throws(() => rootImporterDependencies(PNPM_LOCK.replace("        version: 12.11.1\n", "")), /better-sqlite3 lacks a specifier or version/);
});

test("the root-only manifest keeps upstream identity and build script and pins the root importer's versions", () => {
    assert.equal(rootOnlyManifest(JSON.stringify(UPSTREAM_PACKAGE), PNPM_LOCK), EXPECTED_MANIFEST);
});

test("the derivation stops when upstream's lockfile and manifest disagree or it declares overrides", () => {
    const upstream = (/** @type {Record<string, unknown>} */ changes) => JSON.stringify({ ...UPSTREAM_PACKAGE, ...changes });
    assert.throws(() => rootOnlyManifest(upstream({ dependencies: { ...UPSTREAM_PACKAGE.dependencies, "better-sqlite3": "^13.0.0" } }), PNPM_LOCK), /resolves better-sqlite3 for \^12\.11\.1, but package\.json asks for \^13\.0\.0/);
    assert.throws(() => rootOnlyManifest(upstream({ dependencies: { ...UPSTREAM_PACKAGE.dependencies, zod: "^4.4.3" } }), PNPM_LOCK), /does not resolve zod/);
    assert.throws(() => rootOnlyManifest(upstream({ devDependencies: {} }), PNPM_LOCK), /root devDependencies lists typescript, which package\.json does not declare/);
    assert.throws(() => rootOnlyManifest(JSON.stringify(UPSTREAM_PACKAGE), PNPM_LOCK.replace("version: 12.11.1\n", "version: link:../sqlite\n")), /not a registry version/);
    assert.throws(() => rootOnlyManifest(upstream({ overrides: { hono: "4.0.0" } }), PNPM_LOCK), /declares overrides/);
    assert.throws(() => rootOnlyManifest(upstream({ pnpm: { overrides: { hono: "4.0.0" } } }), PNPM_LOCK), /declares pnpm\.overrides/);
    assert.throws(() => rootOnlyManifest(upstream({ scripts: { dev: "tsx" } }), PNPM_LOCK), /no build script/);
});

const LONGMEMORY_UPSTREAM = process.env.LONGMEMORY_CHECKOUT ?? "";
const hasBaseline =
    LONGMEMORY_UPSTREAM !== "" && spawnSync("git", ["-C", LONGMEMORY_UPSTREAM, "cat-file", "-e", `${LONGMEMORY_COMMIT}:pnpm-lock.yaml`], { stdio: "ignore" }).status === 0;
test(
    "deriving from the reviewed baseline commit reproduces the committed manifest apart from its audited overrides",
    { skip: !hasBaseline && `set LONGMEMORY_CHECKOUT to a LongMemory checkout containing ${LONGMEMORY_COMMIT}` },
    () => {
        const show = (/** @type {string} */ file) => execFileSync("git", ["-C", LONGMEMORY_UPSTREAM, "show", `${LONGMEMORY_COMMIT}:${file}`], { encoding: "utf8" });
        const committed = JSON.parse(fs.readFileSync(reviewedDependencyPaths("longmemory").packageJson, "utf8"));
        delete committed.overrides;
        assert.equal(rootOnlyManifest(show("package.json"), show("pnpm-lock.yaml")), `${JSON.stringify(committed, null, 2)}\n`);
    },
);

/* ------------------------------------------------------------ audit gate */

test("npm audit reports are summarized and high or critical production entries block", () => {
    const clean = parseAuditReport(JSON.stringify(CLEAN_AUDIT));
    assert.deepEqual(clean, { summary: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }, blocking: [] });
    assert.equal(auditSummaryPasses(clean.summary), true);

    const blocked = parseAuditReport(JSON.stringify(BLOCKED_AUDIT));
    assert.deepEqual(blocked.summary, { info: 0, low: 0, moderate: 1, high: 2, critical: 0 });
    assert.deepEqual(blocked.blocking, [
        { name: "hono", severity: "high", advisories: ["https://github.com/advisories/GHSA-aaaa-bbbb-cccc"] },
        { name: "@hono/node-server", severity: "high", advisories: [] },
    ]);
    assert.equal(auditSummaryPasses(blocked.summary), false);
    const message = auditBlockedMessage(LONGMEMORY_COMMIT, blocked.blocking);
    assert.match(message, new RegExp(`LongMemory main @ ${LONGMEMORY_COMMIT} was not installed`));
    assert.match(message, /hono \(high: https:\/\/github\.com\/advisories\/GHSA-aaaa-bbbb-cccc\); @hono\/node-server \(high\)/);
    assert.match(message, /The running build was kept\./);

    const moderateOnly = { ...CLEAN_AUDIT, metadata: { vulnerabilities: { ...CLEAN_AUDIT.metadata.vulnerabilities, moderate: 4, low: 1 } } };
    assert.equal(auditSummaryPasses(parseAuditReport(JSON.stringify(moderateOnly)).summary), true);
});

test("an npm audit error or malformed report is an error, never a pass", () => {
    assert.throws(() => parseAuditReport(JSON.stringify({ error: { code: "ENOAUDIT", summary: "registry unavailable" } })), /did not return an audit report: registry unavailable/);
    assert.throws(() => parseAuditReport(JSON.stringify({ ...CLEAN_AUDIT, metadata: { vulnerabilities: { ...CLEAN_AUDIT.metadata.vulnerabilities, high: "0" } } })), /"0" high/);
    assert.throws(() => parseAuditReport(JSON.stringify({ ...CLEAN_AUDIT, metadata: { vulnerabilities: { ...CLEAN_AUDIT.metadata.vulnerabilities, critical: 1 } } })), /listed none/);
    assert.throws(() => parseAuditReport("not json"), SyntaxError);
    assert.equal(auditSummaryPasses(null), false);
    assert.equal(auditSummaryPasses({ high: 0, critical: 0 }), false);
});

test("the lockfile is generated without lifecycle scripts and audited for production dependencies only", () => {
    assert.deepEqual(lockOnlyInstallArgs("/checkout"), { args: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], cwd: "/checkout" });
    assert.deepEqual(productionAuditArgs("/checkout"), { args: ["audit", "--omit=dev", "--json"], cwd: "/checkout" });
});

/* ------------------------------------------------------------ fake npm and upstream */

const GENERATED_LOCK = '{"name":"longmemory","lockfileVersion":3,"requires":true,"packages":{}}';

/**
 * A POSIX `npm` that logs its arguments, writes a lockfile for `install`, prints `auditReport`
 * for `audit` (exit 1, like npm with findings), and fakes `ci` and `run build`.
 * @param {string} root @param {unknown} auditReport
 * @returns {{ node: string, log: string }} a Node path whose directory holds the fake npm
 */
function fakeNpm(root, auditReport) {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const log = path.join(root, "npm.log");
    const report = path.join(root, "audit.json");
    fs.writeFileSync(report, JSON.stringify(auditReport));
    fs.writeFileSync(
        path.join(bin, "npm"),
        [
            "#!/bin/sh",
            `printf '%s\\n' "$*" >> '${log}'`,
            'case "$1" in',
            `  install) printf '%s\\n' '${GENERATED_LOCK}' > package-lock.json ;;`,
            `  audit) cat '${report}'; exit 1 ;;`,
            "  ci) mkdir -p node_modules && printf '{}\\n' > node_modules/.package-lock.json ;;",
            "  run) mkdir -p dist/cli && printf '' > dist/cli/index.js ;;",
            '  *) echo "unexpected npm $*" >&2; exit 2 ;;',
            "esac",
            "",
        ].join("\n"),
        { mode: 0o755 },
    );
    return { node: path.join(bin, "node"), log };
}

/** A local git repository standing in for LONGMEMORY_REPO; returns its path and head commit. @param {string} root */
function fakeUpstream(root) {
    const repo = path.join(root, "upstream");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify(UPSTREAM_PACKAGE, null, 4)}\n`);
    fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), PNPM_LOCK);
    fs.writeFileSync(path.join(repo, "package-lock.json"), '{"stale":"upstream lock"}\n');
    fs.writeFileSync(path.join(repo, "tsconfig.json"), "{}\n");
    fs.writeFileSync(path.join(repo, "src", "index.ts"), "export {};\n");
    const git = (/** @type {string[]} */ ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    git("init", "--quiet");
    git("add", ".");
    git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "upstream");
    return { repo, sha: git("rev-parse", "HEAD").trim() };
}

/** @param {string} root */
function tree(root) {
    const longmemoryRoot = path.join(root, "longmemory");
    return {
        buildsDir: path.join(longmemoryRoot, "builds"),
        longmemoryRoot,
        currentLink: path.join(longmemoryRoot, "current"),
        currentPointer: path.join(longmemoryRoot, "current.txt"),
        previousBuildFile: path.join(longmemoryRoot, "previous"),
        switchMarker: path.join(longmemoryRoot, "switch-pending"),
    };
}

const POSIX_ONLY = process.platform === "win32" && "the fake npm is a POSIX shell script";

test("a generated graph replaces upstream's root manifest and lock, and is fingerprinted from the files npm ci will read", { skip: POSIX_ONLY }, async () => {
    await withTemp("lms-lm-graph-", (root) => {
        const { node, log } = fakeNpm(root, CLEAN_AUDIT);
        const checkoutDir = path.join(root, "checkout");
        fs.mkdirSync(checkoutDir);
        fs.writeFileSync(path.join(checkoutDir, "package.json"), JSON.stringify(UPSTREAM_PACKAGE));
        fs.writeFileSync(path.join(checkoutDir, "pnpm-lock.yaml"), PNPM_LOCK);
        fs.writeFileSync(path.join(checkoutDir, "npm-shrinkwrap.json"), "{}\n");
        const graph = generateAuditedDependencyGraph({ checkoutDir, sha: "a".repeat(40), node });
        assert.equal(fs.readFileSync(path.join(checkoutDir, "package.json"), "utf8"), EXPECTED_MANIFEST);
        assert.equal(fs.existsSync(path.join(checkoutDir, "npm-shrinkwrap.json")), false);
        assert.deepEqual(graph, {
            source: "generated",
            dependencyFingerprint: dependencyFingerprint("longmemory", Buffer.from(EXPECTED_MANIFEST), Buffer.from(`${GENERATED_LOCK}\n`)),
            packageLockSha256: fileSha256(path.join(checkoutDir, "package-lock.json")),
            audit: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
        });
        assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["install --package-lock-only --ignore-scripts --no-audit --no-fund", "audit --omit=dev --json"]);
    });
});

test("a blocked audit keeps the running build and leaves no candidate behind", { skip: POSIX_ONLY }, async () => {
    await withTemp("lms-lm-blocked-", async (root) => {
        const { node, log } = fakeNpm(root, BLOCKED_AUDIT);
        const { repo, sha } = fakeUpstream(root);
        const L = tree(root);
        const running = path.join(L.buildsDir, buildDirectoryName("b".repeat(40), "1".repeat(64)));
        fs.mkdirSync(running, { recursive: true });
        fs.writeFileSync(path.join(running, "marker"), "running build\n");
        pointCurrentAt(running, L, "linux");
        await assert.rejects(installLongMemoryCommit({ sha, node, repo, platform: "linux", tools: [], deferPrune: false, L }), (error) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, new RegExp(`LongMemory main @ ${sha} was not installed`));
            assert.match(error.message, /GHSA-aaaa-bbbb-cccc/);
            return true;
        });
        assert.equal(currentBuildDir(L, "linux"), running);
        assert.deepEqual(fs.readdirSync(L.buildsDir), [path.basename(running)]);
        assert.equal(fs.readFileSync(path.join(running, "marker"), "utf8"), "running build\n");
        assert.equal(fs.existsSync(L.previousBuildFile), false);
        assert.equal(fs.existsSync(L.switchMarker), false);
        assert.doesNotMatch(fs.readFileSync(log, "utf8"), /^ci/m, "npm ci never runs for a blocked graph");
    });
});

test("a candidate that passes the audit but fails the stdio smoke test is not switched to", { skip: POSIX_ONLY }, async () => {
    await withTemp("lms-lm-smoke-fail-", async (root) => {
        const { node, log } = fakeNpm(root, CLEAN_AUDIT);
        const { repo, sha } = fakeUpstream(root);
        const L = tree(root);
        const running = path.join(L.buildsDir, buildDirectoryName("b".repeat(40), "1".repeat(64)));
        fs.mkdirSync(running, { recursive: true });
        pointCurrentAt(running, L, "linux");
        // The fake `node` does not exist, so the smoke test cannot start the candidate.
        await assert.rejects(installLongMemoryCommit({ sha, node, repo, platform: "linux", tools: [], deferPrune: false, L }), /failed the native stdio smoke check/);
        assert.equal(currentBuildDir(L, "linux"), running);
        const fingerprint = dependencyFingerprint("longmemory", Buffer.from(EXPECTED_MANIFEST), Buffer.from(`${GENERATED_LOCK}\n`));
        const candidate = path.join(L.buildsDir, buildDirectoryName(sha, fingerprint));
        assert.deepEqual(fs.readdirSync(L.buildsDir).sort(), [path.basename(candidate), path.basename(running)].sort(), "the staging checkout moved to the build named by its generated graph");
        assert.equal(fs.readFileSync(path.join(candidate, "package.json"), "utf8"), EXPECTED_MANIFEST);
        assert.equal(fs.readFileSync(path.join(candidate, "package-lock.json"), "utf8"), `${GENERATED_LOCK}\n`);
        assert.equal(fs.existsSync(path.join(candidate, "dist", ".local-memory-setup-commit")), false, "no receipt without a passing smoke test");
        assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
            "install --package-lock-only --ignore-scripts --no-audit --no-fund",
            "audit --omit=dev --json",
            "ci --no-audit --no-fund",
            "run build",
        ]);
    });
});
