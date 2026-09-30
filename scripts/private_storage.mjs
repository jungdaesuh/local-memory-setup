/**
 * Private permission boundary for setup-owned memory and QMD storage. Only the
 * named directories and regular files are changed; symlinked paths fail closed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MARKER } from "./layout.mjs";
import { run } from "./proc.mjs";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const WINDOWS_TIMEOUT_MS = 10_000;

/**
 * @typedef {{ home: string, share: string, configDir: string, dbPath: string, envPath: string, choicesPath: string, runtimePath: string, qmdInstallStamp: string, qmdModelCache: string, qmdIndexConfig: string, qmdIndexDb: string }} MemoryLayout
 * @typedef {{ status: number, stdout: string, stderr: string }} CommandResult
 * @typedef {(command: string, args: readonly string[], options?: { timeoutMs?: number }) => CommandResult} CommandRunner
 * @typedef {{ sid: string, allow: boolean, fullControl: boolean, inherited: boolean, objectInherit: boolean, containerInherit: boolean, inheritOnly: boolean, noPropagate: boolean }} WindowsAce
 * @typedef {{ ownerSid: string, userSid: string, protected: boolean, aces: WindowsAce[] }} WindowsAcl
 * @typedef {{ exists: boolean, symlink: boolean, invalidType: boolean, stat: fs.Stats | null }} PathInspection
 */

/**
 * Ensure one directory exists and has owner-only permissions. Parents may be
 * created as needed, but only the requested directory's permissions change.
 * @param {string} directory
 */
export function ensurePrivateDirectory(directory) {
    ensurePrivateDirectoryForPlatform(directory, process.platform, run);
}

/**
 * Protect setup-owned storage and the QMD-specific index/cache leaves in `L`.
 * Existing database bytes are never opened for writing; unsupported external
 * QMD index parents fail closed unless they are already private and user-owned.
 * @param {MemoryLayout} L
 * @param {NodeJS.Platform} [platform]
 * @param {CommandRunner} [runner] injectable command boundary for tests
 */
export function secureMemoryStorage(L, platform = process.platform, runner = run) {
    assertLayoutPathContracts(L);
    const targets = storageTargets(L);
    assertSafeDirectoryTargets(L, targets.directories);
    assertAbsoluteTargets([...targets.directories, ...targets.files]);
    validateExistingTargets(targets.directories, "directory", L.home);
    validateExistingTargets(targets.files, "file", L.home);
    assertExternalIndexParentIsPrivate(L, targets.directories, platform, runner);

    for (const directory of targets.directories) ensurePrivateDirectoryForPlatform(directory, platform, runner, L.home);
    for (const file of targets.files) secureExistingFile(file, platform, runner, L.home);

    if (!memoryStoragePrivate(L, platform, runner)) throw new Error("Memory storage permissions did not reach the private state.");
}

/**
 * Read-only verification of the private storage contract. Missing optional
 * database files are allowed; missing required directories or unsafe paths fail.
 * @param {MemoryLayout} L
 * @param {NodeJS.Platform} [platform]
 * @param {CommandRunner} [runner] injectable command boundary for tests
 * @returns {boolean}
 */
export function memoryStoragePrivate(L, platform = process.platform, runner = run) {
    if (!hasLayoutPathContracts(L)) return false;
    const targets = storageTargets(L);
    if (!hasSafeDirectoryTargets(L, targets.directories)) return false;
    if (!hasAbsoluteTargets([...targets.directories, ...targets.files])) return false;
    if (!targets.directories.every((directory) => pathIsPrivate(directory, "directory", platform, runner, false, L.home))) return false;
    if (!targets.files.every((file) => pathIsPrivate(file, "file", platform, runner, true, L.home))) return false;
    return externalIndexParentIsPrivate(L, targets.directories, platform, runner);
}

/** @param {MemoryLayout} L */
function storageTargets(L) {
    const qmdCacheRoot = path.dirname(L.qmdModelCache);
    const qmdConfigRoot = path.dirname(L.qmdIndexConfig);
    const protectedRoots = [L.share, L.configDir, qmdCacheRoot, L.qmdModelCache, qmdConfigRoot].map((entry) => path.resolve(entry));
    const qmdIndexParent = path.dirname(L.qmdIndexDb);
    const managedIndexParent = protectedRoots.some((root) => sameOrInside(qmdIndexParent, root)) ? [qmdIndexParent] : [];
    const directories = uniquePaths([...protectedRoots, ...managedIndexParent]);
    const files = uniquePaths([
        L.dbPath,
        `${L.dbPath}-wal`,
        `${L.dbPath}-shm`,
        `${L.dbPath}.mcp-audit.jsonl`,
        L.envPath,
        L.choicesPath,
        L.runtimePath,
        L.qmdInstallStamp,
        L.qmdIndexDb,
        `${L.qmdIndexDb}-wal`,
        `${L.qmdIndexDb}-shm`,
        L.qmdIndexConfig,
    ]);
    return { directories, files, qmdCacheRoot };
}

/** @param {MemoryLayout} L */
function assertLayoutPathContracts(L) {
    if (!hasLayoutPathContracts(L)) throw new Error("Private storage paths do not match the setup-owned layout.");
}

/** @param {MemoryLayout} L */
function hasLayoutPathContracts(L) {
    const home = path.resolve(L.home);
    const expectedShare = path.join(home, ".local", "share", MARKER);
    const expectedConfig = path.join(home, ".config", MARKER);
    const qmdCache = path.resolve(L.qmdModelCache);
    const qmdConfig = path.resolve(L.qmdIndexConfig);
    return (
        path.resolve(L.share) === expectedShare &&
        path.resolve(L.configDir) === expectedConfig &&
        path.dirname(path.resolve(L.dbPath)) === expectedShare &&
        path.basename(qmdCache) === "models" &&
        path.basename(path.dirname(qmdCache)) === "qmd" &&
        path.basename(qmdConfig) === "index.yml" &&
        path.basename(path.dirname(qmdConfig)) === "qmd"
    );
}

/** @param {readonly string[]} paths */
function uniquePaths(paths) {
    return [...new Set(paths.map((entry) => path.resolve(entry)))];
}

/** @param {MemoryLayout} L @param {readonly string[]} directories */
function assertSafeDirectoryTargets(L, directories) {
    if (!hasSafeDirectoryTargets(L, directories)) throw new Error("Refusing to change the home directory or a shared home cache directory.");
}

/** @param {MemoryLayout} L @param {readonly string[]} directories */
function hasSafeDirectoryTargets(L, directories) {
    const home = path.resolve(L.home);
    const broadDirectories = new Set([
        home,
        path.join(home, ".cache"),
        path.join(home, ".config"),
        path.join(home, ".local"),
        path.join(home, ".local", "share"),
    ]);
    return directories.every((directory) => !broadDirectories.has(path.resolve(directory)));
}

/** @param {readonly string[]} paths */
function assertAbsoluteTargets(paths) {
    if (!hasAbsoluteTargets(paths)) throw new Error("Private storage paths must be absolute.");
}

/** @param {readonly string[]} paths */
function hasAbsoluteTargets(paths) {
    return paths.every((entry) => path.isAbsolute(entry));
}

/** @param {readonly string[]} targets @param {"directory" | "file"} kind @param {string} trustedRoot */
function validateExistingTargets(targets, kind, trustedRoot) {
    for (const target of targets) {
        const inspection = inspectPath(target, kind, trustedRoot);
        if (inspection.symlink) throw new Error(`Refusing symlink in private storage path: ${target}`);
        if (inspection.invalidType) throw new Error(`Private storage path has the wrong type: ${target}`);
    }
}

/**
 * Create missing components without following links, then change only the
 * requested leaf's permissions.
 * @param {string} directory
 * @param {NodeJS.Platform} platform
 * @param {CommandRunner} runner
 * @param {string} trustedRoot
 */
function ensurePrivateDirectoryForPlatform(directory, platform, runner, trustedRoot = os.homedir()) {
    const absolute = path.resolve(directory);
    const home = path.resolve(os.homedir());
    const broadHomeDirectories = new Set([home, ...[".cache", ".config", ".local", path.join(".local", "share")].map((suffix) => path.join(home, suffix))]);
    if (!path.isAbsolute(absolute) || absolute === path.parse(absolute).root || broadHomeDirectories.has(absolute)) {
        throw new Error(`Refusing to change a broad or root directory: ${absolute}`);
    }
    createDirectoryChain(absolute, trustedRoot);
    if (platform === "win32") setWindowsPrivateAcl(absolute, "directory", runner);
    else setPosixPrivateMode(absolute, "directory", trustedRoot);
}

/** @param {string} directory @param {string} trustedRoot */
function createDirectoryChain(directory, trustedRoot) {
    const parsed = path.parse(directory);
    const anchor = path.isAbsolute(trustedRoot) && sameOrInside(directory, trustedRoot) ? path.resolve(trustedRoot) : parsed.root;
    let current = anchor;
    for (const component of path.relative(anchor, directory).split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        let info = lstatIfPresent(current);
        if (info === null) {
            try {
                fs.mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
            } catch (error) {
                if (!isErrno(error, "EEXIST")) throw error;
            }
            info = lstatIfPresent(current);
        }
        if (info === null) throw new Error(`Private directory was not created: ${current}`);
        if (info.isSymbolicLink()) throw new Error(`Refusing symlink in private storage path: ${current}`);
        if (!info.isDirectory()) throw new Error(`Private storage path component is not a directory: ${current}`);
    }
}

/** @param {string} target @param {"directory" | "file"} kind @param {string} [trustedRoot] */
function inspectPath(target, kind, trustedRoot = undefined) {
    if (!path.isAbsolute(target)) return { exists: false, symlink: false, invalidType: true, stat: null };
    const absolute = path.resolve(target);
    const parsed = path.parse(absolute);
    const anchor = typeof trustedRoot === "string" && path.isAbsolute(trustedRoot) && sameOrInside(absolute, trustedRoot) ? path.resolve(trustedRoot) : parsed.root;
    let current = anchor;
    let finalInfo = /** @type {fs.Stats | null} */ (null);
    for (const component of path.relative(anchor, absolute).split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        const info = lstatIfPresent(current);
        if (info === null) return { exists: false, symlink: false, invalidType: false, stat: null };
        if (info.isSymbolicLink()) return { exists: true, symlink: true, invalidType: false, stat: info };
        const isTarget = current === absolute;
        if ((!isTarget && !info.isDirectory()) || (isTarget && kind === "directory" && !info.isDirectory()) || (isTarget && kind === "file" && !info.isFile())) {
            return { exists: true, symlink: false, invalidType: true, stat: info };
        }
        finalInfo = info;
    }
    return { exists: finalInfo !== null, symlink: false, invalidType: false, stat: finalInfo };
}

/** @param {string} target */
function lstatIfPresent(target) {
    try {
        return fs.lstatSync(target);
    } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
    }
}

/** @param {unknown} error @param {string} code */
function isErrno(error, code) {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** @param {string} target @param {"directory" | "file"} kind @param {string} [trustedRoot] */
function setPosixPrivateMode(target, kind, trustedRoot) {
    const before = inspectPath(target, kind, trustedRoot);
    if (before.symlink) throw new Error(`Refusing symlink in private storage path: ${target}`);
    if (!before.exists || before.invalidType || before.stat === null) throw new Error(`Private storage target is missing or has the wrong type: ${target}`);
    assertPosixOwner(before.stat, target);

    const noFollow = fs.constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") throw new Error("This POSIX platform does not support no-follow opens for private storage.");
    const flags = fs.constants.O_RDONLY | noFollow | (kind === "file" ? fs.constants.O_NONBLOCK : 0);
    const descriptor = fs.openSync(target, flags);
    try {
        const opened = fs.fstatSync(descriptor);
        const isExpectedType = kind === "directory" ? opened.isDirectory() : opened.isFile();
        if (!isExpectedType || opened.dev !== before.stat.dev || opened.ino !== before.stat.ino) {
            throw new Error(`Private storage target changed while it was being secured: ${target}`);
        }
        assertPosixOwner(opened, target);
        fs.fchmodSync(descriptor, kind === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE);
    } finally {
        fs.closeSync(descriptor);
    }
}

/** @param {fs.Stats} info @param {string} target */
function assertPosixOwner(info, target) {
    const uid = process.getuid?.();
    if (uid === undefined || info.uid !== uid) throw new Error(`Refusing to change storage not owned by this user: ${target}`);
}

/** @param {string} target @param {NodeJS.Platform} platform @param {CommandRunner} runner @param {string} trustedRoot */
function secureExistingFile(target, platform, runner, trustedRoot) {
    const inspection = inspectPath(target, "file", trustedRoot);
    if (inspection.symlink) throw new Error(`Refusing symlink in private storage path: ${target}`);
    if (!inspection.exists) return;
    if (inspection.invalidType || inspection.stat === null) throw new Error(`Private storage file has the wrong type: ${target}`);
    if (platform === "win32") setWindowsPrivateAcl(target, "file", runner);
    else setPosixPrivateMode(target, "file", trustedRoot);
}

/** @param {string} target @param {"directory" | "file"} kind @param {NodeJS.Platform} platform @param {CommandRunner} runner @param {boolean} [missingIsPrivate] @param {string} [trustedRoot] */
function pathIsPrivate(target, kind, platform, runner, missingIsPrivate = false, trustedRoot = undefined) {
    const inspection = inspectPath(target, kind, trustedRoot);
    if (inspection.symlink || inspection.invalidType) return false;
    if (!inspection.exists) return missingIsPrivate;
    if (inspection.stat === null) return false;

    if (platform === "win32") return isPrivateWindowsAcl(readWindowsAcl(target, runner), kind);
    const uid = process.getuid?.();
    const expectedMode = kind === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE;
    return uid !== undefined && inspection.stat.uid === uid && (inspection.stat.mode & 0o7777) === expectedMode;
}

/** @param {MemoryLayout} L @param {readonly string[]} protectedDirectories @param {NodeJS.Platform} platform @param {CommandRunner} runner */
function assertExternalIndexParentIsPrivate(L, protectedDirectories, platform, runner) {
    if (!externalIndexParentIsPrivate(L, protectedDirectories, platform, runner)) {
        throw new Error(`QMD index parent ${path.dirname(L.qmdIndexDb)} is outside the protected QMD leaves and is not already private; refusing to change an operator-owned directory.`);
    }
}

/** @param {MemoryLayout} L @param {readonly string[]} protectedDirectories @param {NodeJS.Platform} platform @param {CommandRunner} runner */
function externalIndexParentIsPrivate(L, protectedDirectories, platform, runner) {
    const indexParent = path.resolve(path.dirname(L.qmdIndexDb));
    if (protectedDirectories.some((directory) => sameOrInside(indexParent, directory))) return true;
    return pathIsPrivate(indexParent, "directory", platform, runner, false, L.home);
}

/** @param {string} target @param {string} root */
function sameOrInside(target, root) {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** @param {string} target @param {"directory" | "file"} kind @param {CommandRunner} runner */
function setWindowsPrivateAcl(target, kind, runner) {
    const current = readWindowsAcl(target, runner);
    if (current.ownerSid !== current.userSid) throw new Error(`Refusing to change Windows storage not owned by the current user: ${target}`);

    const encodedPath = Buffer.from(path.resolve(target), "utf8").toString("base64");
    const descriptorType = kind === "directory" ? "DirectorySecurity" : "FileSecurity";
    const inheritance = kind === "directory"
        ? "[Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [Security.AccessControl.InheritanceFlags]::ContainerInherit"
        : "[Security.AccessControl.InheritanceFlags]::None";
    const script = [
        `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
        "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
        `$security = New-Object System.Security.AccessControl.${descriptorType}`,
        "$security.SetOwner($identity.User)",
        "$security.SetAccessRuleProtection($true, $false)",
        `$inheritance = ${inheritance}`,
        "$rule = [Security.AccessControl.FileSystemAccessRule]::new($identity.User, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)",
        "$security.AddAccessRule($rule)",
        "Set-Acl -LiteralPath $path -AclObject $security",
    ].join("; ");
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
    invokeWindows("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], runner);

    const secured = readWindowsAcl(target, runner);
    if (!isPrivateWindowsAcl(secured, kind)) throw new Error(`Windows storage ACL verification failed: ${target}`);
}

/** @param {string} target @param {CommandRunner} runner @returns {WindowsAcl} */
function readWindowsAcl(target, runner) {
    const encodedPath = Buffer.from(path.resolve(target), "utf8").toString("base64");
    const script = [
        `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
        "$acl = Get-Acl -LiteralPath $path",
        "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
        "$ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value",
        "$protected = $acl.AreAccessRulesProtected",
        "$aces = @($acl.Access | ForEach-Object {",
        "  $sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value",
        "  [pscustomobject]@{",
        "    sid = $sid",
        "    allow = $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow",
        "    fullControl = $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl",
        "    inherited = $_.IsInherited",
        "    objectInherit = (($_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0)",
        "    containerInherit = (($_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0)",
        "    inheritOnly = (($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)",
        "    noPropagate = (($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::NoPropagateInherit) -ne 0)",
        "  }",
        "})",
        "[pscustomobject]@{ ownerSid = $ownerSid; userSid = $identity.User.Value; protected = $protected; aces = $aces } | ConvertTo-Json -Depth 4 -Compress",
    ].join("; ");
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
    const result = invokeWindows("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], runner);
    return parseWindowsAcl(result.stdout, target);
}

/** @param {string} command @param {readonly string[]} args @param {CommandRunner} runner */
function invokeWindows(command, args, runner) {
    const result = runner(command, args, { timeoutMs: WINDOWS_TIMEOUT_MS });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}: ${result.stderr || result.stdout}`);
    return result;
}

/** @param {string} stdout @param {string} target @returns {WindowsAcl} */
function parseWindowsAcl(stdout, target) {
    const parsed = /** @type {unknown} */ (JSON.parse(stdout));
    if (!isRecord(parsed) || typeof parsed.ownerSid !== "string" || typeof parsed.userSid !== "string" || typeof parsed.protected !== "boolean" || !Array.isArray(parsed.aces)) {
        throw new Error(`Windows ACL query returned an invalid response for ${target}.`);
    }
    const aces = parsed.aces.map((value) => parseWindowsAce(value, target));
    return { ownerSid: parsed.ownerSid, userSid: parsed.userSid, protected: parsed.protected, aces };
}

/** @param {unknown} value @param {string} target @returns {WindowsAce} */
function parseWindowsAce(value, target) {
    if (
        !isRecord(value) ||
        typeof value.sid !== "string" ||
        typeof value.allow !== "boolean" ||
        typeof value.fullControl !== "boolean" ||
        typeof value.inherited !== "boolean" ||
        typeof value.objectInherit !== "boolean" ||
        typeof value.containerInherit !== "boolean" ||
        typeof value.inheritOnly !== "boolean" ||
        typeof value.noPropagate !== "boolean"
    ) {
        throw new Error(`Windows ACL entry was invalid for ${target}.`);
    }
    return {
        sid: value.sid,
        allow: value.allow,
        fullControl: value.fullControl,
        inherited: value.inherited,
        objectInherit: value.objectInherit,
        containerInherit: value.containerInherit,
        inheritOnly: value.inheritOnly,
        noPropagate: value.noPropagate,
    };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {WindowsAcl} acl @param {"directory" | "file"} kind */
function isPrivateWindowsAcl(acl, kind) {
    if (acl.ownerSid !== acl.userSid || acl.aces.length !== 1) return false;
    const [ace] = acl.aces;
    if (ace.sid !== acl.userSid || !ace.allow || !ace.fullControl || ace.inheritOnly) return false;
    if (kind === "directory") return acl.protected && !ace.inherited && !ace.noPropagate && ace.objectInherit && ace.containerInherit;
    return true;
}
