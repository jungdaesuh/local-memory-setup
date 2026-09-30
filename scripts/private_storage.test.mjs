import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { layout } from "./layout.mjs";
import { memoryStoragePrivate, secureMemoryStorage } from "./private_storage.mjs";

const WIN_USER_SID = "S-1-5-21-100-200-300-1001";

/** @param {(fixture: { root: string, home: string, L: ReturnType<typeof layout> }) => void} body */
function withFixture(body) {
    const tempRoot = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(tempRoot, "lms-private-storage-"));
    const home = path.join(root, "home");
    fs.mkdirSync(home, { mode: 0o700 });
    const pathPlatform = process.platform === "win32" ? "win32" : "linux";
    const L = layout(pathPlatform, home, { XDG_CACHE_HOME: path.join(home, ".cache"), XDG_CONFIG_HOME: path.join(home, ".config") });
    try {
        body({ root, home, L });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

/** @param {ReturnType<typeof layout>} L */
function createStorageDirectories(L) {
    for (const directory of [L.share, L.configDir, path.dirname(L.qmdIndexConfig), path.dirname(L.qmdModelCache), L.qmdModelCache]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o777 });
    }
}

/** @param {ReturnType<typeof layout>} L */
function writeStorageFiles(L) {
    const files = [
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
    ];
    const contents = new Map();
    for (const [index, file] of files.entries()) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const bytes = Buffer.from(`private-storage-fixture-${index}\0\xff`, "utf8");
        fs.writeFileSync(file, bytes);
        contents.set(file, bytes);
    }
    return contents;
}

/** @param {readonly string[]} paths @param {number} mode */
function assertMode(paths, mode) {
    for (const target of paths) assert.equal(fs.statSync(target).mode & 0o7777, mode, `${target} should have mode ${mode.toString(8)}`);
}

/** @param {{ ownerSid?: string, userSid?: string }} [identity] */
function windowsRunner(identity = {}) {
    const calls = [];
    const mutations = [];
    const queriedAcls = new Map();
    const repairedAcls = new Map();
    const ownerSid = identity.ownerSid ?? WIN_USER_SID;
    const userSid = identity.userSid ?? WIN_USER_SID;
    /** @param {string} command @param {readonly string[]} args */
    const runner = (command, args) => {
        calls.push({ command, args: [...args] });
        if (command === "icacls") return { status: 0, stdout: "", stderr: "" };
        const encodedCommand = args.at(-1);
        assert.ok(encodedCommand !== undefined);
        const script = Buffer.from(encodedCommand, "base64").toString("utf16le");
        const pathMatch = /FromBase64String\('([^']+)'\)/.exec(script);
        assert.ok(pathMatch !== null);
        const target = Buffer.from(pathMatch[1], "base64").toString("utf8");
        const isDirectory = fs.lstatSync(target).isDirectory();
        const acl = {
            ownerSid,
            userSid,
            protected: true,
            aces: [
                {
                    sid: userSid,
                    allow: true,
                    fullControl: true,
                    inherited: false,
                    objectInherit: isDirectory,
                    containerInherit: isDirectory,
                    inheritOnly: false,
                    noPropagate: false,
                },
            ],
        };
        if (script.includes("Set-Acl -LiteralPath $path -AclObject $security")) {
            mutations.push({ target, script });
            repairedAcls.set(target, acl);
            return { status: 0, stdout: "", stderr: "" };
        }
        const explicitAcl = repairedAcls.get(target);
        const parentAcl = repairedAcls.get(path.dirname(target));
        const inheritedAce = parentAcl?.protected === true && parentAcl.aces.length === 1 ? parentAcl.aces[0] : undefined;
        const inheritedAcl = inheritedAce?.sid === userSid && inheritedAce.allow && inheritedAce.fullControl &&
            inheritedAce.objectInherit && !inheritedAce.inheritOnly && !inheritedAce.noPropagate
            ? {
                ownerSid,
                userSid,
                protected: false,
                aces: [{ ...inheritedAce, inherited: true }],
            }
            : undefined;
        const queriedAcl = explicitAcl ?? inheritedAcl ?? { ownerSid, userSid, protected: false, aces: [] };
        queriedAcls.set(target, queriedAcl);
        return { status: 0, stdout: JSON.stringify(queriedAcl), stderr: "" };
    };
    return {
        calls,
        mutations,
        queriedAcls,
        runner,
        /** @param {string} target */
        forgetSimulatedAcl(target) {
            repairedAcls.delete(target);
        },
        /** @param {string} target @param {{ ownerSid: string, userSid: string, protected: boolean, aces: Array<{ sid: string, allow: boolean, fullControl: boolean, inherited: boolean, objectInherit: boolean, containerInherit: boolean, inheritOnly: boolean, noPropagate: boolean }> }} acl */
        setSimulatedAcl(target, acl) {
            repairedAcls.set(target, acl);
        },
    };
}

test("umask 022 default modes fail the private check, then exact modes protect bytes without changing shared parents", { skip: process.platform === "win32" }, () => {
    const previousUmask = process.umask(0o022);
    try {
        withFixture(({ L, home }) => {
            createStorageDirectories(L);
            const contents = writeStorageFiles(L);
            const privateDirectories = [L.share, L.configDir, path.dirname(L.qmdIndexConfig), path.dirname(L.qmdModelCache), L.qmdModelCache];
            const qmdConfigParent = path.dirname(path.dirname(L.qmdIndexConfig));
            const qmdCacheParent = path.dirname(path.dirname(L.qmdModelCache));

            assert.equal(fs.statSync(L.share).mode & 0o777, 0o755, "the former mkdir default must reproduce the permission gap");
            assert.equal(memoryStoragePrivate(L, "linux"), false, "default directory and SQLite modes must not pass the private check");
            const parentModes = new Map([qmdConfigParent, qmdCacheParent, path.join(home, ".local", "share")].map((directory) => [directory, fs.statSync(directory).mode & 0o7777]));

            secureMemoryStorage(L, "linux");

            assert.equal(memoryStoragePrivate(L, "linux"), true);
            assertMode(privateDirectories, 0o700);
            assertMode([...contents.keys()], 0o600);
            for (const [file, expected] of contents) assert.deepEqual(fs.readFileSync(file), expected, `${file} bytes must remain unchanged`);
            for (const [directory, mode] of parentModes) assert.equal(fs.statSync(directory).mode & 0o7777, mode, `${directory} parent permissions must remain unchanged`);
        });
    } finally {
        process.umask(previousUmask);
    }
});

test("read-only verification rejects file and directory symlinks without changing their targets", { skip: process.platform === "win32" }, () => {
    withFixture(({ root, L }) => {
        createStorageDirectories(L);
        const outsideFile = path.join(root, "outside.db");
        fs.writeFileSync(outsideFile, "outside bytes");
        fs.chmodSync(outsideFile, 0o644);
        fs.writeFileSync(L.dbPath, "to be replaced by the symlink");
        fs.unlinkSync(L.dbPath);
        fs.symlinkSync(outsideFile, L.dbPath);

        assert.equal(memoryStoragePrivate(L, "linux"), false);
        assert.throws(() => secureMemoryStorage(L, "linux"), /symlink/);
        assert.equal(fs.statSync(outsideFile).mode & 0o777, 0o644);
        assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside bytes");

        fs.unlinkSync(L.dbPath);
        const cacheLink = path.dirname(L.qmdModelCache);
        fs.rmSync(cacheLink, { recursive: true });
        const outsideDirectory = path.join(root, "outside-qmd");
        fs.mkdirSync(outsideDirectory, { mode: 0o755 });
        fs.symlinkSync(outsideDirectory, cacheLink, "dir");

        assert.equal(memoryStoragePrivate(L, "linux"), false);
        assert.throws(() => secureMemoryStorage(L, "linux"), /symlink/);
        assert.equal(fs.statSync(outsideDirectory).mode & 0o777, 0o755);
    });
});

test("an external shared QMD index parent fails closed without chmod", { skip: process.platform === "win32" }, () => {
    withFixture(({ home, L }) => {
        createStorageDirectories(L);
        const operatorDirectory = path.join(home, "operator-shared");
        fs.mkdirSync(operatorDirectory, { mode: 0o755 });
        const custom = { ...L, qmdIndexDb: path.join(operatorDirectory, "index.sqlite") };
        const shareMode = fs.statSync(L.share).mode & 0o7777;

        assert.equal(memoryStoragePrivate(custom, "linux"), false);
        assert.throws(() => secureMemoryStorage(custom, "linux"), /operator-owned directory/);
        assert.equal(fs.statSync(operatorDirectory).mode & 0o7777, 0o755);
        assert.equal(fs.statSync(L.share).mode & 0o7777, shareMode);
        assert.equal(fs.existsSync(custom.qmdIndexDb), false);
    });
});

test("Windows ACL repair applies one protected descriptor per path and verifies the current SID", () => {
    withFixture(({ L }) => {
        createStorageDirectories(L);
        const contents = writeStorageFiles(L);
        const { calls, mutations, runner } = windowsRunner();

        secureMemoryStorage(L, "win32", runner);

        assert.equal(memoryStoragePrivate(L, "win32", runner), true);
        const protectedDirectories = [L.share, L.configDir, path.dirname(L.qmdIndexConfig), path.dirname(L.qmdModelCache), L.qmdModelCache];
        const protectedFiles = [...contents.keys()];
        assert.equal(mutations.length, protectedDirectories.length + protectedFiles.length);
        assert.deepEqual(new Set(mutations.map(({ target }) => target)), new Set([...protectedDirectories, ...protectedFiles]));
        assert.equal(calls.some(({ command }) => command === "icacls"), false, "there must be no reset/grant fallback");
        for (const { target, script } of mutations) {
            assert.equal((script.match(/Set-Acl -LiteralPath \$path -AclObject \$security/g) ?? []).length, 1, `${target} must get one ACL mutation`);
            assert.match(script, /\.SetOwner\(\$identity\.User\)/);
            assert.match(script, /\.SetAccessRuleProtection\(\$true, \$false\)/);
            assert.match(script, /\.AddAccessRule\(\$rule\)/);
            assert.match(script, /FileSystemAccessRule\]::new\(\$identity\.User, \[Security\.AccessControl\.FileSystemRights\]::FullControl/);
            if (fs.lstatSync(target).isDirectory()) {
                assert.match(script, /DirectorySecurity/);
                assert.match(script, /InheritanceFlags\]::ObjectInherit -bor \[Security\.AccessControl\.InheritanceFlags\]::ContainerInherit/);
            } else {
                assert.match(script, /FileSecurity/);
                assert.match(script, /InheritanceFlags\]::None/);
            }
        }
        for (const [file, expected] of contents) assert.deepEqual(fs.readFileSync(file), expected, `${file} bytes must remain unchanged`);
    });
});

test("Windows ACL repair refuses a directory owned by another SID before any ACL mutation", () => {
    withFixture(({ L }) => {
        createStorageDirectories(L);
        const { calls, mutations, runner } = windowsRunner({ ownerSid: "S-1-5-21-9-9-9-9" });

        assert.throws(() => secureMemoryStorage(L, "win32", runner), /not owned by the current user/);
        assert.equal(mutations.length, 0);
        assert.equal(calls.some(({ command }) => command === "icacls"), false);
        assert.equal(memoryStoragePrivate(L, "win32", runner), false);
    });
});

test("Windows readiness accepts replaced choices files inheriting only the current user's effective full control", () => {
    withFixture(({ L }) => {
        createStorageDirectories(L);
        writeStorageFiles(L);
        const { runner, forgetSimulatedAcl, queriedAcls, setSimulatedAcl } = windowsRunner();

        secureMemoryStorage(L, "win32", runner);

        fs.unlinkSync(L.envPath);
        fs.writeFileSync(L.envPath, "new settings");
        forgetSimulatedAcl(L.envPath);
        const replacement = `${L.choicesPath}.replacement`;
        fs.writeFileSync(replacement, JSON.stringify({ selected: "new" }));
        fs.renameSync(replacement, L.choicesPath);
        forgetSimulatedAcl(L.choicesPath);

        assert.equal(memoryStoragePrivate(L, "win32", runner), true);
        for (const target of [L.envPath, L.choicesPath]) {
            const inheritedFileAcl = queriedAcls.get(target);
            assert.ok(inheritedFileAcl !== undefined);
            assert.equal(inheritedFileAcl.protected, false);
            assert.equal(inheritedFileAcl.aces.length, 1);
            assert.equal(inheritedFileAcl.aces[0].sid, WIN_USER_SID);
            assert.equal(inheritedFileAcl.aces[0].inherited, true);
            assert.equal(inheritedFileAcl.aces[0].allow, true);
            assert.equal(inheritedFileAcl.aces[0].fullControl, true);
            assert.equal(inheritedFileAcl.aces[0].inheritOnly, false);
        }
        const inherited = queriedAcls.get(L.choicesPath);
        assert.ok(inherited !== undefined);

        setSimulatedAcl(L.choicesPath, {
            ...inherited,
            aces: [{ ...inherited.aces[0], objectInherit: false, containerInherit: true, noPropagate: true }],
        });
        assert.equal(memoryStoragePrivate(L, "win32", runner), true, "file inheritance and propagation flags do not make its effective owner-only ACE unsafe");

        setSimulatedAcl(L.choicesPath, {
            ownerSid: WIN_USER_SID,
            userSid: WIN_USER_SID,
            protected: false,
            aces: [{ ...inherited.aces[0], sid: "S-1-5-21-9-9-9-9", inherited: true }],
        });
        assert.equal(memoryStoragePrivate(L, "win32", runner), false, "an inherited foreign principal must fail closed");

        setSimulatedAcl(L.choicesPath, {
            ownerSid: WIN_USER_SID,
            userSid: WIN_USER_SID,
            protected: false,
            aces: [inherited.aces[0], { ...inherited.aces[0], sid: "S-1-5-21-9-9-9-9", inherited: true }],
        });
        assert.equal(memoryStoragePrivate(L, "win32", runner), false, "additional inherited principals must fail closed");

        setSimulatedAcl(L.choicesPath, inherited);
        const privateConfigAcl = queriedAcls.get(L.configDir);
        assert.ok(privateConfigAcl !== undefined);
        setSimulatedAcl(L.configDir, { ...privateConfigAcl, protected: false });
        assert.equal(memoryStoragePrivate(L, "win32", runner), false, "directories must retain a protected DACL");
        setSimulatedAcl(L.configDir, {
            ...privateConfigAcl,
            aces: [{ ...privateConfigAcl.aces[0], inherited: true }],
        });
        assert.equal(memoryStoragePrivate(L, "win32", runner), false, "directory owner access must be explicit");
    });
});
