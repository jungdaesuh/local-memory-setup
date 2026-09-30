/**
 * Install one npm dependency graph into a dedicated npm project root with a clean `npm ci`.
 * The reviewed graphs are the committed manifests and lockfiles under dependencies/;
 * LongMemory's reviewed root-only manifest intentionally replaces the clone's root manifest
 * for the reviewed baseline commit (see longmemory_dependencies.mjs for newer commits).
 * Fingerprints identify the exact manifest and lockfile bytes used for installation.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./proc.mjs";
import { installTimeoutMs, LONGMEMORY_BUILD_BYTES, QMD_PACKAGE_BYTES } from "./sizes.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEPENDENCIES_ROOT = path.join(REPOSITORY_ROOT, "dependencies");
const DEPENDENCY_DIRECTORY = Object.freeze({
    qmd: "qmd",
    longmemory: "longmemory",
});

/**
 * The reviewed package manifest and immutable npm lockfile for `component`.
 * @param {"qmd" | "longmemory"} component
 * @returns {{ directory: string, packageJson: string, packageLock: string }}
 */
export function reviewedDependencyPaths(component) {
    const directoryName = DEPENDENCY_DIRECTORY[component];
    if (directoryName === undefined) throw new Error(`No reviewed dependency graph for ${JSON.stringify(component)}.`);
    const directory = path.join(DEPENDENCIES_ROOT, directoryName);
    return {
        directory,
        packageJson: path.join(directory, "package.json"),
        packageLock: path.join(directory, "package-lock.json"),
    };
}

/**
 * The npm project root and installed root package for one reviewed graph.
 * QMD is a dependency of the project; LongMemory is the project itself.
 * @param {"qmd" | "longmemory"} component
 * @param {string} target npm project root
 * @returns {{ projectRoot: string, packageRoot: string }}
 */
export function dependencyInstallPaths(component, target) {
    if (component === "qmd") return { projectRoot: target, packageRoot: path.join(target, "node_modules", "@tobilu", "qmd") };
    if (component === "longmemory") return { projectRoot: target, packageRoot: target };
    throw new Error(`No reviewed dependency graph for ${JSON.stringify(component)}.`);
}

/**
 * Hash the exact reviewed manifest and lockfile bytes used to identify a build.
 * @param {"qmd" | "longmemory"} component
 */
export function reviewedDependencyFingerprint(component) {
    const paths = reviewedDependencyPaths(component);
    return dependencyFingerprint(component, fs.readFileSync(paths.packageJson), fs.readFileSync(paths.packageLock));
}

/**
 * Identity of the manifest and lockfile an npm project root was installed from.
 * @param {"qmd" | "longmemory"} component
 * @param {string} projectRoot directory holding package.json and package-lock.json
 */
export function installedDependencyFingerprint(component, projectRoot) {
    return dependencyFingerprint(component, fs.readFileSync(path.join(projectRoot, "package.json")), fs.readFileSync(path.join(projectRoot, "package-lock.json")));
}

/**
 * Copy a reviewed graph into an isolated npm project root and return its fingerprint.
 * @param {"qmd" | "longmemory"} component
 * @param {string} target project root; for LongMemory, the baseline source checkout root
 */
export function copyReviewedDependencyFiles(component, target) {
    const paths = reviewedDependencyPaths(component);
    const packageJson = fs.readFileSync(paths.packageJson);
    const packageLock = fs.readFileSync(paths.packageLock);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "package.json"), packageJson);
    fs.writeFileSync(path.join(target, "package-lock.json"), packageLock);
    return dependencyFingerprint(component, packageJson, packageLock);
}

/**
 * Environment for npm commands run on behalf of setup: CI mode, with the selected Node first on PATH.
 * @param {string} node the Node executable selected by setup
 * @returns {NodeJS.ProcessEnv}
 */
export function npmEnvironment(node) {
    return { ...process.env, CI: "1", PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}` };
}

/**
 * The frozen npm command and environment for a project-root install.
 * @param {string} target project root containing the copied manifest and lockfile
 * @param {string} node the Node executable selected by setup
 * @returns {{ command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv }}
 */
export function npmCiInvocation(target, node) {
    return {
        command: "npm",
        args: ["ci", "--no-audit", "--no-fund"],
        cwd: target,
        env: npmEnvironment(node),
    };
}

/**
 * Copy a reviewed graph and install it with npm's clean, lockfile-enforcing command.
 * @param {"qmd" | "longmemory"} component
 * @param {string} target project root; QMD's package is installed under target/node_modules
 * @param {string} node the Node executable selected by setup
 * @returns {string} SHA-256 fingerprint of the copied manifest and lockfile
 */
export function installReviewedDependencies(component, target, node) {
    const fingerprint = copyReviewedDependencyFiles(component, target);
    installLockedDependencies(component, target, node);
    return fingerprint;
}

/**
 * Run `npm ci` against the manifest and lockfile already present at `target`.
 * @param {"qmd" | "longmemory"} component
 * @param {string} target project root containing package.json and package-lock.json
 * @param {string} node the Node executable selected by setup
 */
export function installLockedDependencies(component, target, node) {
    const invocation = npmCiInvocation(target, node);
    const bytes = component === "qmd" ? QMD_PACKAGE_BYTES[process.platform] ?? QMD_PACKAGE_BYTES.linux : LONGMEMORY_BUILD_BYTES;
    run(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        timeoutMs: installTimeoutMs(bytes),
        stream: true,
    });
}

/**
 * SHA-256 identity of one manifest and lockfile pair; build directories and receipts carry it.
 * @param {"qmd" | "longmemory"} component @param {Buffer} packageJson @param {Buffer} packageLock
 */
export function dependencyFingerprint(component, packageJson, packageLock) {
    return createHash("sha256")
        .update(component)
        .update("\0package.json\0")
        .update(packageJson)
        .update("\0package-lock.json\0")
        .update(packageLock)
        .digest("hex");
}
