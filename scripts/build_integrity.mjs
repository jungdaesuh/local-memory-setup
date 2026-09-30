import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { longMemoryStamp } from "./layout.mjs";

const READ_CHUNK_BYTES = 64 * 1024;
const BUILD_INPUTS = ["package.json", "package-lock.json", "tsconfig.json", "src", "dist", "longmemory_stdio.mjs", "node_modules/.package-lock.json"];
const OMITTED_DIRECTORY_NAMES = new Set([".git", ".cache", "logs"]);

/**
 * Hash pinned source and generated output plus npm's resolved graph receipt.
 * File contents are streamed; the generated LongMemory stamp is excluded.
 * @param {string} buildDir
 * @returns {string} SHA-256 of sorted artifact paths, types, modes, links, and bytes
 */
export function buildArtifactFingerprint(buildDir) {
    const root = path.resolve(buildDir);
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`LongMemory build root is not a physical directory: ${root}.`);
    const receiptPath = path.relative(root, longMemoryStamp(root));
    const entries = [];
    for (const relativePath of BUILD_INPUTS) {
        assertPhysicalParents(root, relativePath);
        const stat = fs.lstatSync(path.join(root, relativePath));
        if (stat.isSymbolicLink()) throw new Error(`LongMemory build input is a symlink: ${relativePath}.`);
        if (relativePath === "src" || relativePath === "dist") {
            if (!stat.isDirectory()) throw new Error(`LongMemory build input is not a directory: ${relativePath}.`);
        } else if (!stat.isFile()) {
            throw new Error(`LongMemory build input is not a regular file: ${relativePath}.`);
        }
        walkInput(root, relativePath, receiptPath, entries);
    }
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));

    const digest = createHash("sha256");
    addField(digest, "local-memory-build-artifacts-v1");
    for (const entry of entries) {
        addField(digest, entry.kind);
        addField(digest, entry.path);
        addField(digest, entry.mode.toString(8));
        if (entry.kind === "file") {
            addField(digest, String(entry.size));
            addField(digest, entry.sha256);
        } else if (entry.kind === "symlink") {
            addField(digest, entry.target);
        }
    }
    return digest.digest("hex");
}

/** @param {string} buildDir */
export function buildArtifactInputsPresent(buildDir) {
    const root = path.resolve(buildDir);
    return BUILD_INPUTS.every((relativePath) => fs.existsSync(path.join(root, relativePath)));
}

/** @param {string} root @param {string} relativePath @param {string} receiptPath @param {ArtifactEntry[]} entries */
function walkInput(root, relativePath, receiptPath, entries) {
    if (relativePath === receiptPath || omittedPath(relativePath)) return;
    const absolutePath = path.join(root, relativePath);
    const stat = fs.lstatSync(absolutePath);
    const normalizedPath = relativePath.split(path.sep).join("/");
    if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolutePath);
        const resolvedTarget = path.resolve(path.dirname(absolutePath), target);
        assertInsideRoot(root, resolvedTarget, absolutePath);
        const realTarget = fs.realpathSync(absolutePath);
        assertInsideRoot(root, realTarget, absolutePath);
        entries.push({ path: normalizedPath, kind: "symlink", target: path.relative(root, resolvedTarget).split(path.sep).join("/"), mode: stat.mode & 0o777 });
        return;
    }
    if (stat.isDirectory()) {
        entries.push({ path: normalizedPath, kind: "directory", mode: stat.mode & 0o777 });
        for (const name of fs.readdirSync(absolutePath).sort(compareNames)) {
            walkInput(root, path.join(relativePath, name), receiptPath, entries);
        }
        return;
    }
    if (!stat.isFile()) throw new Error(`LongMemory build contains an unsupported artifact: ${normalizedPath}.`);
    if (omittedLogFile(relativePath)) return;
    entries.push({ path: normalizedPath, kind: "file", mode: stat.mode & 0o777, size: stat.size, sha256: hashFile(absolutePath, stat) });
}

/** @param {string} relativePath */
function omittedPath(relativePath) {
    return relativePath.split(path.sep).some((component) => OMITTED_DIRECTORY_NAMES.has(component.toLowerCase()));
}

/** @param {string} relativePath */
function omittedLogFile(relativePath) {
    const name = path.basename(relativePath).toLowerCase();
    return name.endsWith(".log") || name.includes(".log.");
}

/** @param {string} root @param {string} relativePath */
function assertPhysicalParents(root, relativePath) {
    const parentPath = path.dirname(relativePath);
    if (parentPath === ".") return;
    let parent = root;
    for (const component of parentPath.split(path.sep).filter(Boolean)) {
        parent = path.join(parent, component);
        const stat = fs.lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`LongMemory build input traverses a symlink or non-directory: ${parent}.`);
    }
}

/** @param {string} root @param {string} target @param {string} linkPath */
function assertInsideRoot(root, target, linkPath) {
    const relativeTarget = path.relative(root, target);
    if (relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
        throw new Error(`LongMemory build symlink escapes its root: ${linkPath} -> ${target}.`);
    }
}

/** @param {string} filePath @param {fs.Stats} initialStat */
function hashFile(filePath, initialStat) {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    const descriptor = fs.openSync(filePath, flags);
    try {
        const openedStat = fs.fstatSync(descriptor);
        assertSameFile(filePath, initialStat, openedStat);
        const fileDigest = createHash("sha256");
        const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        let bytesRead = 0;
        while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) fileDigest.update(buffer.subarray(0, bytesRead));
        assertSameFile(filePath, openedStat, fs.fstatSync(descriptor));
        return fileDigest.digest("hex");
    } finally {
        fs.closeSync(descriptor);
    }
}

/** @param {string} filePath @param {fs.Stats} before @param {fs.Stats} after */
function assertSameFile(filePath, before, after) {
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error(`LongMemory build artifact changed while fingerprinting: ${filePath}.`);
    }
}

/** @param {ReturnType<typeof createHash>} digest @param {string} value */
function addField(digest, value) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    digest.update(length).update(bytes);
}

/** @param {string} left @param {string} right */
function compareNames(left, right) {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/** @typedef {{ path: string, kind: "directory", mode: number } | { path: string, kind: "symlink", target: string, mode: number } | { path: string, kind: "file", mode: number, size: number, sha256: string }} ArtifactEntry */
