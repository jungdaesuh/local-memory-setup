import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    copyReviewedDependencyFiles,
    dependencyInstallPaths,
    installedDependencyFingerprint,
    npmCiInvocation,
    reviewedDependencyFingerprint,
    reviewedDependencyPaths,
} from "./dependency_install.mjs";

test("QMD and LongMemory have committed npm v3 lockfiles for their scoped graphs", () => {
    const qmdPaths = reviewedDependencyPaths("qmd");
    const qmdManifest = JSON.parse(fs.readFileSync(qmdPaths.packageJson, "utf8"));
    const qmdLock = JSON.parse(fs.readFileSync(qmdPaths.packageLock, "utf8"));
    assert.equal(qmdManifest.dependencies["@tobilu/qmd"], "2.8.3");
    assert.equal(qmdLock.lockfileVersion, 3);
    assert.deepEqual(qmdLock.packages[""].dependencies, qmdManifest.dependencies);
    assert.equal(qmdLock.packages["node_modules/@tobilu/qmd"].version, "2.8.3");

    const longmemoryPaths = reviewedDependencyPaths("longmemory");
    const longmemoryManifest = JSON.parse(fs.readFileSync(longmemoryPaths.packageJson, "utf8"));
    const longmemoryLock = JSON.parse(fs.readFileSync(longmemoryPaths.packageLock, "utf8"));
    assert.equal(longmemoryManifest.private, true);
    assert.equal(longmemoryLock.lockfileVersion, 3);
    assert.deepEqual(longmemoryLock.packages[""].dependencies, longmemoryManifest.dependencies);
    assert.deepEqual(longmemoryLock.packages[""].devDependencies, longmemoryManifest.devDependencies);
    assert.deepEqual(longmemoryManifest.scripts, {
        build: 'node -e "require(\'fs\').rmSync(\'dist\',{recursive:true,force:true})" && tsc -p tsconfig.json && node -e "const fs=require(\'fs\');fs.mkdirSync(\'dist/stores/sqlite\',{recursive:true});fs.copyFileSync(\'src/stores/sqlite/schema.sql\',\'dist/stores/sqlite/schema.sql\')"',
    });
    assert.deepEqual(longmemoryManifest.overrides, {
        "fast-uri": "3.1.8",
        "ip-address": "10.7.1",
        hono: "4.13.5",
        "@hono/node-server": "1.19.15",
        qs: "6.16.0",
        "@xmldom/xmldom": "0.8.15",
    });
    for (const [name, version] of Object.entries(longmemoryManifest.overrides)) {
        assert.equal(longmemoryLock.packages[`node_modules/${name}`].version, version, `${name} must resolve to its reviewed patched version`);
    }
});

test("copying a reviewed graph replaces only its npm project manifest and lockfile", () => {
    for (const component of /** @type {const} */ (["qmd", "longmemory"])) {
        const source = reviewedDependencyPaths(component);
        const target = fs.mkdtempSync(path.join(os.tmpdir(), `lms-${component}-deps-`));
        try {
            fs.writeFileSync(path.join(target, "package.json"), "old manifest\n");
            fs.writeFileSync(path.join(target, "package-lock.json"), "old lock\n");
            fs.writeFileSync(path.join(target, "source.ts"), "preserve source\n");
            const copiedFingerprint = copyReviewedDependencyFiles(component, target);
            assert.equal(fs.readFileSync(path.join(target, "package.json"), "utf8"), fs.readFileSync(source.packageJson, "utf8"));
            assert.equal(fs.readFileSync(path.join(target, "package-lock.json"), "utf8"), fs.readFileSync(source.packageLock, "utf8"));
            assert.equal(fs.readFileSync(path.join(target, "source.ts"), "utf8"), "preserve source\n");
            assert.match(copiedFingerprint, /^[0-9a-f]{64}$/);
            assert.equal(copiedFingerprint, reviewedDependencyFingerprint(component));
            assert.equal(installedDependencyFingerprint(component, target), copiedFingerprint);
        } finally {
            fs.rmSync(target, { recursive: true, force: true });
        }
    }
});

test("npm ci runs at the supplied project root with the selected Node first on PATH", () => {
    const node = path.join(os.tmpdir(), "setup-node", "bin", "node");
    const target = path.join(os.tmpdir(), "longmemory-build");
    const invocation = npmCiInvocation(target, node);
    assert.equal(invocation.command, "npm");
    assert.deepEqual(invocation.args, ["ci", "--no-audit", "--no-fund"]);
    assert.equal(invocation.cwd, target);
    assert.equal(invocation.env.PATH?.split(path.delimiter)[0], path.dirname(node));
    assert.equal(invocation.env.CI, "1");
});

test("QMD installs below its isolated project root and LongMemory occupies its build root", () => {
    const qmdRoot = path.join(os.tmpdir(), "setup-qmd");
    const longmemoryRoot = path.join(os.tmpdir(), "setup-longmemory");
    assert.deepEqual(dependencyInstallPaths("qmd", qmdRoot), {
        projectRoot: qmdRoot,
        packageRoot: path.join(qmdRoot, "node_modules", "@tobilu", "qmd"),
    });
    assert.deepEqual(dependencyInstallPaths("longmemory", longmemoryRoot), {
        projectRoot: longmemoryRoot,
        packageRoot: longmemoryRoot,
    });
});
