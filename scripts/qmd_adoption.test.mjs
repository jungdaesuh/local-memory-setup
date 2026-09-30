/**
 * Finding a QMD the user installed with `npm install -g @tobilu/qmd` (QMD's README), and
 * who owns it. Runs only in temporary trees with a fake PATH and a fake `npm`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { locateQmdPackage, qmdEntryIn, qmdInstalledBySetup } from "./detect.mjs";
import { layout } from "./layout.mjs";

const POSIX_ONLY = { skip: process.platform === "win32" && "npm links bin/qmd with a .cmd shim on Windows; npm root -g covers it there" };

/** @param {string} prefix */
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/**
 * A QMD package folder as npm lays it out.
 * @param {string} dir
 * @param {string} version
 */
function fakeQmdPackage(dir, version) {
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@tobilu/qmd", version, bin: { qmd: "bin/qmd" } }));
    fs.writeFileSync(path.join(dir, "bin", "qmd"), "#!/bin/sh\n", { mode: 0o755 });
    return dir;
}

/**
 * A bin folder whose `npm root -g` prints `root`.
 * @param {string} bin
 * @param {string} root
 */
function fakeNpm(bin, root) {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\n[ "$1 $2" = "root -g" ] && echo '${root}'\n`, { mode: 0o755 });
}

/**
 * Detection reads PATH from this process; restored after the test.
 * @param {import("node:test").TestContext} t
 * @param {string} value
 */
function withPath(t, value) {
    const saved = process.env.PATH;
    process.env.PATH = value;
    t.after(() => {
        process.env.PATH = saved;
    });
}

test("a QMD that npm linked onto PATH is found in its package folder, outside ~/.local", POSIX_ONLY, (t) => {
    const root = tempDir("lms-npmglobal-");
    const prefix = path.join(root, "homebrew");
    const pkg = fakeQmdPackage(path.join(prefix, "lib", "node_modules", "@tobilu", "qmd"), "2.8.3");
    fs.mkdirSync(path.join(prefix, "bin"));
    fs.symlinkSync(path.join("..", "lib", "node_modules", "@tobilu", "qmd", "bin", "qmd"), path.join(prefix, "bin", "qmd"));
    // An npm that knows nothing: the PATH link alone finds the package.
    fakeNpm(path.join(root, "npm-bin"), path.join(root, "nowhere"));
    withPath(t, `${path.join(prefix, "bin")}:${path.join(root, "npm-bin")}:/usr/bin:/bin`);
    const L = layout("linux", path.join(root, "home"), {});
    assert.equal(locateQmdPackage(L), pkg);
    assert.equal(qmdEntryIn(pkg), path.join(pkg, "bin", "qmd"));
});

test("with no qmd on PATH, npm's global folder is asked", POSIX_ONLY, (t) => {
    const root = tempDir("lms-npmroot-");
    const globalRoot = path.join(root, "prefix", "lib", "node_modules");
    const pkg = fakeQmdPackage(path.join(globalRoot, "@tobilu", "qmd"), "2.5.3");
    fakeNpm(path.join(root, "npm-bin"), globalRoot);
    withPath(t, `${path.join(root, "npm-bin")}:/usr/bin:/bin`);
    assert.equal(locateQmdPackage(layout("linux", path.join(root, "home"), {})), pkg);
});

test("the setup's own ~/.local QMD comes first, and a folder that is not QMD is not taken for one", POSIX_ONLY, (t) => {
    const root = tempDir("lms-ownqmd-");
    const L = layout("linux", path.join(root, "home"), {});
    const globalRoot = path.join(root, "prefix", "lib", "node_modules");
    fs.mkdirSync(path.join(globalRoot, "@tobilu", "qmd"), { recursive: true });
    fs.writeFileSync(path.join(globalRoot, "@tobilu", "qmd", "package.json"), JSON.stringify({ name: "something-else", version: "1.0.0" }));
    fakeNpm(path.join(root, "npm-bin"), globalRoot);
    withPath(t, `${path.join(root, "npm-bin")}:/usr/bin:/bin`);
    assert.equal(locateQmdPackage(L), null);
    fakeQmdPackage(L.qmdPackage, "2.5.3");
    assert.equal(locateQmdPackage(L), L.qmdPackage);
});

test("only a QMD in the setup's own prefix with its install stamp is the setup's, so only that one is ever rebuilt", () => {
    const L = { qmdPackage: "/h/.local/lib/node_modules/@tobilu/qmd" };
    const stamp = JSON.stringify({ version: "2.5.3", installedBy: "local-memory-setup" });
    const pkg = JSON.stringify({ name: "@tobilu/qmd", version: "2.5.3" });
    assert.equal(qmdInstalledBySetup(L.qmdPackage, L, stamp, pkg), true);
    // The same version in npm's global folder, with a stamp left from an earlier install: not the setup's.
    assert.equal(qmdInstalledBySetup("/opt/homebrew/lib/node_modules/@tobilu/qmd", L, stamp, pkg), false);
    assert.equal(qmdInstalledBySetup(L.qmdPackage, L, null, pkg), false);
    assert.equal(qmdInstalledBySetup(L.qmdPackage, L, stamp, JSON.stringify({ name: "@tobilu/qmd", version: "2.8.3" })), false);
    assert.equal(qmdInstalledBySetup(null, L, stamp, null), false);
});
