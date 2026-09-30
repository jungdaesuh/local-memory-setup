/**
 * The npm dependency graph for a LongMemory commit other than the reviewed baseline,
 * derived the way dependencies/longmemory was: a root-only manifest that keeps upstream's
 * root build script and pins every direct dependency to the version upstream's
 * pnpm-lock.yaml root importer resolved. npm resolves a fresh lockfile for it with
 * lifecycle scripts disabled, and its production graph is audited before anything is
 * installed. The baseline's exact transitive overrides are not carried forward: each one
 * lies inside its parents' ranges, so a fresh resolution selects that version or a newer
 * one, and the audit gate, not a stale pin, decides whether the graph is acceptable.
 */
import fs from "node:fs";
import path from "node:path";
import { dependencyFingerprint, npmEnvironment } from "./dependency_install.mjs";
import { fileSha256 } from "./layout.mjs";
import { run } from "./proc.mjs";
import { downloadTimeoutMs } from "./sizes.mjs";

/** @typedef {{ info: number, low: number, moderate: number, high: number, critical: number }} AuditSummary */
/** @typedef {{ name: string, severity: string, advisories: string[] }} BlockingVulnerability */

const DEPENDENCY_GROUPS = /** @type {const} */ (["dependencies", "devDependencies", "optionalDependencies"]);
const AUDIT_SEVERITIES = /** @type {const} */ (["info", "low", "moderate", "high", "critical"]);
/** Production advisories at these severities stop a candidate build before it is installed. */
export const BLOCKING_SEVERITIES = /** @type {readonly string[]} */ (["high", "critical"]);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Direct dependencies of pnpm-lock.yaml's root importer (`importers: .:`), per group, as
 * `{ specifier, version }` with the peer suffix `(...)` removed. Reads pnpm lockfile v9,
 * the format upstream commits; any other shape is an error rather than a guess.
 * @param {string} pnpmLockText
 * @returns {Record<(typeof DEPENDENCY_GROUPS)[number], Map<string, { specifier: string, version: string }>>}
 */
export function rootImporterDependencies(pnpmLockText) {
    const lines = pnpmLockText.split(/\r?\n/);
    const versionLine = lines.find((line) => line.startsWith("lockfileVersion:"));
    const lockVersion = versionLine === undefined ? null : yamlScalar(versionLine.slice("lockfileVersion:".length).trim());
    if (lockVersion === null || !/^9\.\d+$/.test(lockVersion)) throw new Error(`LongMemory pnpm-lock.yaml has lockfileVersion ${JSON.stringify(lockVersion)}, not 9.x.`);
    const importers = lines.indexOf("importers:");
    if (importers < 0) throw new Error("LongMemory pnpm-lock.yaml has no importers section.");
    const rootStart = lines.findIndex((line, index) => index > importers && line === "  .:");
    const nextSection = lines.findIndex((line, index) => index > importers && /^\S/.test(line));
    if (rootStart < 0 || (nextSection >= 0 && rootStart > nextSection)) throw new Error("LongMemory pnpm-lock.yaml has no root importer.");
    const groups = { dependencies: new Map(), devDependencies: new Map(), optionalDependencies: new Map() };
    /** @type {Map<string, { specifier?: string, version?: string }> | null} */
    let group = null;
    /** @type {{ specifier?: string, version?: string } | null} */
    let entry = null;
    for (const line of lines.slice(rootStart + 1)) {
        if (line.trim() === "") continue;
        const indent = line.length - line.trimStart().length;
        if (indent <= 2) break;
        const text = line.trim();
        if (indent === 4) {
            const name = /^(\w+):$/.exec(text)?.[1];
            group = name !== undefined && Object.hasOwn(groups, name) ? groups[/** @type {keyof typeof groups} */ (name)] : null;
            entry = null;
        } else if (group !== null && indent === 6) {
            const name = /^(.+):$/.exec(text)?.[1];
            if (name === undefined) throw new Error(`LongMemory pnpm-lock.yaml root importer has an unexpected line: ${JSON.stringify(line)}.`);
            entry = {};
            group.set(yamlScalar(name), entry);
        } else if (group !== null && indent === 8) {
            const field = /^(specifier|version): (.+)$/.exec(text);
            if (entry === null || field === null) throw new Error(`LongMemory pnpm-lock.yaml root importer has an unexpected line: ${JSON.stringify(line)}.`);
            entry[/** @type {"specifier" | "version"} */ (field[1])] = yamlScalar(field[2]);
        }
    }
    return /** @type {ReturnType<typeof rootImporterDependencies>} */ (
        Object.fromEntries(
            Object.entries(groups).map(([name, entries]) => [
                name,
                new Map([...entries].map(([dependency, fields]) => {
                    if (fields.specifier === undefined || fields.version === undefined) throw new Error(`LongMemory pnpm-lock.yaml root importer entry ${dependency} lacks a specifier or version.`);
                    return [dependency, { specifier: fields.specifier, version: fields.version.replace(/\(.*$/, "") }];
                })),
            ]),
        )
    );
}

/**
 * A plain or quoted YAML scalar as pnpm writes names and versions.
 * @param {string} text
 */
function yamlScalar(text) {
    if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replaceAll("''", "'");
    if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
        const inner = text.slice(1, -1);
        if (inner.includes("\\")) throw new Error(`LongMemory pnpm-lock.yaml uses an escaped scalar this setup does not read: ${text}.`);
        return inner;
    }
    return text;
}

/**
 * The root-only npm manifest for an upstream checkout: upstream's identity fields and
 * `scripts.build`, with each direct dependency pinned to the version the root importer
 * resolved. Upstream dependency overrides are outside this derivation and stop it.
 * @param {string} upstreamPackageJsonText the checkout's own package.json
 * @param {string} pnpmLockText the checkout's pnpm-lock.yaml
 * @returns {string} manifest text, two-space indented with a trailing newline
 */
export function rootOnlyManifest(upstreamPackageJsonText, pnpmLockText) {
    const upstream = JSON.parse(upstreamPackageJsonText);
    if (typeof upstream !== "object" || upstream === null || Array.isArray(upstream)) throw new Error("LongMemory package.json is not a JSON object.");
    const build = upstream.scripts?.build;
    if (typeof build !== "string" || build === "") throw new Error("LongMemory package.json has no build script.");
    const unsupported = ["overrides", "resolutions", "peerDependencies"].filter((field) => upstream[field] !== undefined);
    if (upstream.pnpm?.overrides !== undefined) unsupported.push("pnpm.overrides");
    if (unsupported.length > 0) throw new Error(`LongMemory package.json declares ${unsupported.join(", ")}, which the root-only dependency derivation does not cover; this commit needs review.`);
    const importer = rootImporterDependencies(pnpmLockText);
    /** @type {Record<string, Record<string, string>>} */
    const pinned = {};
    for (const group of DEPENDENCY_GROUPS) {
        const declared = upstream[group] ?? {};
        const locked = importer[group];
        const names = Object.keys(declared);
        const unlisted = [...locked.keys()].filter((name) => !Object.hasOwn(declared, name));
        if (unlisted.length > 0) throw new Error(`LongMemory pnpm-lock.yaml root ${group} lists ${unlisted.join(", ")}, which package.json does not declare.`);
        if (names.length === 0) continue;
        pinned[group] = Object.fromEntries(
            names.map((name) => {
                const resolved = locked.get(name);
                if (resolved === undefined) throw new Error(`LongMemory pnpm-lock.yaml root ${group} does not resolve ${name}.`);
                if (resolved.specifier !== declared[name]) throw new Error(`LongMemory pnpm-lock.yaml resolves ${name} for ${resolved.specifier}, but package.json asks for ${declared[name]}.`);
                if (!EXACT_VERSION.test(resolved.version)) throw new Error(`LongMemory pnpm-lock.yaml resolves ${name} to ${resolved.version}, which is not a registry version.`);
                return [name, resolved.version];
            }),
        );
    }
    const manifest = {
        name: upstream.name,
        version: upstream.version,
        private: true,
        license: upstream.license,
        engines: upstream.engines,
        type: upstream.type,
        main: upstream.main,
        types: upstream.types,
        scripts: { build },
        ...pinned,
    };
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Severity counts and blocking entries of `npm audit --json` (report version 2).
 * @param {string} text
 * @returns {{ summary: AuditSummary, blocking: BlockingVulnerability[] }}
 */
export function parseAuditReport(text) {
    const report = JSON.parse(text);
    const counts = report?.metadata?.vulnerabilities;
    if (report?.auditReportVersion !== 2 || typeof counts !== "object" || counts === null) {
        const detail = typeof report?.error?.summary === "string" ? report.error.summary : text.trim().slice(0, 500);
        throw new Error(`npm audit did not return an audit report: ${detail}`);
    }
    /** @type {AuditSummary} */
    const summary = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
    for (const severity of AUDIT_SEVERITIES) {
        const count = counts[severity];
        if (!Number.isSafeInteger(count) || count < 0) throw new Error(`npm audit reported ${JSON.stringify(count)} ${severity} vulnerabilities.`);
        summary[severity] = count;
    }
    const vulnerabilities = /** @type {Record<string, { name?: unknown, severity?: unknown, via?: unknown }>} */ (report.vulnerabilities ?? {});
    const blocking = Object.values(vulnerabilities)
        .filter((vulnerability) => typeof vulnerability.severity === "string" && BLOCKING_SEVERITIES.includes(vulnerability.severity))
        .map((vulnerability) => ({
            name: String(vulnerability.name),
            severity: String(vulnerability.severity),
            advisories: (Array.isArray(vulnerability.via) ? vulnerability.via : [])
                .filter((via) => typeof via === "object" && via !== null && BLOCKING_SEVERITIES.includes(via.severity))
                .map((via) => String(via.url ?? via.title)),
        }));
    if ((summary.high > 0 || summary.critical > 0) && blocking.length === 0) throw new Error("npm audit counted high or critical vulnerabilities but listed none.");
    return { summary, blocking };
}

/**
 * Whether a recorded audit summary allows a generated graph to be installed or reused.
 * @param {unknown} summary
 */
export function auditSummaryPasses(summary) {
    if (typeof summary !== "object" || summary === null) return false;
    const counts = /** @type {Record<string, unknown>} */ (summary);
    return AUDIT_SEVERITIES.every((severity) => Number.isSafeInteger(counts[severity])) && BLOCKING_SEVERITIES.every((severity) => counts[severity] === 0);
}

/** @param {string} sha @param {readonly BlockingVulnerability[]} blocking */
export function auditBlockedMessage(sha, blocking) {
    const listed = blocking.map((vulnerability) => `${vulnerability.name} (${vulnerability.severity}${vulnerability.advisories.length > 0 ? `: ${vulnerability.advisories.join(", ")}` : ""})`);
    return `LongMemory main @ ${sha} was not installed: npm audit --omit=dev found high or critical production advisories in its dependency graph: ${listed.join("; ")}. The running build was kept.`;
}

/** @param {string} checkoutDir */
export function lockOnlyInstallArgs(checkoutDir) {
    return { args: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], cwd: checkoutDir };
}

/** @param {string} checkoutDir */
export function productionAuditArgs(checkoutDir) {
    return { args: ["audit", "--omit=dev", "--json"], cwd: checkoutDir };
}

/**
 * Replace the checkout's root manifest with the derived root-only one, resolve a fresh npm
 * lockfile with lifecycle scripts disabled, and audit its production graph. Both files stay
 * at the checkout root, where `npm ci` consumes them and the build receipt hashes them.
 * Throws, naming the commit and advisories, when a production advisory is high or critical.
 * @param {{ checkoutDir: string, sha: string, node: string }} spec
 * @returns {{ source: "generated", dependencyFingerprint: string, packageLockSha256: string, audit: AuditSummary }}
 */
export function generateAuditedDependencyGraph(spec) {
    const pnpmLock = path.join(spec.checkoutDir, "pnpm-lock.yaml");
    if (!fs.existsSync(pnpmLock)) throw new Error(`LongMemory ${spec.sha} has no pnpm-lock.yaml to derive its root dependency versions from.`);
    const manifest = rootOnlyManifest(fs.readFileSync(path.join(spec.checkoutDir, "package.json"), "utf8"), fs.readFileSync(pnpmLock, "utf8"));
    // npm prefers npm-shrinkwrap.json over package-lock.json; neither upstream file may seed the fresh resolution.
    for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) fs.rmSync(path.join(spec.checkoutDir, name), { force: true });
    fs.writeFileSync(path.join(spec.checkoutDir, "package.json"), manifest);
    const env = npmEnvironment(spec.node);
    const lockOnly = lockOnlyInstallArgs(spec.checkoutDir);
    run("npm", lockOnly.args, { cwd: lockOnly.cwd, env, stream: true, timeoutMs: downloadTimeoutMs(0) });
    const audit = productionAuditArgs(spec.checkoutDir);
    // npm audit exits non-zero whenever it finds any advisory; the report decides.
    const report = parseAuditReport(run("npm", audit.args, { cwd: audit.cwd, env, allowFail: true, timeoutMs: downloadTimeoutMs(0) }).stdout);
    if (report.blocking.length > 0) throw new Error(auditBlockedMessage(spec.sha, report.blocking));
    const manifestBytes = fs.readFileSync(path.join(spec.checkoutDir, "package.json"));
    if (!manifestBytes.equals(Buffer.from(manifest, "utf8"))) throw new Error(`npm rewrote the derived LongMemory ${spec.sha} manifest while resolving its lockfile.`);
    const lockFile = path.join(spec.checkoutDir, "package-lock.json");
    return {
        source: "generated",
        dependencyFingerprint: dependencyFingerprint("longmemory", manifestBytes, fs.readFileSync(lockFile)),
        packageLockSha256: fileSha256(lockFile),
        audit: report.summary,
    };
}
